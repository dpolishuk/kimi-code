#!/usr/bin/env node

/**
 * CLI helper to list active kimi-code sessions so the user can pick an ID
 * for `pnpm --filter kimigram run pair -- <session-id>`.
 *
 * Usage:
 *   pnpm --filter kimigram run sessions
 *   npx tsx scripts/list-sessions.ts
 */

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

interface SessionItem {
  id: string;
  workspace_id?: string;
  title?: string;
  busy?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  created_at?: string;
  updated_at?: string;
}

interface SessionsEnvelope {
  code?: number;
  msg?: string;
  data?: { items?: unknown; has_more?: boolean };
}

async function fetchSessions(serverUrl: string, token: string): Promise<SessionItem[]> {
  const response = await fetch(`${serverUrl}/api/v1/sessions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`kimi-code returned ${response.status}: ${await response.text()}`);
  }

  const envelope = (await response.json()) as SessionsEnvelope;
  if (envelope.code !== 0) {
    throw new Error(`kimi-code error ${envelope.code}: ${envelope.msg ?? 'unknown'}`);
  }

  const items = envelope.data?.items;
  return Array.isArray(items) ? (items as SessionItem[]) : [];
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  try {
    const sessions = await fetchSessions(config.kimiServerUrl, config.kimiBearerToken);

    if (sessions.length === 0) {
      console.log('No sessions returned by kimi-code.');
      return;
    }

    console.log('Active kimi-code sessions:');
    for (const session of sessions) {
      const line = [
        `- ${session.id}`,
        session.title && `title=${JSON.stringify(session.title)}`,
        `busy=${session.busy ?? false}`,
        `pending_interaction=${session.pending_interaction ?? 'none'}`,
        session.created_at && `created=${session.created_at}`,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(line);
    }

    console.log('\nPair a session with Telegram:');
    console.log('  pnpm --filter kimigram run pair -- <session-id>');
  } catch (error) {
    logger.error({ error }, 'Failed to list sessions from kimi-code');
    console.error('\nCould not fetch sessions. Make sure kimi-code is running and the bearer token is valid.');
    console.error(`Tried: GET ${config.kimiServerUrl}/api/v1/sessions`);
    process.exit(1);
  }
}

main();
