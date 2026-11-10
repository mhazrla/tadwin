# Tadwin

**Turn Telegram study notes into tidy Notion entries.**

Tadwin (*تدوين* — the recording of knowledge) is a Telegram bot that takes a Notion page link, a body of
study material, an audio recording, and an image, then appends them to that page as a single collapsible
toggle entry:

```
Heading 1 (toggle)  ← entry title
 ├─ Audio           ← playable in Notion
 ├─ Image           ← caption becomes the description
 └─ Text            ← formatted with Gemini, rendered as Notion blocks
```

Runs entirely on **Cloudflare Workers Free** — no VPS, no credit card, no local process to keep alive.

---

## Quick start

```bash
git clone https://github.com/mhazrla/tadwin.git
cd tadwin/worker
npm install
npx wrangler login
cp .dev.vars.example .dev.vars     # fill in the values
npx wrangler secret bulk .dev.vars
npm run deploy
```

Wrangler prints a URL such as `https://tadwin-bot.<subdomain>.workers.dev`. Register the webhook once:

```bash
curl "https://tadwin-bot.<subdomain>.workers.dev/setup/<WEBHOOK_SECRET>"
# {"url":"https://.../webhook/...","result":true}
```

Then send `/start` to your bot.

### What you need

| Credential | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `NOTION_TOKEN` | [notion.so/my-integrations](https://www.notion.so/my-integrations) → new internal integration |
| `AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `AI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `AI_MODEL` | e.g. `gemini-3.5-flash-lite` (check with `/models/<WEBHOOK_SECRET>`) |
| `WEBHOOK_SECRET` | any random string |

The target Notion page must be shared with the integration (**⋯ → Connections**), and it must already
contain **at least one toggle entry** — Tadwin copies that entry's style. Without one it asks you to add it.

---

## Using the bot

| Step | What to send |
|---|---|
| 1 | The Notion page link |
| 2 | *(optional)* `/title <text>` to set the entry title |
| 3 | The material — plain text, or a `.txt` file for long notes (Telegram messages cap at ~4096 chars) |
| 4 | Audio, then an image (image caption becomes the description) |
| 5 | `/done` to build the entry |

Without `/title`, the title comes from a `title : ...` (or `judul : ...`) line, otherwise the first
non-empty line.

### Commands

The bot registers these in Telegram's command menu, so typing `/` shows the list.

| Command | Aliases | What it does |
|---|---|---|
| `/start` | — | Welcome message and instructions |
| `/browse [link]` | `/jelajah`, `/sections`, `/daftar`, `/pages`, `/halaman` | Browse a page: entries, child pages, or its own content |
| `/search <keyword>` | `/cari` | Search sections and pages (title + content) |
| `/add [text]` | `/tambah` | Start a new entry (guided title); inline text sets title directly |
| `/status` | — | Show the current session: page, title, material size, audio, image |
| `/done` | `/selesai` | Build the entry in Notion |
| `/cancel` | `/batal` | Clear the current session |
| `/clearchat` | `/bersihkan` | Delete the bot's messages in this chat (only its own, within 48 h) |
| `/help` | — | Show help |

## Browsing a page

Send `/browse` to use the page already in the session, or `/browse <link>` for any page. The bot reads
the page and shows whatever is inside it, so you do not have to know in advance whether it holds
entries or sub-pages:

1. its toggle-heading entries, if it has any;
2. otherwise its child pages, so you can drill down;
3. otherwise the page's own content (audio, image, and text).

Entries and child pages are both shown as inline buttons, 8 per page, with `◀ Prev` / `Next ▶` editing
the same message so the chat does not fill up. Labels keep the start and end of the title, so long
`Halaqah …` titles stay distinguishable.

If a page has **both** entries and child pages, the entries are shown first and one extra button
(`Pages (n)`) switches the same message to the child pages; `Sections (n)` switches back. When a page
has only one kind, that button is omitted.

Tapping an entry deletes the list and sends it back:

- **Audio** — sent as a playable file (Telegram fetches the Notion URL directly).
- **Image** — sent as a photo, with its Notion caption.
- **Text** — sent with formatting preserved (bold, italic, code, strike, links, quotes, lists, headings).

Tapping a child page deletes the list, makes that page the session page, and immediately browses it
with the same three-step order, so a hierarchy like
`Notes → MATERI HSI → 0. Pengagungan Terhadap Ilmu → Halaqah 01` can be walked one tap at a time.
`/done` afterwards appends to whichever page you opened last.

Nothing is modified on the Notion side. Notion media URLs are signed and expire after roughly an
hour, so they are fetched immediately and never stored; if a URL has already expired the bot falls
back to sending the link as text.

## Navigation after a pick

After tapping an entry or a child page, the bot sends **Back** and **Home** buttons (when they make
sense): **Back** re-opens the list you came from (or the previous level), **Home** jumps to the page
you first browsed. At the home page itself only **Back** is shown, to re-open the current list.

## Clearing the chat
`/clearchat` (alias `/bersihkan`) deletes the messages the bot sent in this chat. Telegram only
skipped. Your own messages stay. IDs are remembered from now on; messages sent before this feature
was deployed cannot be removed by the bot.

---

## Read-only mode for guests

If `OWNER_CHAT_ID` is set, only that user can add or edit entries. Everyone else can browse and read
(audio, images, text) but cannot submit material or run `/done`/`/title` — the bot replies with a
read-only notice. Omit `OWNER_CHAT_ID` to keep the bot open to everyone (current default).

## Formatting

- **Formatted Telegram messages** — bold/italic/code/link/quote arrive as Telegram `entities`; the bot
  converts them to Markdown.
- **Markdown material** — Gemini output, `.md` files, or pasted text is parsed into Notion blocks.

Supported: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[link](url)`, `# heading`, `> quote`,
`-`/`1.` lists, `---`, fenced code, and Markdown tables (stored as code blocks so columns stay aligned).
Arabic text and harakat are preserved byte-for-byte.

If the AI call fails or times out, a local Markdown parser takes over, so the entry still lands formatted.

---

## Limits worth knowing

| Limit | Value |
|---|---|
| Notion Free file size | **5 MB per file** |
| Telegram Bot API download | **20 MB per file** |
| Worker wall clock after response (`ctx.waitUntil`) | ~30 s (AI capped at 20 s) |
| Worker CPU (Free plan) | 10 ms per request |
| Account requests (Free plan) | 100,000 per day, shared across Workers |

Audio content types accepted by Notion's File Upload API: `audio/mpeg`, `audio/mp4`, `audio/aac`,
`audio/wav`, `audio/ogg`, `audio/webm`. Tadwin normalizes Telegram's MIME strings (e.g. `audio/m4a`)
and aligns the filename extension so uploads are never rejected.

---

## Project layout

```
worker/            Cloudflare Worker (the production bot)
  src/index.ts     webhook router + Telegram handlers
  src/telegram.ts  Bot API wrapper
  src/notion.ts    toggle lookup, File Upload API, block writing
  src/ai.ts        Gemini call + fallback
  src/markdown.ts  Markdown/entities → Notion blocks and annotations
  src/format.ts    page id, audio MIME, text decoding, block mapping
  src/session.ts   Durable Object session store
bot.py, notion.py, formatter.py …   legacy Python version (long polling, needs a host)
```

`worker/README.md` covers deployment details, updates, and troubleshooting.

---

## License

[MIT](LICENSE) © 2026 Muhammad Hilmy
