import type { Config } from '../config.js';
import WebSocket from 'ws';

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * An event delivered over the kimi-code WebSocket stream.
 */
export interface KimiEvent {
  type: string;
  payload: unknown;
  sessionId?: string;
}

/**
 * Minimal WebSocket surface used by the event client. This abstraction keeps
 * the client testable without a real network connection.
 */
export interface WebSocketLike {
  on(event: 'open' | 'message' | 'error' | 'close', listener: (data?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface KimiEventClientOptions {
  /** Called for each parsed event received from the WebSocket stream. */
  onEvent: (event: KimiEvent) => void;
  /** Injected WebSocket factory for testing; defaults to the native `ws` client. */
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
  /** Logger for connection lifecycle and parse warnings. Defaults to `console`. */
  logger?: Logger;
}

export interface KimiEventClient {
  start(): void;
  stop(): void;
  /**
   * Replaces the subscribed session set. Sends a new `subscribe` frame when
   * connected; the set is re-applied on every reconnect handshake.
   */
  setSessionIds(ids: string[]): void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const CLIENT_ID = 'kimigram';

function defaultWebSocketFactory(
  url: string,
  protocols?: string[]
): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

interface WsFrame {
  type: string;
  id?: unknown;
  session_id?: unknown;
  payload?: unknown;
}

/**
 * Creates a resilient WebSocket client that subscribes to the kimi-code event
 * stream.
 *
 * The bearer token is transmitted as the WebSocket subprotocol
 * `kimi-code.bearer.<token>`. After the server's `server_hello` the client
 * sends `client_hello` followed by a `subscribe` frame for the current session
 * set, and answers app-level `ping` frames with `pong`. It reconnects with
 * exponential backoff after disconnects until `stop()` is called, re-running
 * the full handshake on every reconnect.
 */
export function createKimiEventClient(
  config: Config,
  options: KimiEventClientOptions
): KimiEventClient {
  const {
    onEvent,
    webSocketFactory = defaultWebSocketFactory,
    logger = console,
  } = options;

  let socket: WebSocketLike | null = null;
  let handshakeComplete = false;
  let frameCounter = 0;
  let sessionIds: string[] = [];
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;

  function nextFrameId(): string {
    frameCounter += 1;
    return `kimigram-${frameCounter}`;
  }

  function sendFrame(target: WebSocketLike, frame: Record<string, unknown>) {
    target.send(JSON.stringify(frame));
  }

  function sendSubscribe(target: WebSocketLike) {
    sendFrame(target, {
      type: 'subscribe',
      id: nextFrameId(),
      payload: { session_ids: [...sessionIds] },
    });
  }

  function handleFrame(currentSocket: WebSocketLike, frame: WsFrame) {
    switch (frame.type) {
      case 'server_hello': {
        sendFrame(currentSocket, {
          type: 'client_hello',
          id: nextFrameId(),
          payload: { client_id: CLIENT_ID },
        });
        handshakeComplete = true;
        sendSubscribe(currentSocket);
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | null | undefined)?.nonce;
        sendFrame(currentSocket, {
          type: 'pong',
          payload: { nonce: typeof nonce === 'string' ? nonce : undefined },
        });
        return;
      }
      case 'ack':
        return;
      default: {
        const event: KimiEvent = {
          type: frame.type,
          payload: frame.payload,
          sessionId:
            typeof frame.session_id === 'string' ? frame.session_id : undefined,
        };
        try {
          onEvent(event);
        } catch (error) {
          logger.error({ error, eventType: event.type }, 'Event handler threw');
        }
      }
    }
  }

  function connect() {
    if (stopped) return;

    const baseUrl = `${config.kimiWsUrl}/api/v1/ws`;
    const protocols = [`kimi-code.bearer.${config.kimiBearerToken}`];

    const currentSocket = webSocketFactory(baseUrl, protocols);
    socket = currentSocket;
    handshakeComplete = false;

    currentSocket.on('open', () => {
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      logger.info({ url: baseUrl }, 'Connected to kimi-code event stream');
    });

    currentSocket.on('message', (raw) => {
      const data = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        logger.warn({ error, data }, 'Failed to parse kimi-code event');
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        logger.warn({ data }, 'Ignoring kimi-code event with no type');
        return;
      }
      handleFrame(currentSocket, parsed as WsFrame);
    });

    currentSocket.on('error', (error) => {
      logger.error({ error, url: baseUrl }, 'kimi-code WebSocket error');
    });

    currentSocket.on('close', () => {
      if (socket !== currentSocket) return;
      handshakeComplete = false;
      logger.info({ url: baseUrl }, 'Disconnected from kimi-code event stream');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimeout) return;
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      try {
        connect();
      } catch (error) {
        logger.error({ error }, 'kimi-code WebSocket factory threw');
        scheduleReconnect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(
      reconnectDelay * BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      stopped = false;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      try {
        connect();
      } catch (error) {
        logger.error({ error }, 'kimi-code WebSocket factory threw');
        scheduleReconnect();
      }
    },
    stop() {
      started = false;
      stopped = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      socket?.close();
      socket = null;
      handshakeComplete = false;
    },
    setSessionIds(ids: string[]) {
      sessionIds = [...ids];
      if (socket && handshakeComplete) {
        sendSubscribe(socket);
      }
    },
  };
}
