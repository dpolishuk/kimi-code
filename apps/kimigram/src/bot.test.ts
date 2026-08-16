import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, type Context } from 'grammy';
import { openStore, type Store } from './store.js';
import { createPairingService, type PairingService } from './pairing.js';
import {
  createStartHandler,
  createBot,
  createMessageHandler,
  createApprovalCallbackHandler,
  createUpdateIdDedupMiddleware,
} from './bot.js';
import type { Config } from './config.js';
import type { KimiClient } from './kimi/client.js';
import { KimiClientError } from './kimi/client.js';
import type { Logger } from './kimi/ws.js';

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const TEST_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as const;

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'test-token',
    databasePath: ':memory:',
    pairingCodeTtlMinutes: 10,
    logLevel: 'info',
    kimiServerUrl: 'http://localhost:58627',
    kimiBearerToken: 'kimi-token',
    kimiTokenFile: '~/.kimi-code/server.token',
    ...overrides,
  };
}

function createMockKimiClient(
  overrides: Partial<KimiClient> = {}
): KimiClient {
  return {
    submitPrompt: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    resolveApproval: vi.fn().mockResolvedValue({ kind: 'resolved' }),
    ...overrides,
  };
}

async function dispatchStart(
  pairingService: PairingService,
  store: Store,
  text: string,
  overrides: {
    chatType?: 'private' | 'group';
    chatId?: number;
    userId?: number;
    onPaired?: (sessionId: string) => void;
  } = {}
): Promise<{ replies: string[] }> {
  const bot = new Bot('dummy-token');
  bot.botInfo = { ...TEST_BOT_INFO };
  bot.command('start', createStartHandler(pairingService, store, overrides.onPaired));

  const replies: string[] = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === 'sendMessage') {
      replies.push((payload as { text?: string }).text ?? '');
      return Promise.resolve({
        ok: true,
        result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
      });
    }
    return prev(method, payload);
  });

  const spaceIndex = text.indexOf(' ');
  const commandLength = spaceIndex === -1 ? text.length : spaceIndex;

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text,
      chat: { id: overrides.chatId ?? 12345, type: overrides.chatType ?? 'private' },
      from: { id: overrides.userId ?? 67890, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
    },
  });

  return { replies };
}

async function dispatchMessage(
  store: Store,
  kimiClient: KimiClient,
  text: string,
  overrides: {
    chatType?: 'private' | 'group';
    chatId?: number;
    userId?: number;
    noChat?: boolean;
    messageId?: number;
    logger?: Logger;
  } = {}
): Promise<{ replies: string[] }> {
  const bot = new Bot('dummy-token');
  bot.botInfo = { ...TEST_BOT_INFO };
  bot.on('message:text', createMessageHandler(store, kimiClient, { logger: overrides.logger ?? silentLogger }));

  const replies: string[] = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === 'sendMessage') {
      replies.push((payload as { text?: string }).text ?? '');
      return Promise.resolve({
        ok: true,
        result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
      });
    }
    return prev(method, payload);
  });

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: overrides.messageId ?? 1,
      text,
      chat: overrides.noChat
        ? undefined
        : { id: overrides.chatId ?? 12345, type: overrides.chatType ?? 'private' },
      from: { id: overrides.userId ?? 67890, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
    },
  });

  return { replies };
}

interface CallbackResult {
  toasts: Array<Record<string, unknown>>;
  edits: Array<Record<string, unknown>>;
}

async function dispatchCallbackQuery(
  store: Store,
  kimiClient: KimiClient,
  data: string,
  overrides: {
    chatId?: number;
    messageId?: number;
    messageText?: string;
    logger?: Logger;
  } = {}
): Promise<CallbackResult> {
  const bot = new Bot('dummy-token');
  bot.botInfo = { ...TEST_BOT_INFO };
  bot.on(
    'callback_query:data',
    createApprovalCallbackHandler(store, kimiClient, { logger: overrides.logger ?? silentLogger })
  );

  const result: CallbackResult = { toasts: [], edits: [] };
  bot.api.config.use((prev, method, payload) => {
    if (method === 'answerCallbackQuery') {
      result.toasts.push(payload as Record<string, unknown>);
      return Promise.resolve({ ok: true, result: true });
    }
    if (method === 'editMessageText') {
      result.edits.push(payload as Record<string, unknown>);
      return Promise.resolve({ ok: true, result: true });
    }
    return prev(method, payload);
  });

  await bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: 67890, is_bot: false, first_name: 'Test' },
      chat_instance: 'ci-1',
      message: {
        message_id: overrides.messageId ?? 50,
        chat: { id: overrides.chatId ?? 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: overrides.messageText ?? 'Approval requested: bash — rm -rf build/',
      },
      data,
    },
  });

  return result;
}

function activatePairing(store: Store, pairingService: PairingService, sessionId: string, chatId = 12345) {
  const code = pairingService.generatePairingCode(sessionId);
  const request = pairingService.validatePairingCode(code);
  if (!request) throw new Error('failed to validate pairing code');
  store.activatePairingBySession(sessionId, chatId, 67890);
}

