import type { KimiEvent, Logger } from './ws.js';
import type { Store } from '../store.js';
import { convertToTelegramMarkdown } from '../formatting/telegramMarkdown.js';

export interface SendMessageOptions {
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

/**
 * Minimal Telegram API surface used by the event dispatcher.
 * This keeps the dispatcher decoupled from the full grammY Bot type.
 * `editMessageText` is optional; consumers without it simply skip edits.
 */
export interface SentMessage {
  message_id: number;
}

export interface BotApi {
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<SentMessage>;
  editMessageText?(chatId: number, messageId: number, text: string): Promise<unknown>;
}

export interface EventDispatcherOptions {
  logger?: Logger;
}

const MAX_ACTION_LENGTH = 500;
const MAX_DELTA_BUFFER_BYTES = 100 * 1024;
const MAX_REMEMBERED_APPROVALS = 200;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Creates a handler for kimi-code WebSocket events that sends Telegram
 * notifications to the chat paired with the event's session.
 *
 * Handled events:
 * - `turn.ended` — milestone notification; on `completed` the accumulated
 *   `assistant.delta` text for the turn is sent first (MarkdownV2 when safe).
 * - `task.terminated` — completion/failure notification. The legacy alias
 *   `background.task.terminated` is explicitly ignored to avoid duplicates.
 * - `goal.updated` — notified when the goal snapshot status is `complete`.
 * - `event.approval.requested` — approval prompt with an inline keyboard
 *   (Approve / Always allow / Reject).
 * - `event.approval.resolved` — edits the approval message with the outcome
 *   when the approval was resolved elsewhere.
 *
 * Events without a `sessionId`, or for unpaired/inactive sessions, are
 * ignored.
 */
export function createEventDispatcher(
  store: Store,
  botApi: BotApi,
  options: EventDispatcherOptions = {}
): (event: KimiEvent) => void {
  const logger = options.logger ?? console;

  // Accumulated assistant text per `${sessionId}:${turnId}`, oldest first.
  const turnBuffers = new Map<string, string>();
  let bufferedBytes = 0;

  // Rendered approval prompt text per approval id, so a resolution that
  // arrives from elsewhere can edit the original message with full context.
  const approvalTexts = new Map<string, string>();

  function dropTurnBuffer(key: string) {
    const buffered = turnBuffers.get(key);
    if (buffered !== undefined) {
      bufferedBytes -= buffered.length;
      turnBuffers.delete(key);
    }
  }

  function bufferDelta(sessionId: string, turnId: string, delta: string) {
    const key = `${sessionId}:${turnId}`;
    while (
      bufferedBytes + delta.length > MAX_DELTA_BUFFER_BYTES &&
      turnBuffers.size > 0
    ) {
      const oldest = turnBuffers.keys().next().value;
      if (oldest === undefined) break;
      if (oldest === key) break;
      dropTurnBuffer(oldest);
    }
    const existing = turnBuffers.get(key) ?? '';
    const next = existing + delta;
    const overflow = bufferedBytes + delta.length - MAX_DELTA_BUFFER_BYTES;
    const trimmed = overflow > 0 ? next.slice(overflow) : next;
    bufferedBytes += trimmed.length - existing.length;
    turnBuffers.set(key, trimmed);
  }

  function rememberApprovalText(approvalId: string, text: string) {
    if (approvalTexts.size >= MAX_REMEMBERED_APPROVALS) {
      const oldest = approvalTexts.keys().next().value;
      if (oldest !== undefined) approvalTexts.delete(oldest);
    }
    approvalTexts.set(approvalId, text);
  }

  function send(sessionId: string, chatId: number, text: string, options?: SendMessageOptions) {
    Promise.resolve()
      .then(() => botApi.sendMessage(chatId, text, options))
      .catch((error) => {
        logger.error(
          { error, sessionId, chatId },
          'Failed to send Telegram notification'
        );
      });
  }

  function handleTurnEnded(sessionId: string, chatId: number, payload: unknown) {
    const { turnId, reason } = (payload ?? {}) as { turnId?: unknown; reason?: unknown };

    if (typeof turnId === 'string') {
      const key = `${sessionId}:${turnId}`;
      const buffered = turnBuffers.get(key);
      dropTurnBuffer(key);
      if (reason === 'completed' && buffered && buffered.trim().length > 0) {
        const rendered = convertToTelegramMarkdown(buffered);
        send(
          sessionId,
          chatId,
          rendered.text,
          rendered.parseMode ? { parse_mode: rendered.parseMode } : undefined
        );
      }
    }

    if (reason === 'completed') {
      send(sessionId, chatId, 'Turn completed.');
    } else if (reason === 'failed') {
      send(sessionId, chatId, 'Turn failed.');
    }
  }

  function handleTaskTerminated(sessionId: string, chatId: number, payload: unknown) {
    const status = ((payload ?? {}) as { info?: { status?: unknown } }).info?.status;
    if (status === 'completed') {
      send(sessionId, chatId, 'Task completed.');
    } else if (typeof status === 'string') {
      send(sessionId, chatId, 'Task failed.');
    }
  }

  function handleGoalUpdated(sessionId: string, chatId: number, payload: unknown) {
    const status = ((payload ?? {}) as { snapshot?: { status?: unknown } | null })
      .snapshot?.status;
    if (status === 'complete') {
      send(sessionId, chatId, 'Goal completed.');
    }
  }

  function handleApprovalRequested(sessionId: string, chatId: number, payload: unknown) {
    const data = (payload ?? {}) as {
      approval_id?: unknown;
      tool_name?: unknown;
      action?: unknown;
    };
    if (typeof data.approval_id !== 'string') return;
    const approvalId = data.approval_id;

    const toolName = typeof data.tool_name === 'string' ? data.tool_name : 'unknown tool';
    const action = typeof data.action === 'string' ? data.action : '';
    const prefix = `Approval requested: ${toolName} — `;
    const text = prefix + truncate(action, Math.max(0, MAX_ACTION_LENGTH - prefix.length));

    // Remember the rendered text synchronously so a resolution arriving
    // immediately after the request can still edit the full message.
    rememberApprovalText(approvalId, text);

    Promise.resolve()
      .then(() =>
        botApi.sendMessage(chatId, text, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Approve', callback_data: `apr:${approvalId}` },
                { text: 'Always allow', callback_data: `aas:${approvalId}` },
                { text: 'Reject', callback_data: `rej:${approvalId}` },
              ],
            ],
          },
        })
      )
      .then((sent) => {
        try {
          store.saveThreadMapping({
            sessionId,
            telegramChatId: chatId,
            telegramMessageId: sent.message_id,
            kimiMessageId: approvalId,
            direction: 'kimi_to_telegram',
          });
        } catch (error) {
          logger.error(
            { error, sessionId, chatId, messageId: sent.message_id },
            'Failed to save outgoing thread mapping'
          );
        }
      })
      .catch((error) => {
        logger.error(
          { error, sessionId, chatId },
          'Failed to send Telegram notification'
        );
      });
  }

  function handleApprovalResolved(sessionId: string, chatId: number, payload: unknown) {
    const data = (payload ?? {}) as { approval_id?: unknown; decision?: unknown };
    if (typeof data.approval_id !== 'string') return;

    const outcome =
      data.decision === 'approved'
        ? '✅ Approved'
        : data.decision === 'rejected'
          ? '❌ Rejected'
          : data.decision === 'cancelled'
            ? '⚪ Cancelled'
            : undefined;
    if (!outcome) return;

    const mapping = store.getThreadMappingByKimiMessageId(
      sessionId,
      chatId,
      data.approval_id
    );
    if (!mapping) return;
    if (!botApi.editMessageText) return;

    const original = approvalTexts.get(data.approval_id);
    approvalTexts.delete(data.approval_id);
    const text = original ? `${original}\n\n${outcome}` : outcome;

    Promise.resolve()
      .then(() => botApi.editMessageText?.(chatId, mapping.telegramMessageId, text))
      .catch((error) => {
        logger.error(
          { error, sessionId, chatId },
          'Failed to edit Telegram message'
        );
      });
  }

  return (event) => {
    if (event.type === 'assistant.delta') {
      const sessionId = event.sessionId;
      const data = (event.payload ?? {}) as { turnId?: unknown; delta?: unknown };
      if (
        typeof sessionId === 'string' &&
        typeof data.turnId === 'string' &&
        typeof data.delta === 'string'
      ) {
        bufferDelta(sessionId, data.turnId, data.delta);
      }
      return;
    }

    const sessionId = event.sessionId;

    if (!sessionId) {
      logger.warn({ eventType: event.type }, 'Ignoring kimi-code event without sessionId');
      return;
    }

    const pairing = store.getPairingBySessionId(sessionId);
    if (!pairing?.active || pairing.telegramChatId === null) {
      return;
    }

    const chatId = pairing.telegramChatId;

    switch (event.type) {
      case 'turn.ended':
        handleTurnEnded(sessionId, chatId, event.payload);
        return;
      case 'task.terminated':
        handleTaskTerminated(sessionId, chatId, event.payload);
        return;
      case 'background.task.terminated':
        // Legacy alias emitted alongside task.terminated; explicitly ignored
        // to avoid double notifications.
        return;
      case 'goal.updated':
        handleGoalUpdated(sessionId, chatId, event.payload);
        return;
      case 'event.approval.requested':
        handleApprovalRequested(sessionId, chatId, event.payload);
        return;
      case 'event.approval.resolved':
        handleApprovalResolved(sessionId, chatId, event.payload);
        return;
      default:
        return;
    }
  };
}
