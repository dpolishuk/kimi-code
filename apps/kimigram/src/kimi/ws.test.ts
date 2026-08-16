import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createKimiEventClient,
  type KimiEvent,
  type WebSocketLike,
} from './ws.js';
import type { Config } from '../config.js';

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'tg-token',
    databasePath: ':memory:',
    pairingCodeTtlMinutes: 10,
    logLevel: 'info',
    kimiServerUrl: 'http://localhost:58627',
    kimiBearerToken: 'kimi-token',
    kimiTokenFile: '~/.kimi-code/server.token',
    kimiWsUrl: 'ws://localhost:58627',
    ...overrides,
  };
}

class FakeWebSocket extends EventTarget implements WebSocketLike {
  static lastInstance: FakeWebSocket | null = null;

  url: string;
  protocols?: string | string[];
  readyState = 0;
  sent: string[] = [];
  closed = false;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.lastInstance = this;
  }

  on(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (data?: unknown) => void
  ): void {
    this.addEventListener(event, (evt) => {
      if (event === 'message' && evt instanceof MessageEvent) {
        listener(evt.data);
      } else if (event === 'error' && evt instanceof ErrorEvent) {
        listener({ message: evt.message });
      } else if (event === 'close' && evt instanceof CloseEvent) {
        listener();
      } else {
        listener();
      }
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.dispatchEvent(new CloseEvent('close', { wasClean: true }));
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  // Helpers to simulate server-side events
  simulateOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: string) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  simulateFrame(frame: Record<string, unknown>) {
    this.simulateMessage(JSON.stringify(frame));
  }

  simulateServerHello() {
    this.simulateFrame({ type: 'server_hello', payload: {} });
  }

  simulateError(message: string) {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }

  simulateClose() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { wasClean: false }));
  }
}

