import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createKimiClient, KimiClientError } from './client.js';
import type { Config } from '../config.js';

async function getError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
}

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'tg-token',
    databasePath: ':memory:',
    pairingCodeTtlMinutes: 10,
    logLevel: 'info',
    kimiServerUrl: 'http://localhost:58627',
    kimiBearerToken: 'kimi-token',
    kimiTokenFile: '~/.kimi-code/server.token',
    ...overrides,
  };
}

function envelopeResponse(data: unknown, code = 0, msg = 'success'): Response {
  return new Response(JSON.stringify({ code, msg, data, request_id: 'req-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createKimiClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      envelopeResponse({
        prompt_id: 'prompt-1',
        user_message_id: 'msg-1',
        status: 'running',
        content: [{ type: 'text', text: 'Hello' }],
        created_at: '2026-01-01T00:00:00Z',
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('submitPrompt', () => {
    it('sends the correct request with a content-part body', async () => {
      const client = createKimiClient(createTestConfig());
      await client.submitPrompt('session-1', 'Hello');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://localhost:58627/api/v1/sessions/session-1/prompts'
      );
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: 'Bearer kimi-token',
          'Content-Type': 'application/json',
        },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        content: [{ type: 'text', text: 'Hello' }],
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('URL-encodes the session id', async () => {
      const client = createKimiClient(createTestConfig());
      await client.submitPrompt('session with spaces', 'Hello');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://localhost:58627/api/v1/sessions/session%20with%20spaces/prompts'
      );
    });

    it('returns the user message id from the envelope data', async () => {
      const client = createKimiClient(createTestConfig());
      const result = await client.submitPrompt('session-1', 'Hello');
      expect(result).toEqual({ id: 'msg-1' });
    });

    it('throws KimiClientError carrying code and msg on a business error envelope', async () => {
      fetchSpy.mockResolvedValue(
        envelopeResponse(null, 40401, 'session not found')
      );

      const client = createKimiClient(createTestConfig());
      const error = await getError(() =>
        client.submitPrompt('session-1', 'Hello')
      );

      expect(error).toBeInstanceOf(KimiClientError);
      expect(error).toMatchObject({ code: 40401, msg: 'session not found' });
    });

    it('throws KimiClientError on a real HTTP error status', async () => {
      fetchSpy.mockResolvedValue(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      );

      const client = createKimiClient(createTestConfig());
      const error = await getError(() =>
        client.submitPrompt('session-1', 'Hello')
      );

      expect(error).toBeInstanceOf(KimiClientError);
      expect((error as KimiClientError).code).toBe(401);
    });

    it('throws when the response body is not valid JSON', async () => {
      fetchSpy.mockResolvedValue(
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = createKimiClient(createTestConfig());
      const error = await getError(() =>
        client.submitPrompt('session-1', 'Hello')
      );

      expect(error).toBeInstanceOf(KimiClientError);
      expect((error as Error).message).toMatch(/invalid json/i);
    });

    it('throws when the envelope data is missing user_message_id', async () => {
      fetchSpy.mockResolvedValue(envelopeResponse({ prompt_id: 'prompt-1' }));

      const client = createKimiClient(createTestConfig());
      await expect(
        client.submitPrompt('session-1', 'Hello')
      ).rejects.toThrowError(/user_message_id/i);
    });

    it('serializes special characters in the request body', async () => {
      const client = createKimiClient(createTestConfig());
      await client.submitPrompt('session-1', 'line1\nline2 "quote" é');

      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        content: [{ type: 'text', text: 'line1\nline2 "quote" é' }],
      });
    });

    it('wraps fetch network errors in KimiClientError', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const client = createKimiClient(createTestConfig());
      const error = await getError(() =>
        client.submitPrompt('session-1', 'Hello')
      );

      expect(error).toBeInstanceOf(KimiClientError);
      expect((error as Error).message).toMatch(/fetch failed/);
    });

    it('uses a 30-second timeout for fetch', async () => {
      const timeoutSpy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(new AbortController().signal);

      const client = createKimiClient(createTestConfig());
      await client.submitPrompt('session-1', 'Hello');

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      timeoutSpy.mockRestore();
    });
  });

  describe('resolveApproval', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue(
        envelopeResponse({ resolved: true, resolved_at: '2026-01-01T00:00:01Z' })
      );
    });

    it('posts the decision to the approval endpoint', async () => {
      const client = createKimiClient(createTestConfig());
      await client.resolveApproval('session-1', 'approval_abc', 'approved');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://localhost:58627/api/v1/sessions/session-1/approvals/approval_abc'
      );
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: 'Bearer kimi-token',
          'Content-Type': 'application/json',
        },
      });
      expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approved' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('includes scope session when provided', async () => {
      const client = createKimiClient(createTestConfig());
      await client.resolveApproval('session-1', 'approval_abc', 'approved', 'session');

      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        decision: 'approved',
        scope: 'session',
      });
    });

    it('URL-encodes the approval id', async () => {
      const client = createKimiClient(createTestConfig());
      await client.resolveApproval('session-1', 'approval with spaces', 'rejected');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://localhost:58627/api/v1/sessions/session-1/approvals/approval%20with%20spaces'
      );
    });

    it('returns resolved on success', async () => {
      const client = createKimiClient(createTestConfig());
      const result = await client.resolveApproval('session-1', 'approval_abc', 'approved');
      expect(result).toEqual({ kind: 'resolved' });
    });

    it('maps code 40902 to already_resolved', async () => {
      fetchSpy.mockResolvedValue(
        envelopeResponse({ resolved: false }, 40902, 'approval already resolved')
      );

      const client = createKimiClient(createTestConfig());
      const result = await client.resolveApproval('session-1', 'approval_abc', 'approved');
      expect(result).toEqual({ kind: 'already_resolved' });
    });

    it('maps code 40404 to not_found', async () => {
      fetchSpy.mockResolvedValue(
        envelopeResponse(null, 40404, 'approval not found')
      );

      const client = createKimiClient(createTestConfig());
      const result = await client.resolveApproval('session-1', 'approval_abc', 'approved');
      expect(result).toEqual({ kind: 'not_found' });
    });

    it('maps code 40401 to not_found', async () => {
      fetchSpy.mockResolvedValue(
        envelopeResponse(null, 40401, 'session not found')
      );

      const client = createKimiClient(createTestConfig());
      const result = await client.resolveApproval('session-1', 'approval_abc', 'approved');
      expect(result).toEqual({ kind: 'not_found' });
    });

    it('throws KimiClientError for other envelope error codes', async () => {
      fetchSpy.mockResolvedValue(
        envelopeResponse(null, 50000, 'internal error')
      );

      const client = createKimiClient(createTestConfig());
      const error = await getError(() =>
        client.resolveApproval('session-1', 'approval_abc', 'approved')
      );

      expect(error).toBeInstanceOf(KimiClientError);
      expect(error).toMatchObject({ code: 50000, msg: 'internal error' });
    });
  });
});
