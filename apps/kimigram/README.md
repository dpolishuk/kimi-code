# kimigram

A Telegram bridge sidecar for [kimi-code](https://github.com/MoonshotAI/kimi-code). It runs next to a local kimi-code server, forwards text messages from Telegram as user prompts, and pushes notifications back to Telegram — including approval requests you can resolve with inline buttons.

## What it does

- Receives Telegram messages via long polling.
- Forwards text from a paired Telegram chat to a linked kimi-code session as a user prompt.
- Subscribes to the kimi-code WebSocket event stream and sends Telegram notifications for:
  - Turn completion / failure
  - Task completion / failure
  - Goal completion
  - Approval requests (with **Approve** / **Always allow** / **Reject** inline buttons)
  - Assistant replies (one message per completed turn, converted from Markdown to Telegram MarkdownV2)
- Auto-reconnects on network failures and deduplicates retried Telegram updates.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and copy the bot token.
2. Ensure a kimi-code server is running locally (default `http://127.0.0.1:58627`).
3. Copy `.env.example` to `.env` and set:
   - `TELEGRAM_BOT_TOKEN` — required.
   - Either `KIMI_BEARER_TOKEN` or `KIMI_TOKEN_FILE` pointing to a file containing your kimi-code bearer token (default `~/.kimi-code/server.token`, the file written by the kimi-code server).
4. Install dependencies from the repository root (kimigram is a pnpm workspace member):
   ```bash
   pnpm install
   ```
5. Start the sidecar:
   ```bash
   pnpm --filter kimigram dev
   ```

The sidecar creates a SQLite database at `DATABASE_PATH` (default `./data/kimigram.db`) to store pairings and approval-message mappings.

## How to use

### 1. Pair Telegram with a kimi-code session

A Telegram chat must be paired with a kimi-code session before the bot will forward messages. The pairing is authorized by a one-time code generated inside the authenticated kimi-code session.

Find your active kimi-code session ID:

```bash
pnpm --filter kimigram run sessions
```

Then generate a pairing code for that session:

```bash
pnpm --filter kimigram run pair -- <session-id>
```

Then send the printed code to the bot in a private chat:

```
/start <code>
```

The bot replies with the linked session ID. One Telegram chat can be paired with one session at a time.

### 2. Send prompts from Telegram

Once paired, any plain text message you send to the bot is forwarded to the linked kimi-code session as a user prompt. The bot replies with "Prompt sent." when the REST call succeeds.

If the chat is not paired, the bot responds with setup instructions and does not forward the message.

Note: the current kimi-code server does not support reply threading, so Telegram "reply to message" is treated as a plain prompt — no `reply_to_message_id` is sent.

### 3. Approve permission requests from Telegram

When kimi-code asks for a tool approval, the bot sends a message like:

```
Approval requested: bash — rm -rf build/
```

with three inline buttons:

- **Approve** — approve this request once.
- **Always allow** — approve and allow the same kind of request for the rest of the session.
- **Reject** — reject the request.

After you tap a button, the bot shows a short toast and edits the message to record the outcome (✅ Approved / ✅ Always allowed (session) / ❌ Rejected) and removes the keyboard. If the approval was already resolved or has expired, you get a ⚠️ note instead.

If the approval is resolved elsewhere (for example in the CLI), the bot edits the message with the decision (✅ Approved / ❌ Rejected / ⚪ Cancelled) and removes the keyboard.

### 4. Get notifications

While paired, you receive Telegram notifications for session events:

| kimi-code event | Telegram notification |
|-----------------|------------------------|
| `turn.ended` with `reason: completed` | "Turn completed." (preceded by the assistant reply text, if any) |
| `turn.ended` with `reason: failed` | "Turn failed." |
| `task.terminated` | "Task completed." or "Task failed." (the legacy `background.task.terminated` alias is ignored to avoid duplicates) |
| `goal.updated` with snapshot `status: complete` | "Goal completed." |
| `event.approval.requested` | Approval prompt with inline buttons (see above) |
| `event.approval.resolved` | Edits the approval message with the outcome |
| `assistant.delta` | Buffered per turn; sent once as a single message when the turn completes |

Assistant text is accumulated from `assistant.delta` events per turn (bounded buffer, oldest turns dropped past 100 KB) and delivered as one message when the turn completes — there is no partial streaming to Telegram. Buffers are discarded when a turn fails or is cancelled. Markdown is converted to Telegram MarkdownV2 with a plain-text fallback if conversion would produce invalid markup.

Milestone notifications are always sent as plain text. Events for unpaired or inactive sessions are ignored.

### 5. Unpair or switch sessions

To link the chat to a different session, generate a new pairing code from the new session and run `/start <new-code>`. The bot replaces the previous pairing with the new one.

## Reliability

- The sidecar auto-reconnects to both Telegram long polling and the kimi-code WebSocket after network failures.
- Reconnect delay for the WebSocket client backs off exponentially up to 30 seconds; the full handshake (`client_hello` + `subscribe`) re-runs after every reconnect.
- The WebSocket connection authenticates via the `kimi-code.bearer.<token>` subprotocol and answers server `ping` frames with `pong` to stay alive.
- Incoming Telegram updates are deduplicated by `update_id` using a bounded in-memory window, so retries or redelivered updates are not forwarded to kimi-code twice. The window is in-memory only, so duplicates may be re-processed after a process restart.

## Development

```bash
pnpm --filter kimigram dev      # Start with tsx
pnpm --filter kimigram build    # TypeScript compile
pnpm --filter kimigram test     # Run tests
pnpm --filter kimigram run lint # Type check
```

## Architecture

- `src/config.ts` — Environment configuration and validation.
- `src/logger.ts` — Pino logger factory.
- `src/store.ts` — SQLite persistence for pairings and approval-message mappings.
- `src/pairing.ts` — One-time pairing code generation and validation.
- `src/bot.ts` — Telegram bot handlers (`/start`, text-message forwarding, approval callback queries) and `createUpdateIdDedupMiddleware()` for `update_id` deduplication.
- `src/kimi/client.ts` — REST client for the running kimi-code server (envelope unwrap, prompt submission, approval resolution).
- `src/kimi/ws.ts` — WebSocket client for the kimi-code event stream (handshake, ping/pong, resubscribe on reconnect).
- `src/kimi/events.ts` — Dispatcher that maps kimi-code events to Telegram notifications and approval messages.
- `src/formatting/telegramMarkdown.ts` — Converts kimi-code Markdown to Telegram MarkdownV2 with plain-text fallback.
- `src/index.ts` — Service entrypoint.
