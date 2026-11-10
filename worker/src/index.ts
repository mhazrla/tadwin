import { formatMaterial } from "./ai";
import type { Env } from "./env";
import {
  audioUpload,
  decodeText,
  extOf,
  extractTitle,
  parsePageId,
  TEXT_EXT,
  type Block,
} from "./format";
import {
  appendEntry,
  findToggleExamples,
  getSectionContent,
  listPageContent,
  uploadFile,
  type PageRef,
  type SectionContent,
} from "./notion";
import { entitiesToMarkdown, markdownToBlocks } from "./markdown";
import { emptyState, type SectionRef, type SessionState } from "./session";
import {
  answerCallbackQuery,
  deleteMessage,
  downloadFile,
  editMessageText,
  sendAudio as tgSendAudio,
  sendDocument as tgSendDocument,
  sendHtml as tgSendHtml,
  sendKeyboardMessage as tgSendKeyboardMessage,
  sendMessage as tgSendMessage,
  sendPhoto as tgSendPhoto,
  setMyCommands,
  setWebhook,
  type InlineButton,
} from "./telegram";

export { SessionDO } from "./session";

/** True if this chat is the owner (or if no owner is configured, everyone is owner). */
function isAdmin(env: Env, chatId: number): boolean {
  const owner = env.OWNER_CHAT_ID?.trim();
  if (!owner) return true;
  return String(chatId) === owner;
}

const READ_ONLY_MSG =
  "Read-only mode: you can browse and read, but not add or edit entries. " +
  "Ask the bot owner for write access.";
const URL_RE = /https?:\/\/(?:www\.)?(?:app\.)?notion\.(?:so|com)\/\S+/i;
const DEFAULT_HOME_PAGE_ID = "2823c08b-b705-8081-968a-daeb8dcc4b33";
const DEFAULT_HOME_PAGE_URL = "https://www.notion.so/2823c08bb7058081968adaeb8dcc4b33";

const HELP =
  "How to use:\n" +
  "1. Send a Notion page link.\n" +
  "2. /add to set the title (guided), or /add <text> directly.\n" +
  "3. Send the material: plain text, or a .txt file for long notes.\n" +
  "4. Send audio, then an image (the caption becomes the description).\n" +
  "   Material, audio, and image can be sent in any order after the title.\n" +
  "5. /done to preview, then confirm to build the entry.\n\n" +
  "To read what is already on a page, send /browse (or /browse <link>), then tap an entry.\n" +
  "To search, send /search <keyword> (title + content). Spaces are fine; no quotes needed.\n" +
  "  Optional link: /search <link> <keyword>.\n\n" +
  "Read-only users can browse and read; only the owner can add entries.\n\n" +
  "Commands:\n" +
  "/browse  browse pages and entries, then read one\n" +
  "/search  search sections and pages by keyword\n" +
  "/add  start a new entry (guided title)\n" +
  "/skip  skip the title (auto-generate)\n" +
  "/status  show the current session\n" +
  "/cancel  clear the session\n" +
  "/clearchat  delete the bot's messages in this chat\n" +
  "/done  preview and build the entry\n" +
  "/help  show this message";

/** Shown in Telegram's command menu (also registered via setMyCommands). */
const COMMANDS = [
  { command: "start", description: "How to use the bot" },
  { command: "home", description: "Open the default Notes page" },
  { command: "browse", description: "Browse pages and entries" },
  { command: "search", description: "Search sections and pages" },
  { command: "add", description: "Start a new entry (guided)" },
  { command: "status", description: "Show the current session" },
  { command: "done", description: "Preview and build the entry" },
  { command: "cancel", description: "Clear the current session" },
  { command: "clearchat", description: "Delete the bot's messages in this chat" },
  { command: "help", description: "Show help" },
];

/**
 * Every outbound message goes through these wrappers so its ID can be stored.
 * /clearchat later replays that list through deleteMessage.
 */
async function rememberMessages(
  env: Env,
  chatId: number,
  ids: Array<number | undefined>,
): Promise<void> {
  const list = ids.filter((id): id is number => typeof id === "number" && id > 0);
  if (list.length === 0) return;
  try {
    await sessionCall(env, chatId, { op: "addBotMessages", items: list });
  } catch (error) {
    console.error("remember messages failed", messageOf(error));
  }
}

async function sendMessage(env: Env, chatId: number, text: string): Promise<number[]> {
  const ids = await tgSendMessage(env, chatId, text);
  await rememberMessages(env, chatId, ids);
  return ids;
}

async function sendKeyboardMessage(
  env: Env,
  chatId: number,
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  await rememberMessages(env, chatId, [await tgSendKeyboardMessage(env, chatId, text, buttons)]);
}

async function sendHtml(env: Env, chatId: number, blocks: string[]): Promise<void> {
  await rememberMessages(env, chatId, await tgSendHtml(env, chatId, blocks));
}

