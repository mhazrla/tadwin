import { formatMaterial } from "./ai";
import type { Env } from "./env";
import {
  audioUpload,
  decodeText,
  extOf,
  extractTitle,
  parsePageId,
  TEXT_EXT,
} from "./format";
import {
  appendEntry,
  findToggleExamples,
  getSectionContent,
  listSections,
  uploadFile,
  type SectionContent,
} from "./notion";
import { entitiesToMarkdown } from "./markdown";
import { emptyState, type SectionRef, type SessionState } from "./session";
import {
  answerCallbackQuery,
  downloadFile,
  sendAudio,
  sendDocument,
  sendHtml,
  sendKeyboardMessage,
  sendMessage,
  sendPhoto,
  setMyCommands,
  setWebhook,
} from "./telegram";

export { SessionDO } from "./session";

const URL_RE = /https?:\/\/(?:www\.)?(?:app\.)?notion\.(?:so|com)\/\S+/i;

const HELP =
  "How to use:\n" +
  "1. Send a Notion page link.\n" +
  "2. (Optional) /title <text> to set the entry title.\n" +
  "3. Send the material: plain text, or a .txt file for long notes.\n" +
  "4. Send audio, then an image (the caption becomes the description).\n" +
  "5. /done to build the entry.\n\n" +
  "To read what is already on a page, send /sections (or /sections <link>), then tap an entry.\n\n" +
  "Commands:\n" +
  "/sections  browse existing entries and read one\n" +
  "/title  set the entry title\n" +
  "/status  show the current session\n" +
  "/cancel  clear the session\n" +
  "/done  build the entry in Notion\n" +
  "/help  show this message";

/** Shown in Telegram's command menu (also registered via setMyCommands). */
const COMMANDS = [
  { command: "start", description: "How to use the bot" },
  { command: "sections", description: "Browse and read existing entries" },
  { command: "title", description: "Set the entry title" },
  { command: "status", description: "Show the current session" },
  { command: "done", description: "Build the entry in Notion" },
  { command: "cancel", description: "Clear the current session" },
  { command: "help", description: "Show help" },
];

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
        handleUpdate(env, update).catch((error) => console.error("update failed", error)),
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

    // Indonesian aliases are kept so older habits keep working.
    case "/sections":
    case "/daftar": {
      const value = text.replace(/^\/(?:sections|daftar)(@\w+)?\s*/i, "").trim();
      await handleSections(env, chatId, value);
      return;
    }

    case "/title":
    case "/judul": {
      const value = text.replace(/^\/(?:title|judul)(@\w+)?\s*/i, "").trim();
      if (!value) {
        const session = await sessionCall(env, chatId, { op: "get" });
        await sendMessage(
          env,
          chatId,
          session.title
            ? `Current title: ${session.title}\nChange it with /title <new text>`
            : "No manual title yet. Send /title <text>, or let it default to the first line of the material.",
        );
        return;
      }
      await sessionCall(env, chatId, { op: "setTitle", title: value });
      await sendMessage(env, chatId, `Entry title set: ${value} \u{1F3F7}`);
      return;
    }

    case "/cancel":
    case "/batal":
      await sessionCall(env, chatId, { op: "clear" });
      await sendMessage(env, chatId, "Session cleared. \u{1F5D1}");
      return;

    case "/done":
    case "/selesai":
      await sendMessage(env, chatId, "Processing... \u23F3");
      await processEntry(env, chatId);
      return;

    default:
      await sendMessage(env, chatId, HELP);
  }
}

const BUTTON_LIMIT = 60;
const BUTTONS_PER_MESSAGE = 10;

function buttonLabel(title: string): string {
  const text = title.replace(/\s+/g, " ").trim() || "Untitled";
  if (text.length <= BUTTON_LIMIT) return text;
  // Long titles share a prefix ("Halaqah 367 - Bab 33 ..."), so keep both ends.
  return `${text.slice(0, 28).trimEnd()}…${text.slice(-28).trimStart()}`;
}