describe('createStartHandler', () => {
  let dbPath: string;
  let store: Store;
  let pairingService: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    pairingService = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('start with valid code replies success, activates pairing and consumes the code', async () => {
    const code = pairingService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(pairingService, store, `/start ${code}`);

    expect(replies[0]).toBe(
      `Paired with session \`session-1\`. You can now send messages here.`
    );
    const pairing = store.getPairingByChatId(12345);
    expect(pairing?.sessionId).toBe('session-1');
    expect(pairing?.active).toBe(true);

    const retry = await dispatchStart(pairingService, store, `/start ${code}`);
    expect(retry.replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
  });

  it('calls onPaired with the session id after successful activation', async () => {
    const onPaired = vi.fn();
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`, { onPaired });

    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onPaired).toHaveBeenCalledWith('session-1');
  });

  it('does not call onPaired when activation fails', async () => {
    const onPaired = vi.fn();
    const throwingStore: Store = {
      ...store,
      activatePairingBySession: () => {
        throw new Error('activation failed');
      },
    };
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, throwingStore, `/start ${code}`, { onPaired });

    expect(onPaired).not.toHaveBeenCalled();
  });

  it('does not call onPaired for invalid codes', async () => {
    const onPaired = vi.fn();
    await dispatchStart(pairingService, store, '/start BADCODE', { onPaired });

    expect(onPaired).not.toHaveBeenCalled();
  });

  it('start with expired code replies invalid and leaves the store unchanged', async () => {
    const expiredService = createPairingService(store, { ttlMinutes: 0 });
    const code = expiredService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(expiredService, store, `/start ${code}`);

    expect(replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
    expect(store.getPairingByChatId(12345)).toBeNull();
    expect(expiredService.validatePairingCode(code)).toBeNull();
  });

  it('start without code replies setup instructions', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start');

    expect(replies[0]).toBe(
      'Generate a pairing code for your kimi-code session (`pnpm --filter kimigram run pair -- <session-id>`), ' +
        'then send it here as:\n' +
        '`/start <code>`'
    );
  });

  it('start with invalid code replies invalid and leaves the store unchanged', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start BADCODE');

    expect(replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
    expect(store.getPairingByChatId(12345)).toBeNull();
    expect(pairingService.validatePairingCode('BADCODE')).toBeNull();
  });

  it('start with only whitespace replies setup instructions', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start   ');

    expect(replies[0]).toBe(
      'Generate a pairing code for your kimi-code session (`pnpm --filter kimigram run pair -- <session-id>`), ' +
        'then send it here as:\n' +
        '`/start <code>`'
    );
  });

  it('rejects non-private chats and does not activate a pairing', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start ABC123', {
      chatType: 'group',
    });

    expect(replies[0]).toBe('Please pair in a private chat with the bot.');
    expect(store.getPairingByChatId(12345)).toBeNull();
  });

  it('handles activation failure gracefully and consumes the code', async () => {
    const throwingStore: Store = {
      ...store,
      activatePairingBySession: () => {
        throw new Error('activation failed');
      },
    };
    const code = pairingService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(
      pairingService,
      throwingStore,
      `/start ${code}`
    );

    expect(replies[0]).toBe(
      'Failed to activate pairing. Please try again or generate a new code.'
    );
    expect(pairingService.validatePairingCode(code)).toBeNull();
  });
});

describe('createMessageHandler', () => {
  let dbPath: string;
  let store: Store;
  let pairingService: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    pairingService = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards text messages from paired chats', async () => {
    activatePairing(store, pairingService, 'session-1');

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello from Telegram'
    );

    expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
      'session-1',
      'Hello from Telegram'
    );
    expect(replies[0]).toBe('Prompt sent.');
  });

  it('rejects messages from unpaired chats', async () => {
    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello from Telegram'
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe(
      'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.'
    );
  });

  it('ignores empty text messages', async () => {
    activatePairing(store, pairingService, 'session-1');

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      '   '
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe('Please send a non-empty message.');
  });

  it('surfaces client errors with the envelope code', async () => {
    activatePairing(store, pairingService, 'session-1');

    const kimiClient = createMockKimiClient({
      submitPrompt: vi.fn().mockRejectedValue(
        new KimiClientError('kimi-code API error 40401: session not found', 40401, 'session not found')
      ),
    });
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello'
    );

    expect(replies[0]).toBe('Failed to send prompt (40401). Please try again.');
  });

  it('does not forward messages when pairing is inactive', async () => {
    activatePairing(store, pairingService, 'session-1');
    store.deactivatePairing(12345);

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello after deactivate'
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe(
      'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.'
    );
  });

  it('surfaces non-client errors without a code', async () => {
    activatePairing(store, pairingService, 'session-1');

    const kimiClient = createMockKimiClient({
      submitPrompt: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello'
    );

    expect(replies[0]).toBe('Failed to send prompt. Please try again.');
  });

  it('does nothing when chat id is missing', async () => {
    activatePairing(store, pairingService, 'session-1');

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello',
      { noChat: true }
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });
});

describe('createApprovalCallbackHandler', () => {
  let dbPath: string;
  let store: Store;
  let pairingService: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    pairingService = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('approves on apr callbacks, toasts, and edits the message', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient();

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(kimiClient.resolveApproval).toHaveBeenCalledWith(
      'session-1',
      'approval_123',
      'approved',
      undefined
    );
    expect(toasts[0]).toMatchObject({ text: 'Approved' });
    expect(edits[0]).toMatchObject({
      chat_id: 12345,
      message_id: 50,
      text: 'Approval requested: bash — rm -rf build/\n\n✅ Approved',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('always-allows with session scope on aas callbacks', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient();

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'aas:approval_123');

    expect(kimiClient.resolveApproval).toHaveBeenCalledWith(
      'session-1',
      'approval_123',
      'approved',
      'session'
    );
    expect(toasts[0]).toMatchObject({ text: 'Always allowed for this session' });
    expect(edits[0]).toMatchObject({
      text: 'Approval requested: bash — rm -rf build/\n\n✅ Always allowed (session)',
    });
  });

  it('rejects on rej callbacks', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient();

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'rej:approval_123');

    expect(kimiClient.resolveApproval).toHaveBeenCalledWith(
      'session-1',
      'approval_123',
      'rejected',
      undefined
    );
    expect(toasts[0]).toMatchObject({ text: 'Rejected' });
    expect(edits[0]).toMatchObject({
      text: 'Approval requested: bash — rm -rf build/\n\n❌ Rejected',
    });
  });

  it('reports already-resolved approvals', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient({
      resolveApproval: vi.fn().mockResolvedValue({ kind: 'already_resolved' }),
    });

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(toasts[0]).toMatchObject({ text: 'Already resolved' });
    expect(edits[0]).toMatchObject({
      text: 'Approval requested: bash — rm -rf build/\n\n⚠️ Already resolved',
    });
  });

  it('reports approvals that are no longer pending', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient({
      resolveApproval: vi.fn().mockResolvedValue({ kind: 'not_found' }),
    });

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(toasts[0]).toMatchObject({ text: 'Approval no longer pending' });
    expect(edits[0]).toMatchObject({
      text: 'Approval requested: bash — rm -rf build/\n\n⚠️ Approval no longer pending',
    });
  });

  it('answers with a brief reason and does not edit when resolving fails', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient({
      resolveApproval: vi.fn().mockRejectedValue(
        new KimiClientError('kimi-code API error 50000: boom', 50000, 'boom')
      ),
    });

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(toasts[0]).toMatchObject({ text: 'Failed: boom' });
    expect(edits).toHaveLength(0);
  });

  it('ignores callbacks from unpaired chats', async () => {
    const kimiClient = createMockKimiClient();

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(kimiClient.resolveApproval).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });

  it('ignores callbacks from chats with an inactive pairing', async () => {
    activatePairing(store, pairingService, 'session-1');
    store.deactivatePairing(12345);
    const kimiClient = createMockKimiClient();

    const { toasts } = await dispatchCallbackQuery(store, kimiClient, 'apr:approval_123');

    expect(kimiClient.resolveApproval).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it('ignores callback data that is not an approval action', async () => {
    activatePairing(store, pairingService, 'session-1');
    const kimiClient = createMockKimiClient();

    const { toasts, edits } = await dispatchCallbackQuery(store, kimiClient, 'something:else');

    expect(kimiClient.resolveApproval).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });
});

describe('createBot', () => {
  it('creates a bot and registers the start command', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const onPaired = vi.fn();
      const kimiClient = createMockKimiClient();
      const bot = createBot(createTestConfig(), pairingService, store, kimiClient, silentLogger, onPaired);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        chat_id: 12345,
        text: 'Paired with session `session-1`. You can now send messages here.',
      });
      expect(onPaired).toHaveBeenCalledWith('session-1');
    } finally {
      store.close();
    }
  });

  it('creates a bot and registers the text message handler', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const kimiClient = createMockKimiClient();
      const bot = createBot(createTestConfig(), pairingService, store, kimiClient, silentLogger);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });

      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          text: 'Forwarded message',
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
        },
      });

      expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
        'session-1',
        'Forwarded message'
      );
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toMatchObject({
        chat_id: 12345,
        text: 'Prompt sent.',
      });
    } finally {
      store.close();
    }
  });
});

describe('createUpdateIdDedupMiddleware', () => {
  it('calls next for new update_ids', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 2 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('drops duplicate update_ids', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 1 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('evicts old ids when the window is full', async () => {
    const middleware = createUpdateIdDedupMiddleware(2);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 2 } } as Context, next);
    await middleware({ update: { update_id: 3 } } as Context, next);
    await middleware({ update: { update_id: 1 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(4);
  });

  it('calls next when update_id is missing', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: {} } as Context, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('deduplicates updates across different handlers on the same bot', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const kimiClient = createMockKimiClient();
      const bot = createBot(createTestConfig(), pairingService, store, kimiClient, silentLogger);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      };

      await bot.handleUpdate(update);
      await bot.handleUpdate(update);

      expect(sentMessages).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