async function sendPhoto(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<void> {
  await rememberMessages(env, chatId, [await tgSendPhoto(env, chatId, url, caption)]);
}

async function sendAudio(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<void> {
  await rememberMessages(env, chatId, [await tgSendAudio(env, chatId, url, caption)]);
}

async function sendDocument(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<void> {
  await rememberMessages(env, chatId, [await tgSendDocument(env, chatId, url, caption)]);
}

const AUDIO_UNSUPPORTED =
  "That audio format is not supported by Notion. Send it as mp3, m4a, ogg, wav, or webm.";

interface TgMedia {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  document?: TgMedia;
  photo?: Array<{ file_id: string; file_size?: number }>;
  voice?: TgMedia;
  audio?: TgMedia;
  video?: TgMedia;
  video_note?: TgMedia;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const secret = env.WEBHOOK_SECRET;

    if (request.method === "POST" && url.pathname === `/webhook/${secret}`) {
      let update: TgUpdate;
      try {
        update = (await request.json()) as TgUpdate;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      ctx.waitUntil(
        handleUpdate(env, update).catch((error) => {
          console.error("update failed", error);
          alertOwner(env, "update failed: " + String(error).slice(0, 200)).catch(() => {});
        }),
      );
      return new Response("ok");
    }

    if (url.pathname === `/setup/${secret}`) {
      const target = `${url.origin}/webhook/${secret}`;
      try {
        const result = await setWebhook(env, target);
        // Register the slash-command menu as part of the same one-time setup.
        const commands = await setMyCommands(env, COMMANDS);
        return Response.json({ url: target, result, commands });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    if (url.pathname === `/models/${secret}`) {
      const base = env.AI_BASE_URL.replace(/\/+$/, "");
      try {
        const resp = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${env.AI_API_KEY}` },
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    if (url.pathname === "/") {
      return new Response("tadwin worker is ready");
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;

  if (!(await chatAllowed(env, chatId))) return;

  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (text.startsWith("/")) {
    await handleCommand(env, chatId, text);
    return;
  }
  if (msg.document) {
    await handleDocument(env, chatId, msg);
    return;
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    await handlePhoto(env, chatId, msg);
    return;
  }
  if (msg.voice || msg.audio) {
    await handleAudio(env, chatId, (msg.voice ?? msg.audio)!, Boolean(msg.voice));
    return;
  }
  if (msg.video || msg.video_note) {
    await handleVideo(env, chatId, (msg.video ?? msg.video_note)!);
    return;
  }
  if (text) await handleText(env, chatId, msg);
}

async function chatAllowed(env: Env, chatId: number): Promise<boolean> {
  if (!env.ALLOWED_CHAT_IDS) return true;
  const allowed = env.ALLOWED_CHAT_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  if (allowed.includes(String(chatId))) return true;
  await sendMessage(env, chatId, "Sorry, this bot is private.");
  return false;
}

async function handleCommand(env: Env, chatId: number, text: string): Promise<void> {
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(env, chatId, "Welcome! \u{1F44B}\n\n" + HELP);
      return;

    case "/status": {
      const session = await sessionCall(env, chatId, { op: "get" });
      const chars = session.materials.join("").length;
      await sendMessage(
        env,
        chatId,
        `Page: ${session.pageId ? "set" : "not set"}\n` +
          `Title: ${session.title ?? "(automatic)"}\n` +
          `Material: ${session.materials.length} part(s), ${chars} characters\n` +
          `Audio: ${session.audios.length}\n` +
          `Image: ${session.images.length}`,
      );
      return;
    }

    case "/home":
      await handleBrowse(env, chatId, DEFAULT_HOME_PAGE_URL);
      return;

    // /browse is the one entry point; the old names stay as aliases.
    case "/browse":
    case "/jelajah":
    case "/sections":
    case "/daftar":
    case "/pages":
    case "/halaman": {
      const value = text
        .replace(/^\/(?:browse|jelajah|sections|daftar|pages|halaman)(@\w+)?\s*/i, "")
        .trim();
      await handleBrowse(env, chatId, value);
      return;
    }

    case "/add":
    case "/tambah": {
      if (!isAdmin(env, chatId)) {
        await sendMessage(env, chatId, READ_ONLY_MSG);
        return;
      }
      const value = text.replace(/^\/(?:add|tambah)(@\w+)?\s*/i, "").trim();
      if (value) {
        await sessionCall(env, chatId, { op: "setTitle", title: value });
        await sessionCall(env, chatId, { op: "setAwaitingTitle", value: false });
        await sendMessage(env, chatId, "Title set. Now send material, audio, and image (any order), then /done.");
        return;
      }
      await sessionCall(env, chatId, { op: "setAwaitingTitle", value: true });
      const session = await sessionCall(env, chatId, { op: "get" });
      if (session.title) {
        await sendMessage(env, chatId, "Current title: " + session.title + ". Send a new title, or /skip to keep it.");
      } else {
        await sendMessage(env, chatId, "Step 1: Send the entry title. (Or /skip to auto-generate from material.)");
      }
      return;
    }

    case "/skip": {
      const session = await sessionCall(env, chatId, { op: "get" });
      if (session.awaitingTitle) {
        await sessionCall(env, chatId, { op: "setAwaitingTitle", value: false });
        await sessionCall(env, chatId, { op: "setTitle", title: "" });
        await sendMessage(env, chatId, "Title will be auto-generated. Now send material, audio, and image (any order), then /done.");
        return;
      }
      await sendMessage(env, chatId, "Nothing to skip.");
      return;
    }

    case "/cancel":
    case "/batal":
      await sessionCall(env, chatId, { op: "clear" });
      await sendMessage(env, chatId, "Session cleared. \u{1F5D1}");
      return;

    case "/clearchat":
    case "/bersihkan":
      await handleClearChat(env, chatId);
      return;

    case "/done":
    case "/selesai": {
      if (!isAdmin(env, chatId)) {
        await sendMessage(env, chatId, READ_ONLY_MSG);
        return;
      }
      await handlePreview(env, chatId);
      return;
    }

    case "/search":
    case "/cari": {
      const value = text.replace(/^\/(?:search|cari)(@\w+)?\s*/i, "").trim();
      await handleSearch(env, chatId, value);
      return;
    }

    default:
      await sendMessage(env, chatId, HELP);
  }
}

const BUTTON_LIMIT = 60;
const BUTTONS_PER_PAGE = 8;

function buttonLabel(title: string): string {
  const text = title.replace(/\s+/g, " ").trim() || "Untitled";
  if (text.length <= BUTTON_LIMIT) return text;
  // Long titles share a prefix ("Halaqah 367 - Bab 33 ..."), so keep both ends.
  return `${text.slice(0, 28).trimEnd()}…${text.slice(-28).trimStart()}`;
}

interface ListPage {
  text: string;
  keyboard: InlineButton[][];
}

type ListKind = "sections" | "pages";

const LIST_KIND: Record<
  ListKind,
  { pagePrefix: string; itemPrefix: string; noun: string; hint: string }
> = {
  sections: { pagePrefix: "pg:", itemPrefix: "ret:", noun: "Sections", hint: "Tap one to read it:" },
  pages: { pagePrefix: "pgp:", itemPrefix: "open:", noun: "Pages", hint: "Tap one to open it:" },
};

/** One page of a list: 8 entries, an optional switch row, then Prev / page / Next, then nav. */
function buildListPage(
  items: Array<{ title: string }>,
  page: number,
  kind: ListKind,
  switchTo?: { label: string; data: string },
  flags?: { back?: boolean; home?: boolean },
): ListPage {
  const cfg = LIST_KIND[kind];
  const pages = Math.max(1, Math.ceil(items.length / BUTTONS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const start = safePage * BUTTONS_PER_PAGE;
  const chunk = items.slice(start, start + BUTTONS_PER_PAGE);

  const keyboard: InlineButton[][] = chunk.map((item, offset) => [
    { text: buttonLabel(item.title), callback_data: `${cfg.itemPrefix}${start + offset}` },
  ]);

  if (switchTo) {
    keyboard.push([{ text: switchTo.label, callback_data: switchTo.data }]);
  }

  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({ text: "◀ Prev", callback_data: `${cfg.pagePrefix}${safePage - 1}` });
  }
  nav.push({ text: `${safePage + 1}/${pages}`, callback_data: "cur" });
  if (safePage < pages - 1) {
    nav.push({ text: "Next ▶", callback_data: `${cfg.pagePrefix}${safePage + 1}` });
  }
  keyboard.push(nav);

  const extra: InlineButton[] = [];
  if (flags?.back) extra.push({ text: "◀ Back", callback_data: "back" });
  if (flags?.home) extra.push({ text: "🏠 Home", callback_data: "home" });
  if (extra.length) keyboard.push(extra);

  return {
    text: `${cfg.noun} (${items.length}) — page ${safePage + 1}/${pages}\n${cfg.hint}`,
    keyboard,
  };
}

const CLEAR_CHAT_COOLDOWN_MS = 30_000;
const DONE_COOLDOWN_MS = 10_000;
const MAX_MATERIAL_CHARS = 100_000;
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

async function lastClearChat(env: Env, chatId: number): Promise<number> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  const resp = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "getLastClearChat" }),
  });
  if (!resp.ok) return 0;
  const data = (await resp.json()) as unknown;
  return typeof data === "number" ? data : 0;
}

async function setLastClearChat(env: Env, chatId: number, value: number): Promise<void> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "setLastClearChat", value }),
  });
}

async function lastDone(env: Env, chatId: number): Promise<number> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  const resp = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "getLastDone" }),
  });
  if (!resp.ok) return 0;
  const data = (await resp.json()) as unknown;
  return typeof data === "number" ? data : 0;
}

async function setLastDone(env: Env, chatId: number, value: number): Promise<void> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "setLastDone", value }),
  });
}

async function sendNavButtons(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const row: InlineButton[] = [];
  const backAvail =
    session.listKind !== null ||
    (session.navStack?.length ?? 0) > 0 ||
    (session.homePageId !== null && session.pageId !== session.homePageId);
  const homeAvail = session.homePageId !== null && session.pageId !== session.homePageId;
  if (backAvail) row.push({ text: "Back", callback_data: "back" });
  if (homeAvail) row.push({ text: "Home", callback_data: "home" });
  if (row.length === 0) return;
  await sendKeyboardMessage(env, chatId, "Navigation", [row]);
}

﻿async function lastAlert(env: Env, chatId: number): Promise<number> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  const resp = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "getLastAlert" }),
  });
  if (!resp.ok) return 0;
  const data = (await resp.json()) as unknown;
  return typeof data === "number" ? data : 0;
}

async function setLastAlert(env: Env, chatId: number, value: number): Promise<void> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "setLastAlert", value }),
  });
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

async function alertOwner(env: Env, text: string): Promise<void> {
  const owner = env.OWNER_CHAT_ID?.trim();
  if (!owner) return;
  const ownerId = Number(owner);
  if (!Number.isFinite(ownerId)) return;

  const last = await lastAlert(env, ownerId);
  const now = Date.now();
  if (now - last < ALERT_COOLDOWN_MS) return;
  await setLastAlert(env, ownerId, now);

  const short = text.slice(0, 300);
  try {
    await tgSendMessage(env, ownerId, `Alert: ${short}`);
  } catch (error) {
    console.error("alertOwner failed", error);
  }
}

/** Read the stored bot message IDs without pretending they are a session object. */
async function botMessages(env: Env, chatId: number): Promise<number[]> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  const resp = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ op: "getBotMessages" }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? data.filter((value): value is number => typeof value === "number") : [];
}

/**
 * Delete the bot's own messages in this chat. Telegram only lets a bot delete
 * messages it sent, and only within 48 hours, so older ones are counted as
 * skipped rather than retried forever.
 */
async function handleClearChat(env: Env, chatId: number): Promise<void> {
  const ids = await botMessages(env, chatId);
  if (ids.length === 0) {
    await sendMessage(env, chatId, "Nothing to clear in this chat.");
    return;
  }

  const last = await lastClearChat(env, chatId);
  const now = Date.now();
  if (now - last < CLEAR_CHAT_COOLDOWN_MS) {
    const wait = Math.ceil((CLEAR_CHAT_COOLDOWN_MS - (now - last)) / 1000);
    await sendMessage(env, chatId, `Please wait ${wait} seconds before clearing again.`);
    return;
  }
  await setLastClearChat(env, chatId, now);

  const started = Date.now();
  let deleted = 0;
  let skipped = 0;
  let index = 0;

  for (; index < ids.length; index++) {
    // ctx.waitUntil is about 30 s; stop early so the report still gets through.
    if (Date.now() - started > 20000) break;
    try {
      await deleteMessage(env, chatId, ids[index]);
      deleted++;
    } catch {
      skipped++;
    }
  }

  const remaining = ids.slice(index);
  await sessionCall(env, chatId, { op: "clearBotMessages" });
  if (remaining.length > 0) {
    await sessionCall(env, chatId, { op: "addBotMessages", items: remaining });
  }

  const parts = [`Deleted ${deleted} message(s).`];
  if (skipped > 0) parts.push(`${skipped} could not be deleted (older than 48 hours).`);
  if (remaining.length > 0) parts.push(`${remaining.length} left, send /clearchat again.`);
  await sendMessage(env, chatId, parts.join(" "));
}

/** The one browse entry point: read a page and show whatever it contains. */
async function handleBrowse(env: Env, chatId: number, arg: string): Promise<void> {
  let pageId: string | null = null;

  if (arg) {
    const match = arg.match(URL_RE);
    try {
      pageId = parsePageId(match ? match[0] : arg);
    } catch {
      await sendMessage(env, chatId, "That Notion link is not valid.");
      return;
    }
  } else {
    const session = await sessionCall(env, chatId, { op: "get" });
    pageId = session.pageId;
  }

  if (!pageId) {
    pageId = DEFAULT_HOME_PAGE_ID;
  }

  await sessionCall(env, chatId, {
    op: "setPage",
    pageId,
    pageUrl: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
  });
  await sessionCall(env, chatId, { op: "setHome", homePageId: pageId });
  await sessionCall(env, chatId, { op: "setNavStack", items: [] });

  await browsePage(env, chatId, pageId);
}

/** Open a child page: make it the session page, then browse it. */
async function openPage(
  env: Env,
  chatId: number,
  index: number,
  listMessageId?: number,
): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const page = session.pages[index];
  if (!page) {
    await sendMessage(env, chatId, "That list has expired. Send /browse again.");
    return;
  }

  if (listMessageId) {
    try {
      await deleteMessage(env, chatId, listMessageId);
    } catch (error) {
      console.error("delete list failed", messageOf(error));
    }
  }

  const stack = [...(session.navStack ?? [])];
  if (session.pageId) stack.push(session.pageId);
  await sessionCall(env, chatId, { op: "setNavStack", items: stack });

  await sessionCall(env, chatId, {
    op: "setPage",
    pageId: page.id,
    pageUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  });
  await sendMessage(env, chatId, `Opened: ${page.title} \u{1F4C4}`);

  // Drill down: sections first, then child pages, then the page's own content.
  await browsePage(env, chatId, page.id);
}

/**
 * Show whatever a page contains: toggle sections, else child pages, else content.
 * When both sections and child pages exist, sections win and a switch row is added.
 */
async function browsePage(env: Env, chatId: number, pageId: string): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const homePageId = session.homePageId;
  const navStack = session.navStack ?? [];
  const backAvail = navStack.length > 0 || (homePageId !== null && pageId !== homePageId);
  const homeAvail = homePageId !== null && pageId !== homePageId;
  const flags = { back: backAvail, home: homeAvail };

  let sections: SectionRef[];
  let pages: PageRef[];
  try {
    ({ sections, pages } = await listPageContent(env, pageId));
  } catch (error) {
    console.error("read page failed", error);
    await sendMessage(env, chatId, "Could not read that page. See logs for details.");
    return;
  }

  await sessionCall(env, chatId, {
    op: sections.length ? "setSections" : "clearSections",
    pageId,
    items: sections,
  });
  await sessionCall(env, chatId, {
    op: pages.length ? "setPages" : "clearPages",
    pageId,
    items: pages,
  });

  if (sections.length) {
    await sessionCall(env, chatId, { op: "setListState", kind: "sections", page: 0 });
    const built = buildListPage(sections, 0, "sections", switchFor("sections", pages.length), flags);
    await sendKeyboardMessage(env, chatId, built.text, built.keyboard);
    return;
  }

  if (pages.length) {
    await sessionCall(env, chatId, { op: "setListState", kind: "pages", page: 0 });
    const built = buildListPage(pages, 0, "pages", undefined, flags);
    await sendKeyboardMessage(env, chatId, built.text, built.keyboard);
    return;
  }

  let content: SectionContent;
  try {
    content = await getSectionContent(env, pageId);
  } catch (error) {
    console.error("read page failed", error);
    await sendMessage(env, chatId, "Could not read that page. See logs for details.");
    return;
  }
  await sendContent(env, chatId, content);
  await sendNavButtons(env, chatId);
}

/** The "show me the other kind" row, or undefined when there is nothing to switch to. */
function switchFor(
  current: ListKind,
  otherCount: number,
): { label: string; data: string } | undefined {
  if (otherCount === 0) return undefined;
  if (current === "sections") {
    return { label: `Pages (${otherCount})`, data: "mode:pages" };
  }
  return { label: `Sections (${otherCount})`, data: "mode:sections" };
}

async function handleBack(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const stack = [...(session.navStack ?? [])];

  if (stack.length > 0) {
    const parent = stack.pop() as string;
    await sessionCall(env, chatId, { op: "setNavStack", items: stack });
    await sessionCall(env, chatId, {
      op: "setPage",
      pageId: parent,
      pageUrl: `https://www.notion.so/${parent.replace(/-/g, "")}`,
    });
    await browsePage(env, chatId, parent);
    return;
  }

  if (session.homePageId && session.pageId !== session.homePageId) {
    await sessionCall(env, chatId, { op: "setNavStack", items: [] });
    await sessionCall(env, chatId, {
      op: "setPage",
      pageId: session.homePageId,
      pageUrl: `https://www.notion.so/${session.homePageId.replace(/-/g, "")}`,
    });
    await browsePage(env, chatId, session.homePageId);
    return;
  }

  if (session.pageId) {
    await browsePage(env, chatId, session.pageId);
  }
}

async function handleHome(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const home = session.homePageId ?? session.pageId;
  if (!home) {
    await sendMessage(env, chatId, "No page browsed yet.");
    return;
  }
  await sessionCall(env, chatId, { op: "setNavStack", items: [] });
  await sessionCall(env, chatId, {
    op: "setPage",
    pageId: home,
    pageUrl: `https://www.notion.so/${home.replace(/-/g, "")}`,
  });
  await browsePage(env, chatId, home);
}

async function handleSearch(env: Env, chatId: number, arg: string): Promise<void> {
  // Optional link prefix: "/search <link> <keyword>".
  let pageId: string | null = null;
  let keyword = arg.trim();
  const linkMatch = arg.match(URL_RE);
  if (linkMatch) {
    try {
      pageId = parsePageId(linkMatch[0]);
      keyword = arg.replace(linkMatch[0], "").trim();
    } catch {
      await sendMessage(env, chatId, "That Notion link is not valid.");
      return;
    }
  }

  // Strip surrounding quotes so "/search \"foo bar\"" works.
  keyword = keyword.replace(/^["'](.*)["']$/, "$1").trim();

  if (!keyword) {
    await sendMessage(env, chatId, "Usage: /search <keyword>  (or /search <link> <keyword>)");
    return;
  }

  if (!pageId) {
    const session = await sessionCall(env, chatId, { op: "get" });
    pageId = session.pageId ?? DEFAULT_HOME_PAGE_ID;
  }

  const lower = keyword.toLowerCase();

  let sections: SectionRef[];
  let pages: PageRef[];
  try {
    ({ sections, pages } = await listPageContent(env, pageId));
  } catch (error) {
    console.error("read page failed", error);
    await sendMessage(env, chatId, "Could not read that page. See logs for details.");
    return;
  }
  await sessionCall(env, chatId, { op: sections.length ? "setSections" : "clearSections", pageId, items: sections });
  await sessionCall(env, chatId, { op: pages.length ? "setPages" : "clearPages", pageId, items: pages });

  // Title matches are instant (no extra fetches).
  const titleSecIdx = sections
    .map((s, i) => (s.title.toLowerCase().includes(lower) ? i : -1))
    .filter((i) => i >= 0);
  const titlePagIdx = pages
    .map((p, i) => (p.title.toLowerCase().includes(lower) ? i : -1))
    .filter((i) => i >= 0);

  if (titleSecIdx.length || titlePagIdx.length) {
    const keyboard: InlineButton[][] = [];
    for (const i of titleSecIdx) keyboard.push([{ text: buttonLabel(sections[i].title), callback_data: `ret:${i}` }]);
    for (const i of titlePagIdx) keyboard.push([{ text: buttonLabel(pages[i].title), callback_data: `open:${i}` }]);
    await sendKeyboardMessage(
      env,
      chatId,
      `Search "${keyword}" - title matches: ${titleSecIdx.length} section(s), ${titlePagIdx.length} page(s)`,
      keyboard,
    );
  }

  // Content search: fetch in small batches to avoid Notion rate limits.
  const cap = 15;
  const secToCheck = sections.slice(0, cap);
  const pagToCheck = pages.slice(0, cap);

  async function batched(items: any[], fn: (x: any) => Promise<any>) {
    const out: any[] = [];
    const size = 5;
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      const res = await Promise.allSettled(chunk.map(fn));
      out.push(...res);
      if (i + size < items.length) await new Promise((r) => setTimeout(r, 150));
    }
    return out;
  }

  const contentSecIdx: number[] = [];
  const secResults = await batched(secToCheck, (s) => getSectionContent(env, s.id));
  secResults.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const c = r.value;
    const haystack = (c.html ?? []).join("\n").toLowerCase();
    if (haystack.includes(lower) && !titleSecIdx.includes(i)) contentSecIdx.push(i);
  });

  if (contentSecIdx.length) {
    const keyboard: InlineButton[][] = [];
    for (const i of contentSecIdx) keyboard.push([{ text: buttonLabel(sections[i].title), callback_data: `ret:${i}` }]);
    await sendKeyboardMessage(
      env,
      chatId,
      `Search "${keyword}" - also in content: ${contentSecIdx.length} section(s)`,
      keyboard,
    );
  }

  if (!titleSecIdx.length && !titlePagIdx.length && !contentSecIdx.length) {
    await sendMessage(env, chatId, `No matches for "${keyword}".`);
  }
}

async function handleCallback(env: Env, query: TgCallbackQuery): Promise<void> {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  if (!(await chatAllowed(env, chatId))) {
    await answerCallbackQuery(env, query.id);
    return;
  }

  const data = query.data ?? "";

  if (data === "cur") {
    await answerCallbackQuery(env, query.id);
    return;
  }

  if (data === "back" || data === "home") {
    if (query.message?.message_id) {
      try {
        await deleteMessage(env, chatId, query.message.message_id);
      } catch (error) {
        console.error("delete list failed", messageOf(error));
      }
    }
    await answerCallbackQuery(env, query.id);
    if (data === "back") await handleBack(env, chatId);
    else await handleHome(env, chatId);
    return;
  }

  if (data === "mode:raw" || data === "mode:ai") {
    if (query.message?.message_id) {
      try { await deleteMessage(env, chatId, query.message.message_id); } catch (error) { console.error("delete list failed", messageOf(error)); }
    }
    await sessionCall(env, chatId, { op: "setSummaryMode", value: data === "mode:raw" ? "raw" : "ai" });
    await answerCallbackQuery(env, query.id);
    await handlePreview(env, chatId);
    return;
  }

  if (data.startsWith("mode:")) {
    const kind = data.slice(5) === "pages" ? "pages" : "sections";
    await answerCallbackQuery(env, query.id);
    await renderList(env, chatId, query.message?.message_id, kind, 0);
    return;
  }

  if (data === "confirm:done") {
    if (query.message?.message_id) {
      try { await deleteMessage(env, chatId, query.message.message_id); } catch (error) { console.error("delete list failed", messageOf(error)); }
    }
    await answerCallbackQuery(env, query.id, "Building...");
    await handleConfirmDone(env, chatId);
    return;
  }

  if (data === "edit:title") {
    if (query.message?.message_id) {
      try { await deleteMessage(env, chatId, query.message.message_id); } catch (error) { console.error("delete list failed", messageOf(error)); }
    }
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: "title" });
    await answerCallbackQuery(env, query.id);
    await sendMessage(env, chatId, "Send the new title (supports **bold** / *italic*):");
    return;
  }

  if (data === "edit:material") {
    if (query.message?.message_id) {
      try { await deleteMessage(env, chatId, query.message.message_id); } catch (error) { console.error("delete list failed", messageOf(error)); }
    }
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: "material" });
    await answerCallbackQuery(env, query.id);
    await sendMessage(env, chatId, "Send the new material (text or a .txt file):");
    return;
  }

  if (data === "cancel:preview") {
    if (query.message?.message_id) {
      try { await deleteMessage(env, chatId, query.message.message_id); } catch (error) { console.error("delete list failed", messageOf(error)); }
    }
    await sessionCall(env, chatId, { op: "clearPendingBlocks" });
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: null });
    await answerCallbackQuery(env, query.id);
    await sendMessage(env, chatId, "Cancelled.");
    return;
  }

  if (data.startsWith("pgp:")) {
    const page = Number(data.slice(4));
    await answerCallbackQuery(env, query.id);
    await renderList(env, chatId, query.message?.message_id, "pages", page);
    return;
  }

  if (data.startsWith("pg:")) {
    const page = Number(data.slice(3));
    await answerCallbackQuery(env, query.id);
    await renderList(env, chatId, query.message?.message_id, "sections", page);
    return;
  }

  if (data.startsWith("open:")) {
    const index = Number(data.slice(5));
    if (!Number.isInteger(index) || index < 0) {
      await answerCallbackQuery(env, query.id, "Unknown page.");
      return;
    }
    await answerCallbackQuery(env, query.id, "Opening…");
    await openPage(env, chatId, index, query.message?.message_id);
    return;
  }

  const index = Number(data.startsWith("ret:") ? data.slice(4) : NaN);
  if (!Number.isInteger(index) || index < 0) {
    await answerCallbackQuery(env, query.id, "Unknown entry.");
    return;
  }

  await answerCallbackQuery(env, query.id, "Loading…");
  await retrieveSection(env, chatId, index, query.message?.message_id);
}

