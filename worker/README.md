# Tadwin — Cloudflare Worker

The production version of Tadwin: a Telegram bot that appends study material to Notion as a single
collapsible entry. Runs on **Cloudflare Workers Free** — no VPS, no credit card, nothing to keep running.

## How it differs from the Python version

| | Python (legacy) | This Worker |
|---|---|---|
| Telegram mode | long polling | **webhook** |
| Session store | in-memory dict | **Durable Object** (SQLite) |
| AI | 9router / OpenAI-compatible | **Gemini** (OpenAI-compatible endpoint) |
| Audio extraction from video | ffmpeg | none — video is uploaded as `audio/mp4` |

Everything else matches: link → material (text or `.txt`) → audio → image → `/done`, one `heading_1`
toggle per entry, order **audio → image → text**, `>` lines become `quote`, Arabic and harakat preserved.

## Commands

| Command | Aliases | What it does |
|---|---|---|
| `/start` | — | Welcome message and instructions |
| `/title <text>` | `/judul` | Set the entry title (supports `**bold**` / `*italic*`) |
| `/status` | — | Show the current session |
| `/done` | `/selesai` | Build the entry in Notion |
| `/cancel` | `/batal` | Clear the current session |
| `/help` | — | Show help |

`/setup/<WEBHOOK_SECRET>` registers both the webhook and this command menu in one call.

## Requirements

- A Cloudflare account (free).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A Notion integration token; the target page must be shared with that integration.
- A Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## Setup

```bash
cd worker
npm install
npx wrangler login
```

Copy `.dev.vars.example` to `.dev.vars` and fill in every value, then upload them in one request:

```bash
npx wrangler secret bulk .dev.vars
npm run deploy
```

Or set secrets one at a time:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put AI_API_KEY
npx wrangler secret put AI_BASE_URL      # https://generativelanguage.googleapis.com/v1beta/openai
npx wrangler secret put AI_MODEL         # see "Choosing a model"
npx wrangler secret put WEBHOOK_SECRET   # any random string
```

Optional:

```bash
npx wrangler secret put NOTION_VERSION    # default: 2026-03-11
npx wrangler secret put ALLOWED_CHAT_IDS  # e.g. 123456789,987654321
```

After `npm run deploy`, wrangler prints the URL, for example
`https://tadwin-bot.<subdomain>.workers.dev`.

Register the webhook once (open in a browser or use curl):

```bash
curl "https://tadwin-bot.<subdomain>.workers.dev/setup/<WEBHOOK_SECRET>"
```

A successful response contains `{"url":"...","result":true}`. Then send `/start` to the bot.

> Use a dedicated bot token. If another program polls the same bot, webhook and long polling will fight
> over updates and messages will go missing.

## Updating after a code change

```bash
npm run typecheck   # optional
npm run deploy
```

The URL, secrets, Durable Object, and webhook stay the same. Useful commands:

```bash
npx wrangler tail tadwin-bot          # live logs
npx wrangler deployments list         # version history
npx wrangler rollback                 # revert to the previous version
```

## Choosing a model

Gemini model IDs rotate. List the ones available to your key:

```bash
curl "https://tadwin-bot.<subdomain>.workers.dev/models/<WEBHOOK_SECRET>"
```

Pick a chat-capable `id` (without the `models/` prefix) and set it:

```bash
npx wrangler secret put AI_MODEL
```

Common IDs: `gemini-2.5-flash-lite`, `gemini-3.5-flash-lite`.

## Formatting

Formatting never depends on how Telegram renders text:

1. **Formatted Telegram messages** — bold/italic/code/link/quote arrive as Telegram `entities`; the bot
   converts them to Markdown.
2. **Markdown material** — Gemini output, `.md` files, or pasted text is parsed into Notion blocks.

Supported: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[link](url)`, `# heading`, `> quote`,
`-`/`1.` lists, `---`, fenced code, and Markdown tables (stored as code blocks so columns stay aligned).

If the AI call fails or times out, the local Markdown parser takes over, so entries still land formatted.

## Limits

- **Notion Free: 5 MB per file.** Long recordings are rejected; the bot explains why.
- **Telegram Bot API: 20 MB per download.** Larger files cannot be fetched at all.
- **`ctx.waitUntil()` ≈ 30 s** after the response. AI is capped at 20 s; media uploads run in parallel.
- **10 ms CPU per request** (Free plan). Network calls are not counted, but very large text parsing can
  approach the limit — split huge material across files.
- **100,000 requests/day per account**, shared by all your Workers. A personal bot stays far below that.

Accepted audio content types: `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/ogg`,
`audio/webm`. MIME strings that Telegram sends but Notion rejects (such as `audio/m4a`) are normalized,
and the filename extension is aligned with the content type. Formats Notion cannot accept (`flac`,
`amr`, `3gp`) are refused with a clear message.

## Structure

```
src/
  index.ts     webhook router + Telegram handlers
  telegram.ts  Bot API (sendMessage, getFile, setWebhook)
  notion.ts    toggle examples, File Upload API, append entry
  ai.ts        Gemini call + fallback
  markdown.ts  Markdown / Telegram entities → Notion blocks and annotations
  format.ts    page id, audio MIME, text decoding, block mapping
  session.ts   Durable Object session store
  env.ts       environment types
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No reply at all | Webhook not registered — open `/setup/<WEBHOOK_SECRET>`. Also check you are messaging the right bot. |
| `Unauthorized` from `/setup` | Wrong or malformed `TELEGRAM_BOT_TOKEN`; re-upload secrets. |
| `Failed to resolve host` | Telegram could not resolve the worker hostname — try a different Worker name. |
| `409 Conflict` | Another program is polling the same bot token; stop it. |
| Audio upload rejected | Notion accepts only the six content types above and needs the matching extension. |
| `page not found` | The Notion page is not shared with the integration. |
| No toggle created | The page has no existing toggle entry to copy the style from. |