describe('createKimiEventClient', () => {
  let events: KimiEvent[] = [];

  beforeEach(() => {
    FakeWebSocket.lastInstance = null;
    events = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createClient(
    config = createTestConfig(),
    options: Omit<Parameters<typeof createKimiEventClient>[1], 'onEvent'> = {}
  ) {
    return createKimiEventClient(config, {
      onEvent: (event) => events.push(event),
      webSocketFactory: (url, protocols) =>
        new FakeWebSocket(url, protocols) as unknown as WebSocketLike,
      ...options,
    });
  }

  function lastSocket(): FakeWebSocket {
    const socket = FakeWebSocket.lastInstance;
    if (!socket) throw new Error('no socket');
    return socket;
  }

  it('connects to the WebSocket URL with the kimi-code bearer subprotocol', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    expect(socket.url).toBe('ws://localhost:58627/api/v1/ws');
    expect(socket.protocols).toEqual(['kimi-code.bearer.kimi-token']);
  });

  it('runs the handshake after server_hello: client_hello then subscribe', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();

    const frames = socket.sentFrames();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      type: 'client_hello',
      payload: { client_id: 'kimigram' },
    });
    expect(typeof frames[0].id).toBe('string');
    expect(frames[1]).toMatchObject({
      type: 'subscribe',
      payload: { session_ids: [] },
    });
  });

  it('subscribes with the session ids set before connecting', () => {
    const client = createClient();
    client.setSessionIds(['session-1']);
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();

    const frames = socket.sentFrames();
    expect(frames[1]).toMatchObject({
      type: 'subscribe',
      payload: { session_ids: ['session-1'] },
    });
  });

  it('sends a new subscribe frame when setSessionIds is called while connected', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();

    client.setSessionIds(['session-1', 'session-2']);

    const frames = socket.sentFrames();
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({
      type: 'subscribe',
      payload: { session_ids: ['session-1', 'session-2'] },
    });
  });

  it('does not send anything when setSessionIds is called before connect', () => {
    const client = createClient();
    client.setSessionIds(['session-1']);
    expect(FakeWebSocket.lastInstance).toBeNull();
  });

  it('re-runs the handshake with the current session set after reconnect', () => {
    const client = createClient();
    client.start();

    const firstSocket = lastSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateServerHello();
    client.setSessionIds(['session-1']);
    firstSocket.simulateClose();

    vi.advanceTimersByTime(1_000);

    const secondSocket = lastSocket();
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.simulateOpen();
    secondSocket.simulateServerHello();

    const frames = secondSocket.sentFrames();
    expect(frames[0]).toMatchObject({ type: 'client_hello' });
    expect(frames[1]).toMatchObject({
      type: 'subscribe',
      payload: { session_ids: ['session-1'] },
    });
  });

  it('replies to ping frames with a pong carrying the same nonce', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();
    socket.simulateFrame({
      type: 'ping',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { nonce: 'nonce-123' },
    });

    const frames = socket.sentFrames();
    expect(frames.at(-1)).toEqual({
      type: 'pong',
      payload: { nonce: 'nonce-123' },
    });
  });

  it('does not deliver control frames as events', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();
    socket.simulateFrame({ type: 'ack', id: 'x' });
    socket.simulateFrame({ type: 'ping', payload: { nonce: 'n' } });

    expect(events).toHaveLength(0);
  });

  it('delivers parsed event frames with sessionId and payload', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateServerHello();
    socket.simulateFrame({
      type: 'turn.ended',
      seq: 42,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { turnId: 'turn-1', reason: 'completed' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'turn.ended',
      sessionId: 'session-1',
      payload: { turnId: 'turn-1', reason: 'completed' },
    });
  });

  it('delivers frames without a session_id with an undefined sessionId', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateFrame({ type: 'server.status', payload: { ok: true } });

    expect(events).toEqual([
      { type: 'server.status', sessionId: undefined, payload: { ok: true } },
    ]);
  });

  it('ignores malformed JSON messages', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage('not-json');

    expect(events).toHaveLength(0);
  });

  it('ignores messages missing a type', () => {
    const client = createClient();
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ payload: {} }));

    expect(events).toHaveLength(0);
  });

  it('reconnects after the connection closes', () => {
    const client = createClient();
    client.start();

    const firstSocket = lastSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateClose();

    expect(lastSocket()).toBe(firstSocket);

    vi.advanceTimersByTime(1_000);

    const secondSocket = lastSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket.url).toBe('ws://localhost:58627/api/v1/ws');
  });

  it('backs off reconnect attempts exponentially', () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout');
    const client = createClient();
    client.start();

    for (let i = 0; i < 3; i++) {
      lastSocket().simulateClose();
      const timeoutCalls = spy.mock.calls
        .slice(timeouts.length)
        .map((call) => Number(call[1]));
      timeouts.push(...timeoutCalls);
      vi.advanceTimersByTime(Math.min(1_000 * 2 ** i, 30_000));
    }

    expect(timeouts.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps reconnect delay at 30 seconds', () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout');
    const client = createClient();
    client.start();

    for (let i = 0; i < 6; i++) {
      lastSocket().simulateClose();
      const timeoutCalls = spy.mock.calls
        .slice(timeouts.length)
        .map((call) => Number(call[1]));
      timeouts.push(...timeoutCalls);
      vi.advanceTimersByTime(30_000);
    }

    expect(Math.max(...timeouts)).toBe(30_000);
    const lastTimeout = timeouts.at(-1);
    expect(lastTimeout).toBe(30_000);
  });

  it('stops reconnecting after stop is called', () => {
    const client = createClient();
    client.start();

    const firstSocket = lastSocket();
    firstSocket.simulateOpen();
    client.stop();

    firstSocket.simulateClose();
    vi.advanceTimersByTime(60_000);

    expect(lastSocket()).toBe(firstSocket);
    expect(firstSocket.closed).toBe(true);
  });

  it('cancels a pending reconnect timeout when stopped', () => {
    const client = createClient();
    client.start();

    const firstSocket = lastSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateClose();

    client.stop();
    vi.advanceTimersByTime(60_000);

    expect(lastSocket()).toBe(firstSocket);
    expect(firstSocket.closed).toBe(true);
  });

  it('logs WebSocket errors', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = createClient(createTestConfig(), { logger });
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateError('connection failed');

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'ws://localhost:58627/api/v1/ws',
        error: expect.objectContaining({ message: 'connection failed' }),
      }),
      'kimi-code WebSocket error'
    );
  });

  it('is idempotent when start is called multiple times', () => {
    const client = createClient();
    client.start();
    const firstSocket = lastSocket();

    client.start();
    const secondSocket = lastSocket();

    expect(secondSocket).toBe(firstSocket);
  });

  it('schedules reconnect when the WebSocket factory throws', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let attempt = 0;
    const client = createKimiEventClient(createTestConfig(), {
      onEvent: (event) => events.push(event),
      webSocketFactory: () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('factory boom');
        }
        return new FakeWebSocket('ws://localhost:58627/api/v1/ws') as unknown as WebSocketLike;
      },
      logger,
    });
    client.start();

    expect(attempt).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'kimi-code WebSocket factory threw'
    );

    vi.advanceTimersByTime(1_000);

    expect(attempt).toBe(2);
  });

  it('logs when the event handler throws', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = createKimiEventClient(createTestConfig(), {
      onEvent: () => {
        throw new Error('handler boom');
      },
      webSocketFactory: (url, protocols) =>
        new FakeWebSocket(url, protocols) as unknown as WebSocketLike,
      logger,
    });
    client.start();

    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateFrame({ type: 'turn.ended', payload: {} });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'turn.ended', error: expect.any(Error) }),
      'Event handler threw'
    );
  });
});