/** Re-render a list in place; fall back to a new message if it is gone. */
async function renderList(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  kind: ListKind,
  page: number,
): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const items = kind === "sections" ? session.sections : session.pages;
  const otherCount = kind === "sections" ? session.pages.length : session.sections.length;
  const homePageId = session.homePageId;
  const navStack = session.navStack ?? [];
  const backAvail = navStack.length > 0 || (homePageId !== null && session.pageId !== homePageId);
  const homeAvail = homePageId !== null && session.pageId !== homePageId;
  const flags = { back: backAvail, home: homeAvail };

  if (items.length === 0) {
    await sendMessage(env, chatId, "That list has expired. Send /browse again.");
    return;
  }

  await sessionCall(env, chatId, { op: "setListState", kind, page });

  const built = buildListPage(items, page, kind, switchFor(kind, otherCount), flags);
  if (!messageId) {
    await sendKeyboardMessage(env, chatId, built.text, built.keyboard);
    return;
  }
  try {
    await editMessageText(env, chatId, messageId, built.text, built.keyboard);
  } catch (error) {
    console.error("edit page failed", messageOf(error));
    await sendKeyboardMessage(env, chatId, built.text, built.keyboard);
  }
}

/** Send one section back to Telegram: audio, image, then the formatted text. */
async function retrieveSection(
  env: Env,
  chatId: number,
  index: number,
  listMessageId?: number,
): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const section = session.sections[index];
  if (!section) {
    await sendMessage(env, chatId, "That list has expired. Send /browse again.");
    return;
  }

  // The pick is done: drop the list bubble so the chat stays clean.
  if (listMessageId) {
    try {
      await deleteMessage(env, chatId, listMessageId);
    } catch (error) {
      console.error("delete list failed", messageOf(error));
    }
  }

  await sendMessage(env, chatId, `Reading: ${section.title}`);

  let content: SectionContent;
  try {
    content = await getSectionContent(env, section.id);
  } catch (error) {
    console.error("read entry failed", error);
    await sendMessage(env, chatId, "Could not read that entry. See logs for details.");
    return;
  }

  await sendContent(env, chatId, content);
  await sendNavButtons(env, chatId);
}