/** List the page's toggle entries as inline buttons and cache them in the session. */
async function handleSections(env: Env, chatId: number, arg: string): Promise<void> {
  let pageId: string | null = null;
  let pageUrl: string | null = null;

  if (arg) {
    const match = arg.match(URL_RE);
    try {
      pageId = parsePageId(match ? match[0] : arg);
      pageUrl = match ? match[0] : null;
    } catch {
      await sendMessage(env, chatId, "That Notion link is not valid.");
      return;
    }
  } else {
    const session = await sessionCall(env, chatId, { op: "get" });
    pageId = session.pageId;
    pageUrl = session.pageUrl;
  }

  if (!pageId) {
    await sendMessage(env, chatId, "No Notion page yet. Send a page link, or /sections <link>.");
    return;
  }

  let sections: SectionRef[];
  try {
    sections = await listSections(env, pageId);
  } catch (error) {
    await sendMessage(env, chatId, `Could not read the page: ${messageOf(error)}`);
    return;
  }

  if (sections.length === 0) {
    await sendMessage(env, chatId, "No sections (toggle headings) found on that page.");
    return;
  }

  await sessionCall(env, chatId, { op: "setSections", pageId, items: sections });

  for (let start = 0; start < sections.length; start += BUTTONS_PER_MESSAGE) {
    const chunk = sections.slice(start, start + BUTTONS_PER_MESSAGE);
    const buttons = chunk.map((section, offset) => [
      { text: buttonLabel(section.title), callback_data: `ret:${start + offset}` },
    ]);
    const header =
      start === 0
        ? `Sections (${sections.length})${pageUrl ? `\n${pageUrl}` : ""}\nTap one to read it:`
        : `Sections ${start + 1}–${start + chunk.length}:`;
    await sendKeyboardMessage(env, chatId, header, buttons);
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
  const index = Number(data.startsWith("ret:") ? data.slice(4) : NaN);
  if (!Number.isInteger(index) || index < 0) {
    await answerCallbackQuery(env, query.id, "Unknown entry.");
    return;
  }

  await answerCallbackQuery(env, query.id, "Loading…");
  await retrieveSection(env, chatId, index);
}

/** Send one section back to Telegram: audio, image, then the formatted text. */
async function retrieveSection(env: Env, chatId: number, index: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  const section = session.sections[index];
  if (!section) {
    await sendMessage(env, chatId, "That list has expired. Send /sections again.");
    return;
  }

  await sendMessage(env, chatId, `Reading: ${section.title}`);

  let content: SectionContent;
  try {
    content = await getSectionContent(env, section.id);
  } catch (error) {
    await sendMessage(env, chatId, `Could not read that entry: ${messageOf(error)}`);
    return;
  }

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

  await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
  await sendMessage(env, chatId, `Material received (${raw.length} characters). \u{1F4DD}`);
}

async function handleDocument(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  const doc = msg.document!;
  const name = doc.file_name ?? "file";
  const mime = doc.mime_type ?? "";
  const ext = extOf(name);

  if (mime.startsWith("text/") || TEXT_EXT.has(ext)) {
    try {
      const file = await downloadFile(env, doc.file_id);
      const text = decodeText(file.bytes).trim();
      if (!text) {
        await sendMessage(env, chatId, "That text file is empty.");
        return;
      }
      await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
      await sendMessage(
        env,
        chatId,
        `Material received from file (${text.length} characters). \u{1F4C4}`,
      );
    } catch (error) {
      await sendMessage(env, chatId, `Could not read the file: ${messageOf(error)}`);
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

async function processEntry(env: Env, chatId: number): Promise<void> {
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

    // AI and media uploads run in parallel so the total stays inside waitUntil.
    const blocksPromise = formatMaterial(env, material, title, references);

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

    const [blocks, audioUploadId, imageUploadId] = await Promise.all([
      blocksPromise,
      audioPromise,
      imagePromise,
    ]);

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

    await sendMessage(
      env,
      chatId,
      `Added to the page.\n${session.pageUrl ?? ""} \u2705`,
    );
    await sessionCall(env, chatId, { op: "clear" });
  } catch (error) {
    let message = messageOf(error);
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
