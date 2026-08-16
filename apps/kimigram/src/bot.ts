import { Bot, type Context } from 'grammy';
import type { PairingService } from './pairing.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type {
  ApprovalDecision,
  KimiClient,
  ResolveApprovalResult,
} from './kimi/client.js';
import { KimiClientError } from './kimi/client.js';
import type { Logger } from './kimi/ws.js';

/**
 * Telegram bot factory and command handlers.
 *
 * Exposes a `/start <code>` command that consumes a one-time pairing code and
 * links the Telegram chat to a kimi-code session, a text-message handler that
 * forwards paired chat messages to kimi-code as user prompts, and a callback
 * handler that resolves kimi-code approval requests from inline keyboards.
 */

export function createStartHandler(
  pairingService: PairingService,
  store: Store,
  onPaired?: (sessionId: string) => void
) {
  return async (ctx: Context): Promise<void> => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please pair in a private chat with the bot.');
      return;
    }

    const code = String(ctx.match ?? '').trim();

    if (!code) {
      await ctx.reply(
        'Generate a pairing code for your kimi-code session (`pnpm --filter kimigram run pair -- <session-id>`), ' +
          'then send it here as:\n' +
          '`/start <code>`'
      );
      return;
    }

    const request = pairingService.validatePairingCode(code);
    if (!request) {
      await ctx.reply('Invalid or expired code. Generate a new one from your kimi-code session.');
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? null;

    try {
      store.activatePairingBySession(request.sessionId, chatId, userId);
      await ctx.reply(`Paired with session \`${request.sessionId}\`. You can now send messages here.`);
      onPaired?.(request.sessionId);
    } catch {
      await ctx.reply('Failed to activate pairing. Please try again or generate a new code.');
    }
  };
}

const SETUP_INSTRUCTIONS =
  'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.';

const DEFAULT_UPDATE_ID_WINDOW = 200;

/**
 * Creates a grammY middleware that drops duplicate Telegram updates based on
 * `update_id`. Keeps a bounded in-memory window of the most recent IDs.
 *
 * Note: deduplication is in-memory only; duplicates may be re-processed after
 * a process restart. This is acceptable for the current sidecar model.
 */
export function createUpdateIdDedupMiddleware(windowSize = DEFAULT_UPDATE_ID_WINDOW) {
  const seen = new Set<number>();
  const order: number[] = [];

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const id = ctx.update.update_id;
    if (typeof id !== 'number') {
      await next();
      return;
    }

    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    order.push(id);
    if (order.length > windowSize) {
      const oldest = order.shift();
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }

    await next();
  };
}

export interface MessageHandlerOptions {
  logger?: Logger;
}

export function createMessageHandler(
  store: Store,
  kimiClient: KimiClient,
  options: MessageHandlerOptions = {}
) {
  const logger = options.logger ?? console;

  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const pairing = store.getPairingByChatId(chatId);
    if (!pairing?.active) {
      await ctx.reply(SETUP_INSTRUCTIONS);
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) {
      await ctx.reply('Please send a non-empty message.');
      return;
    }

    try {
      await kimiClient.submitPrompt(pairing.sessionId, text);
    } catch (error) {
      const code =
        error instanceof KimiClientError && error.code > 0 ? error.code : undefined;
      logger.error({ error, chatId, sessionId: pairing.sessionId }, 'Failed to submit prompt');
      await ctx.reply(
        `Failed to send prompt${code ? ` (${code})` : ''}. Please try again.`
      );
      return;
    }

    await ctx.reply('Prompt sent.');
  };
}

const APPROVAL_CALLBACK_PATTERN = /^(apr|aas|rej):(.+)$/;
const MAX_TOAST_LENGTH = 180;

function truncateToast(text: string): string {
  if (text.length <= MAX_TOAST_LENGTH) return text;
  return text.slice(0, MAX_TOAST_LENGTH) + '...';
}

interface ApprovalOutcome {
  toast: string;
  line: string;
}

function approvalOutcome(
  action: 'apr' | 'aas' | 'rej',
  result: ResolveApprovalResult
): ApprovalOutcome {
  if (result.kind === 'already_resolved') {
    return { toast: 'Already resolved', line: '⚠️ Already resolved' };
  }
  if (result.kind === 'not_found') {
    return { toast: 'Approval no longer pending', line: '⚠️ Approval no longer pending' };
  }
  switch (action) {
    case 'apr':
      return { toast: 'Approved', line: '✅ Approved' };
    case 'aas':
      return { toast: 'Always allowed for this session', line: '✅ Always allowed (session)' };
    case 'rej':
      return { toast: 'Rejected', line: '❌ Rejected' };
  }
}

/**
 * Creates a handler for inline-keyboard callback queries that resolve
 * kimi-code approval requests. Callback data is `<action>:<approval_id>` with
 * action `apr` (approve), `aas` (always allow for the session), or `rej`
 * (reject). Only callbacks from chats with an active pairing are acted on.
 */
export function createApprovalCallbackHandler(
  store: Store,
  kimiClient: KimiClient,
  options: MessageHandlerOptions = {}
) {
  const logger = options.logger ?? console;

  return async (ctx: Context): Promise<void> => {
    const query = ctx.callbackQuery;
    const data = query && 'data' in query ? query.data : undefined;
    if (!data) return;

    const match = APPROVAL_CALLBACK_PATTERN.exec(data);
    if (!match) return;

    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const pairing = store.getPairingByChatId(chatId);
    if (!pairing?.active) return;

    const action = match[1] as 'apr' | 'aas' | 'rej';
    const approvalId = match[2];
    const decision: ApprovalDecision = action === 'rej' ? 'rejected' : 'approved';
    const scope = action === 'aas' ? ('session' as const) : undefined;

    let result: ResolveApprovalResult;
    try {
      result = await kimiClient.resolveApproval(
        pairing.sessionId,
        approvalId,
        decision,
        scope
      );
    } catch (error) {
      logger.error(
        { error, chatId, sessionId: pairing.sessionId, approvalId },
        'Failed to resolve approval'
      );
      const reason = error instanceof KimiClientError && error.msg ? error.msg : 'request failed';
      await ctx.answerCallbackQuery({ text: truncateToast(`Failed: ${reason}`) });
      return;
    }

    const outcome = approvalOutcome(action, result);
    await ctx.answerCallbackQuery({ text: outcome.toast });

    const message = query?.message;
    const originalText = message && 'text' in message ? message.text : undefined;
    if (message && originalText !== undefined) {
      try {
        await ctx.api.editMessageText(chatId, message.message_id, `${originalText}\n\n${outcome.line}`, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        logger.error(
          { error, chatId, sessionId: pairing.sessionId, approvalId },
          'Failed to edit approval message'
        );
      }
    }
  };
}

export function createBot(
  config: Config,
  pairingService: PairingService,
  store: Store,
  kimiClient: KimiClient,
  logger?: Logger,
  onPaired?: (sessionId: string) => void
): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.use(createUpdateIdDedupMiddleware());
  bot.command('start', createStartHandler(pairingService, store, onPaired));
  bot.on('message:text', createMessageHandler(store, kimiClient, { logger }));
  bot.on('callback_query:data', createApprovalCallbackHandler(store, kimiClient, { logger }));
  return bot;
}