/** Audio, then image, then the formatted text for one block or page. */
async function sendContent(
  env: Env,
  chatId: number,
  content: SectionContent,
): Promise<void> {
  for (const audio of content.audios) {
    const url = audio.url;
    if (!url) {
      await sendMessage(env, chatId, "Audio: no link available.");
      continue;
    }
    if (await trySend(() => sendAudio(env, chatId, url, audio.caption))) continue;
    if (await trySend(() => sendDocument(env, chatId, url, audio.caption))) continue;
    await sendMessage(env, chatId, `Audio: ${url}`);
  }

  for (const image of content.images) {
    const url = image.url;
    if (!url) {
      await sendMessage(env, chatId, "Image: no link available.");
      continue;
    }
    if (await trySend(() => sendPhoto(env, chatId, url, image.caption))) continue;
    if (await trySend(() => sendDocument(env, chatId, url, image.caption))) continue;
    await sendMessage(env, chatId, `Image: ${url}`);
  }

  if (content.html.length > 0) {
    await sendHtml(env, chatId, content.html);
  } else if (content.audios.length === 0 && content.images.length === 0) {
    await sendMessage(env, chatId, "That entry is empty.");
  }
}

/** Media URLs from Notion can fail (expired signature); fall back to a link. */
async function trySend(send: () => Promise<void>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    console.error("media send failed", messageOf(error));
    return false;
  }
}

