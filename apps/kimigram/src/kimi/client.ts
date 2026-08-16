import type { Config } from '../config.js';

/**
 * Error thrown when the kimi-code REST API cannot be reached or returns an
 * error. Carries the server envelope `code` and `msg`; for transport-level
 * failures (HTTP error statuses, network errors) `code` is the HTTP status or
 * -1 for network errors.
 */
export class KimiClientError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly msg: string
  ) {
    super(message);
    this.name = 'KimiClientError';
  }
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export type ResolveApprovalResult =
  | { kind: 'resolved' }
  | { kind: 'already_resolved' }
  | { kind: 'not_found' };

export interface KimiClient {
  submitPrompt(sessionId: string, text: string): Promise<{ id: string }>;
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session'
  ): Promise<ResolveApprovalResult>;
}

const REQUEST_TIMEOUT_MS = 30_000;

const CODE_APPROVAL_ALREADY_RESOLVED = 40902;
const CODE_APPROVAL_NOT_FOUND = 40404;
const CODE_SESSION_NOT_FOUND = 40401;

interface Envelope {
  code: number;
  msg: string;
  data: unknown;
}

/**
 * Creates a lightweight REST client for a running kimi-code server.
 *
 * Every successful response body is an envelope `{ code, msg, data }`;
 * business errors arrive with HTTP 200 and a nonzero `code`.
 */
export function createKimiClient(config: Config): KimiClient {
  async function post(path: string, body: unknown): Promise<Envelope> {
    const url = `${config.kimiServerUrl}/api/v1${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.kimiBearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KimiClientError(
        `Network error calling kimi-code API: ${message}`,
        -1,
        message
      );
    }

    const responseBody = await response.text();

    if (!response.ok) {
      throw new KimiClientError(
        `kimi-code API error: ${response.status} ${response.statusText}`,
        response.status,
        responseBody
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      throw new KimiClientError(
        'Invalid JSON response from kimi-code API',
        response.status,
        responseBody
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { code?: unknown }).code !== 'number'
    ) {
      throw new KimiClientError(
        'Invalid response from kimi-code API: not an envelope',
        response.status,
        responseBody
      );
    }

    const envelope = parsed as { code: number; msg?: unknown; data?: unknown };
    return {
      code: envelope.code,
      msg: typeof envelope.msg === 'string' ? envelope.msg : '',
      data: envelope.data,
    };
  }

  function requireSuccess(envelope: Envelope): unknown {
    if (envelope.code !== 0) {
      throw new KimiClientError(
        `kimi-code API error ${envelope.code}: ${envelope.msg}`,
        envelope.code,
        envelope.msg
      );
    }
    return envelope.data;
  }

  return {
    async submitPrompt(sessionId, text) {
      const envelope = await post(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        { content: [{ type: 'text', text }] }
      );
      const data = requireSuccess(envelope);

      const userMessageId = (data as { user_message_id?: unknown } | null | undefined)
        ?.user_message_id;
      if (typeof userMessageId !== 'string') {
        throw new KimiClientError(
          'Invalid response from kimi-code API: missing user_message_id',
          envelope.code,
          envelope.msg
        );
      }

      return { id: userMessageId };
    },

    async resolveApproval(sessionId, approvalId, decision, scope) {
      const envelope = await post(
        `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
        { decision, scope }
      );

      if (envelope.code === 0) {
        return { kind: 'resolved' };
      }
      if (envelope.code === CODE_APPROVAL_ALREADY_RESOLVED) {
        return { kind: 'already_resolved' };
      }
      if (
        envelope.code === CODE_APPROVAL_NOT_FOUND ||
        envelope.code === CODE_SESSION_NOT_FOUND
      ) {
        return { kind: 'not_found' };
      }
      throw new KimiClientError(
        `kimi-code API error ${envelope.code}: ${envelope.msg}`,
        envelope.code,
        envelope.msg
      );
    },
  };
}
