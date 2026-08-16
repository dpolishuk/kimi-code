import { describe, it, expect, vi } from 'vitest';
import { createEventDispatcher, type BotApi } from './events.js';
import type { Pairing, Store } from '../store.js';
import type { Logger } from './ws.js';

function createFakeStore(pairing: Pairing | null = null): Store {
  return {
    getPairingBySessionId: vi.fn(() => pairing),
    createPairingRequest: vi.fn(),
    getPendingPairingRequestByCode: vi.fn(),
    consumePairingCode: vi.fn(),
    activatePairingBySession: vi.fn(),
    getPairingByChatId: vi.fn(),
    deactivatePairing: vi.fn(),
    saveThreadMapping: vi.fn((m) => ({ ...m, id: 'mapping-1', createdAt: new Date() })),
    getThreadMappingByTelegramMessageId: vi.fn(),
    getThreadMappingByKimiMessageId: vi.fn(() => null),
    close: vi.fn(),
  };
}

function createFakeBotApi(): BotApi & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(() => Promise.resolve({ message_id: 1 })),
    editMessageText: vi.fn(() => Promise.resolve({})),
  };
}

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createActivePairing(sessionId: string): Pairing {
  return {
    id: 'pairing-1',
    sessionId,
    telegramChatId: 12345,
    telegramUserId: 67890,
    pairingCode: null,
    codeExpiresAt: null,
    pairedAt: new Date(),
    active: true,
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const APPROVAL_PAYLOAD = {
  approval_id: 'approval_123',
  session_id: 'session-1',
  tool_name: 'bash',
  action: 'rm -rf build/',
  tool_input_display: 'rm -rf build/',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:05:00Z',
};

describe('createEventDispatcher', () => {
  describe('turn.ended', () => {
    it('sends "Turn completed." when the reason is completed', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'turn.ended',
        payload: { turnId: 'turn-1', reason: 'completed' },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn completed.', undefined);
    });

    it('sends "Turn failed." when the reason is failed', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'turn.ended',
        payload: { turnId: 'turn-1', reason: 'failed' },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn failed.', undefined);
    });

    it('ignores cancelled and blocked turns', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'cancelled' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'blocked' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('task.terminated', () => {
    it('sends "Task completed." when the task completed', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'task.terminated',
        payload: { info: { status: 'completed' } },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Task completed.', undefined);
    });

    it('sends "Task failed." for non-completed statuses', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'task.terminated',
        payload: { info: { status: 'timed_out' } },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Task failed.', undefined);
    });

    it('ignores the legacy background.task.terminated alias (no double notification)', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      const payload = { info: { status: 'completed' } };
      dispatch({ type: 'task.terminated', payload, sessionId: 'session-1' });
      dispatch({ type: 'background.task.terminated', payload, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Task completed.', undefined);
    });
  });

  describe('goal.updated', () => {
    it('sends "Goal completed." when the snapshot status is complete', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'goal.updated',
        payload: { snapshot: { status: 'complete', objective: 'Ship it' } },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Goal completed.', undefined);
    });

    it('ignores goal.updated when the snapshot is null or not complete', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'goal.updated', payload: { snapshot: null }, sessionId: 'session-1' });
      dispatch({
        type: 'goal.updated',
        payload: { snapshot: { status: 'active', objective: 'Ship it' } },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('event.approval.requested', () => {
    it('sends a message with approve/always-allow/reject inline keyboard', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'event.approval.requested',
        payload: APPROVAL_PAYLOAD,
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(
        12345,
        'Approval requested: bash — rm -rf build/',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Approve', callback_data: 'apr:approval_123' },
                { text: 'Always allow', callback_data: 'aas:approval_123' },
                { text: 'Reject', callback_data: 'rej:approval_123' },
              ],
            ],
          },
        }
      );
    });

    it('truncates a very long action', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'event.approval.requested',
        payload: { ...APPROVAL_PAYLOAD, action: 'x'.repeat(1000) },
        sessionId: 'session-1',
      });

      await flushPromises();
      const text = botApi.sendMessage.mock.calls[0][1] as string;
      expect(text.length).toBeLessThanOrEqual(520);
      expect(text.endsWith('...')).toBe(true);
    });

    it('saves a thread mapping keyed by the approval id', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'event.approval.requested',
        payload: APPROVAL_PAYLOAD,
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(store.saveThreadMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          telegramChatId: 12345,
          telegramMessageId: 1,
          kimiMessageId: 'approval_123',
          direction: 'kimi_to_telegram',
        })
      );
    });

    it('ignores approval requests without an approval_id', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({
        type: 'event.approval.requested',
        payload: { tool_name: 'bash', action: 'ls' },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('event.approval.resolved', () => {
    function mappingForApproval() {
      return {
        id: 'mapping-1',
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 1,
        kimiMessageId: 'approval_123',
        direction: 'kimi_to_telegram' as const,
        createdAt: new Date(),
      };
    }

    function dispatchRequestAndResolve(
      store: Store,
      botApi: ReturnType<typeof createFakeBotApi>,
      decision: string
    ) {
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });
      dispatch({
        type: 'event.approval.requested',
        payload: APPROVAL_PAYLOAD,
        sessionId: 'session-1',
      });
      dispatch({
        type: 'event.approval.resolved',
        payload: { approval_id: 'approval_123', decision, resolved_at: '2026-01-01T00:00:01Z' },
        sessionId: 'session-1',
      });
      return dispatch;
    }

    it('edits the approval message with the decision when resolved elsewhere', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.getThreadMappingByKimiMessageId = vi.fn(() => mappingForApproval());
      const botApi = createFakeBotApi();
      dispatchRequestAndResolve(store, botApi, 'approved');

      await flushPromises();
      expect(store.getThreadMappingByKimiMessageId).toHaveBeenCalledWith(
        'session-1',
        12345,
        'approval_123'
      );
      expect(botApi.editMessageText).toHaveBeenCalledWith(
        12345,
        1,
        'Approval requested: bash — rm -rf build/\n\n✅ Approved'
      );
    });

    it('appends the rejected outcome per decision', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.getThreadMappingByKimiMessageId = vi.fn(() => mappingForApproval());
      const botApi = createFakeBotApi();
      dispatchRequestAndResolve(store, botApi, 'rejected');

      await flushPromises();
      expect(botApi.editMessageText).toHaveBeenCalledWith(
        12345,
        1,
        expect.stringContaining('❌ Rejected')
      );
    });

    it('appends the cancelled outcome per decision', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.getThreadMappingByKimiMessageId = vi.fn(() => mappingForApproval());
      const botApi = createFakeBotApi();
      dispatchRequestAndResolve(store, botApi, 'cancelled');

      await flushPromises();
      expect(botApi.editMessageText).toHaveBeenCalledWith(
        12345,
        1,
        expect.stringContaining('⚪ Cancelled')
      );
    });

    it('does nothing when there is no mapping for the approval', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      dispatchRequestAndResolve(store, botApi, 'approved');

      await flushPromises();
      expect(botApi.editMessageText).not.toHaveBeenCalled();
    });

    it('does nothing when the BotApi has no editMessageText', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.getThreadMappingByKimiMessageId = vi.fn(() => mappingForApproval());
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const botApi: BotApi = {
        sendMessage: vi.fn(() => Promise.resolve({ message_id: 1 })),
      };
      const dispatch = createEventDispatcher(store, botApi, { logger });

      dispatch({
        type: 'event.approval.resolved',
        payload: { approval_id: 'approval_123', decision: 'approved' },
        sessionId: 'session-1',
      });

      await flushPromises();
      // No throw, no edit attempted, nothing logged as an error.
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('assistant.delta accumulation', () => {
    it('sends the accumulated assistant text when the turn completes', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: 'Hello ' }, sessionId: 'session-1' });
      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: '**world**' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-1', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(
        12345,
        'Hello *world*',
        { parse_mode: 'MarkdownV2' }
      );
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn completed.', undefined);
    });

    it('does not stream partial deltas before the turn ends', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: 'partial' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('clears the buffer without sending when the turn fails', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: 'lost work' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-1', reason: 'failed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn failed.', undefined);
    });

    it('clears the buffer without sending when the turn is cancelled', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: 'lost work' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-1', reason: 'cancelled' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps buffers of different turns independent', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1', delta: 'one' }, sessionId: 'session-1' });
      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-2', delta: 'two' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-1', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'one', { parse_mode: 'MarkdownV2' });

      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-2', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'two', { parse_mode: 'MarkdownV2' });
    });

    it('evicts the oldest turns when the buffer exceeds the cap', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { turnId: 'old-turn', delta: 'o'.repeat(90 * 1024) }, sessionId: 'session-1' });
      dispatch({ type: 'assistant.delta', payload: { turnId: 'new-turn', delta: 'n'.repeat(90 * 1024) }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'old-turn', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      // old-turn's buffer was evicted; only the milestone notification is sent.
      expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn completed.', undefined);

      dispatch({ type: 'turn.ended', payload: { turnId: 'new-turn', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      const calls = botApi.sendMessage.mock.calls.map((call) => call[1] as string);
      expect(calls.some((text) => text.startsWith('nnn'))).toBe(true);
    });

    it('ignores deltas without a turnId or delta string', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'assistant.delta', payload: { delta: 'orphan' }, sessionId: 'session-1' });
      dispatch({ type: 'assistant.delta', payload: { turnId: 'turn-1' }, sessionId: 'session-1' });
      dispatch({ type: 'turn.ended', payload: { turnId: 'turn-1', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn completed.', undefined);
    });
  });

  describe('filtering and errors', () => {
    it('ignores unknown event types', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'session.updated', payload: {}, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores events for unpaired sessions', async () => {
      const store = createFakeStore(null);
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores events for inactive pairings', async () => {
      const pairing = createActivePairing('session-1');
      pairing.active = false;
      const store = createFakeStore(pairing);
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores events when telegramChatId is null', async () => {
      const pairing = createActivePairing('session-1');
      pairing.telegramChatId = null;
      const store = createFakeStore(pairing);
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores events without a sessionId', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' } });

      await flushPromises();
      expect(botApi.sendMessage).not.toHaveBeenCalled();
    });

    it('logs when sendMessage rejects', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      botApi.sendMessage = vi.fn(() => Promise.reject(new Error('telegram down')));
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dispatch = createEventDispatcher(store, botApi, { logger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          chatId: 12345,
          error: expect.any(Error),
        }),
        'Failed to send Telegram notification'
      );
    });

    it('logs when sendMessage throws synchronously', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      const botApi = createFakeBotApi();
      botApi.sendMessage = vi.fn(() => {
        throw new Error('sync boom');
      });
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dispatch = createEventDispatcher(store, botApi, { logger });

      dispatch({ type: 'turn.ended', payload: { turnId: 't', reason: 'completed' }, sessionId: 'session-1' });

      await flushPromises();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          chatId: 12345,
          error: expect.any(Error),
        }),
        'Failed to send Telegram notification'
      );
    });

    it('logs when saving the approval thread mapping fails', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.saveThreadMapping = vi.fn(() => {
        throw new Error('db locked');
      });
      const botApi = createFakeBotApi();
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dispatch = createEventDispatcher(store, botApi, { logger });

      dispatch({
        type: 'event.approval.requested',
        payload: APPROVAL_PAYLOAD,
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          chatId: 12345,
          error: expect.any(Error),
        }),
        'Failed to save outgoing thread mapping'
      );
    });

    it('logs when editMessageText rejects', async () => {
      const store = createFakeStore(createActivePairing('session-1'));
      store.getThreadMappingByKimiMessageId = vi.fn(() => ({
        id: 'mapping-1',
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 1,
        kimiMessageId: 'approval_123',
        direction: 'kimi_to_telegram',
        createdAt: new Date(),
      }));
      const botApi = createFakeBotApi();
      botApi.editMessageText = vi.fn(() => Promise.reject(new Error('edit failed')));
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dispatch = createEventDispatcher(store, botApi, { logger });

      dispatch({
        type: 'event.approval.resolved',
        payload: { approval_id: 'approval_123', decision: 'approved' },
        sessionId: 'session-1',
      });

      await flushPromises();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          chatId: 12345,
          error: expect.any(Error),
        }),
        'Failed to edit Telegram message'
      );
    });
  });
});