async function handleText(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  const raw = typeof msg.text === "string" ? msg.text.trim() : "";
  // Telegram sends formatting as entities, not as characters.
  const text = entitiesToMarkdown(raw, msg.entities);

  const session = await sessionCall(env, chatId, { op: "get" });

  if (session.awaitingTitle) {
    await sessionCall(env, chatId, { op: "setTitle", title: text });
    await sessionCall(env, chatId, { op: "setAwaitingTitle", value: false });
    await sendMessage(env, chatId, "Title set. Now send material, audio, and image (any order), then /done.");
    return;
  }

  if (!isAdmin(env, chatId) && !raw.match(URL_RE)) {
    await sendMessage(env, chatId, READ_ONLY_MSG);
    return;
  }

  if (session.awaitingEdit === "title") {
    await sessionCall(env, chatId, { op: "setTitle", title: text });
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: null });
    await sendMessage(env, chatId, "Title updated.");
    await handlePreview(env, chatId);
    return;
  }
  if (session.awaitingEdit === "material") {
    await sessionCall(env, chatId, { op: "clearMaterials" });
    await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: null });
    await sendMessage(env, chatId, "Material updated (" + text.length + " characters).");
    await handlePreview(env, chatId);
    return;
  }

  const match = raw.match(URL_RE);
  if (match) {
    try {
      const pageId = parsePageId(match[0]);
      await sessionCall(env, chatId, { op: "setPage", pageId, pageUrl: match[0] });
    } catch {
      await sendMessage(env, chatId, "That Notion link is not valid.");
      return;
    }
    await sendMessage(env, chatId, "Page link received. \u{1F4C4}");
    return;
  }

  if (text.length > MAX_MATERIAL_CHARS) {
    await sendMessage(
      env,
      chatId,
      `That material is too long (${text.length} characters). Limit is ${MAX_MATERIAL_CHARS}.`,
    );
    return;
  }

  await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
  await sendMessage(env, chatId, `Material received (${raw.length} characters). \u{1F4DD}`);
}

async function handleDocument(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env, chatId, READ_ONLY_MSG);
    return;
  }
  const doc = msg.document!;
  const name = doc.file_name ?? "file";
  const mime = doc.mime_type ?? "";
  const ext = extOf(name);

  if (mime.startsWith("text/") || TEXT_EXT.has(ext)) {
    try {
      const file = await downloadFile(env, doc.file_id);
      if (file.size > MAX_TEXT_FILE_BYTES) {
        await sendMessage(env, chatId, `That file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is 5 MB.`);
        return;
      }
      const text = decodeText(file.bytes).trim();
      if (!text) {
        await sendMessage(env, chatId, "That text file is empty.");
        return;
      }
      if (text.length > MAX_MATERIAL_CHARS) {
        await sendMessage(env, chatId, `That file is too long (${text.length} characters). Limit is ${MAX_MATERIAL_CHARS}.`);
        return;
      }

      const sess = await sessionCall(env, chatId, { op: "get" });
      if (sess.awaitingEdit === "material") {
        await sessionCall(env, chatId, { op: "clearMaterials" });
        await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
        await sessionCall(env, chatId, { op: "setAwaitingEdit", value: null });
        await sendMessage(env, chatId, "Material updated from file (" + text.length + " characters).");
        await handlePreview(env, chatId);
        return;
      }

      await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
      await sendMessage(
        env,
        chatId,
        `Material received from file (${text.length} characters). \u{1F4C4}`,
      );
    } catch (error) {
      console.error("read file failed", error);
      await sendMessage(env, chatId, "Could not read that file. See logs for details.");
    }
    return;
  }

  if ([".pdf", ".doc", ".docx", ".rtf", ".odt"].includes(ext)) {
    await sendMessage(
      env,
      chatId,
      "That file format is not supported yet. Save the material as .txt and send it again.",
    );
    return;
  }

  if (mime.startsWith("image/")) {
    await sessionCall(env, chatId, {
      op: "push",
      field: "images",
      value: {
        fileId: doc.file_id,
        name,
        mime,
        caption: entitiesToMarkdown(msg.caption ?? "", msg.caption_entities),
      },
    });
    await sendMessage(env, chatId, "Image received. \u{1F5BC}");
    return;
  }

  const upload = audioUpload(name, mime);
  if (!upload) {
    await sendMessage(env, chatId, AUDIO_UNSUPPORTED);
    return;
  }
  await sessionCall(env, chatId, {
    op: "push",
    field: "audios",
    value: {
      fileId: doc.file_id,
      name: upload.filename,
      mime: upload.contentType,
      rawMime: mime,
    },
  });
  await sendMessage(env, chatId, "Audio received. \u{1F3A7}");
}

async function handlePhoto(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env, chatId, READ_ONLY_MSG);
    return;
  }
  const photo = msg.photo![msg.photo!.length - 1];
  await sessionCall(env, chatId, {
    op: "push",
    field: "images",
    value: {
      fileId: photo.file_id,
      name: "image.jpg",
      mime: "image/jpeg",
      caption: entitiesToMarkdown(msg.caption ?? "", msg.caption_entities),
    },
  });
  await sendMessage(env, chatId, "Image received. \u{1F5BC}");
}

async function handleAudio(
  env: Env,
  chatId: number,
  media: TgMedia,
  isVoice: boolean,
): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env, chatId, READ_ONLY_MSG);
    return;
  }
  const rawMime = media.mime_type ?? "";
  const name = media.file_name ?? (isVoice ? "audio.ogg" : "audio.mp3");
  const upload = audioUpload(name, rawMime);
  if (!upload) {
    await sendMessage(env, chatId, AUDIO_UNSUPPORTED);
    return;
  }
  await sessionCall(env, chatId, {
    op: "push",
    field: "audios",
    value: {
      fileId: media.file_id,
      name: upload.filename,
      mime: upload.contentType,
      rawMime,
    },
  });
  await sendMessage(env, chatId, "Audio received. \u{1F3A7}");
}

async function handleVideo(env: Env, chatId: number, media: TgMedia): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env, chatId, READ_ONLY_MSG);
    return;
  }
  const rawMime = media.mime_type ?? "video/mp4";
  const name = media.file_name ?? "audio.mp4";
  const upload = audioUpload(name, rawMime);
  if (!upload) {
    await sendMessage(env, chatId, AUDIO_UNSUPPORTED);
    return;
  }
  await sessionCall(env, chatId, {
    op: "push",
    field: "audios",
    value: {
      fileId: media.file_id,
      name: upload.filename,
      mime: upload.contentType,
      rawMime,
    },
  });
  await sendMessage(env, chatId, "Audio received. \u{1F3A7}");
}

async function handlePreview(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  if (!session.pageId) {
    await sendMessage(env, chatId, "No Notion page link yet.");
    return;
  }
  if (session.materials.length === 0) {
    await sendMessage(env, chatId, "No text material yet.");
    return;
  }

  const material = session.materials.join("\n\n").trim();
  const title = session.title?.trim() || extractTitle(material);
  const mode = session.summaryMode === "raw" ? "raw" : "ai";

  await sendMessage(env, chatId, "Preparing preview...");

  try {
    const references = await findToggleExamples(env, session.pageId);
    if (references.length === 0) {
      await sendMessage(
        env,
        chatId,
        "This page has no example entry (toggle heading) yet. " +
          "Add one so the format can be copied, then run /done again.",
      );
      return;
    }

    let blocks: Block[];
    if (mode === "raw") {
      blocks = markdownToBlocks(material);
    } else {
      blocks = await formatMaterial(env, material, title, references);
    }

    await sessionCall(env, chatId, { op: "setPendingBlocks", items: blocks });
    await sessionCall(env, chatId, { op: "setAwaitingEdit", value: null });

    const typeCounts: Record<string, number> = {};
    for (const b of blocks) {
      const t = (b as { type?: string }).type ?? "paragraph";
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const summary = Object.entries(typeCounts)
      .map(([t, n]) => `${t} x${n}`)
      .join(", ");

    const audioCount = session.audios.length;
    const imageCount = session.images.length;

    const modeLabel = mode === "raw" ? "Raw (tanpa AI)" : "Ringkas (AI)";
    const previewText =
      "Preview [" + modeLabel + "]\n" +
      `Title: ${title}\n` +
      `Material: ${material.length} chars\n` +
      `Audio: ${audioCount}  Image: ${imageCount}\n` +
      `Blocks: ${blocks.length} (${summary})`;

    const toggleBtn =
      mode === "raw"
        ? { text: "Ringkas (AI)", callback_data: "mode:ai" }
        : { text: "Raw (tanpa AI)", callback_data: "mode:raw" };

    const buttons: InlineButton[][] = [
      [
        { text: "Send", callback_data: "confirm:done" },
        { text: "Edit title", callback_data: "edit:title" },
        { text: "Edit material", callback_data: "edit:material" },
      ],
      [toggleBtn, { text: "Cancel", callback_data: "cancel:preview" }],
    ];

    await sendKeyboardMessage(env, chatId, previewText, buttons);
  } catch (error) {
    console.error("handlePreview failed", error);
    await alertOwner(env, "handlePreview: " + String(error).slice(0, 200));
    let message = messageOf(error).slice(0, 200);
    await sendMessage(env, chatId, `Failed: ${message}`);
  }
}

async function handleConfirmDone(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  if (!session.pageId) {
    await sendMessage(env, chatId, "No Notion page link yet.");
    return;
  }
  if (session.materials.length === 0) {
    await sendMessage(env, chatId, "No text material yet.");
    return;
  }

  const last = await lastDone(env, chatId);
  const now = Date.now();
  if (now - last < DONE_COOLDOWN_MS) {
    const wait = Math.ceil((DONE_COOLDOWN_MS - (now - last)) / 1000);
    await sendMessage(env, chatId, `Please wait ${wait} seconds before running /done again.`);
    return;
  }
  await setLastDone(env, chatId, now);

  const material = session.materials.join("\n\n").trim();
  const title = session.title?.trim() || extractTitle(material);

  const progressIds = await sendMessage(env, chatId, "Building entry...");
  const progressId = progressIds[0];
  async function setProgress(text: string): Promise<void> {
    if (!progressId) return;
    try {
      await editMessageText(env, chatId, progressId, text);
    } catch (error) {
      console.error("progress edit failed", error);
    }
  }

  try {
    const references = await findToggleExamples(env, session.pageId);
    if (references.length === 0) {
      await setProgress("No example entry found.");
      await sendMessage(
        env,
        chatId,
        "This page has no example entry (toggle heading) yet. " +
          "Add one so the format can be copied, then run /done again.",
      );
      return;
    }

    await setProgress("Formatting material...");
    let blocks: Block[];
    const pending = session.pendingBlocks;
    if (Array.isArray(pending) && pending.length > 0) {
      blocks = pending as Block[];
    } else {
      blocks = await formatMaterial(env, material, title, references);
    }

    await setProgress("Uploading media...");
    const audioPromise = (async (): Promise<string | null> => {
      if (session.audios.length === 0) return null;
      const audio = session.audios[0];
      const file = await downloadFile(env, audio.fileId);
      return uploadFile(env, audio.name, audio.mime, file.bytes);
    })();

    const imagePromise = (async (): Promise<string | null> => {
      if (session.images.length === 0) return null;
      const image = session.images[0];
      const file = await downloadFile(env, image.fileId);
      return uploadFile(env, image.name, image.mime, file.bytes);
    })();

    const [audioUploadId, imageUploadId] = await Promise.all([audioPromise, imagePromise]);

    await setProgress("Writing to Notion...");
    const imageCaption = session.images[0]?.caption ?? "";

    await appendEntry(
      env,
      session.pageId,
      title,
      audioUploadId,
      imageUploadId,
      imageCaption,
      blocks,
    );

    await setProgress("Done.");
    await sendMessage(
      env,
      chatId,
      `Added to the page.\n${session.pageUrl ?? ""} \u2705`,
    );
    await sessionCall(env, chatId, { op: "clear" });
  } catch (error) {
    console.error("handleConfirmDone failed", error);
    await alertOwner(env, "handleConfirmDone: " + String(error).slice(0, 200));
    await setProgress("Failed.");
    let message = messageOf(error).slice(0, 200);
    if (/file size|size limit|too large|exceed/i.test(message)) {
      message += "\n\nNote: the Notion Free plan limits files to 5 MB.";
    }
    await sendMessage(env, chatId, `Failed: ${message}`);
  }
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sessionCall(
  env: Env,
  chatId: number,
  body: Record<string, unknown>,
): Promise<SessionState> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`chat:${chatId}`));
  const resp = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!resp.ok) return emptyState();
  return (await resp.json()) as SessionState;
}
