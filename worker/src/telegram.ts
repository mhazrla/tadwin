import type { Env } from "./env";

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function tg<T = unknown>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const MAX_RETRIES = 1;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = (await resp.json()) as TgResponse<T>;
    if (data.ok) return data.result as T;

    // Telegram rate limit: back off briefly, then retry once.
    if (resp.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(
        (data as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 1,
      );
      const wait = Math.min(Math.max(retryAfter, 1), 5) * 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    throw new Error(`Telegram ${method}: ${data.description ?? resp.status}`);
  }
  throw new Error(`Telegram ${method}: failed after retry`);
}

function splitText(text: string, size = 4000): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
): Promise<number[]> {
  const ids: number[] = [];
  for (const chunk of splitText(text)) {
    const message = await tg<{ message_id: number }>(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
    if (message && typeof message.message_id === "number") ids.push(message.message_id);
  }
  return ids;
}

export interface DownloadedFile {
  bytes: ArrayBuffer;
  size: number;
}

/** Bot API download limit: 20 MB. */
export const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;

export async function downloadFile(
  env: Env,
  fileId: string,
): Promise<DownloadedFile> {
  const file = await tg<{ file_path: string; file_size?: number }>(env, "getFile", {
    file_id: fileId,
  });
  const size = Number(file.file_size ?? 0);
  if (size > TELEGRAM_MAX_BYTES) {
    throw new Error(
      `File ${(size / 1024 / 1024).toFixed(1)} MB exceeds the Telegram download limit (20 MB).`,
    );
  }

  const resp = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
  );
  if (!resp.ok) {
    throw new Error(`Failed to download the file from Telegram (${resp.status}).`);
  }
  const bytes = await resp.arrayBuffer();
  return { bytes, size: size || bytes.byteLength };
}

export async function setWebhook(env: Env, url: string): Promise<unknown> {
  return tg(env, "setWebhook", {
    url,
    drop_pending_updates: true,
    // callback_query carries the inline-button taps.
    allowed_updates: ["message", "callback_query"],
  });
}

/** Registers the slash-command menu shown in Telegram's UI. */
export async function setMyCommands(
  env: Env,
  commands: Array<{ command: string; description: string }>,
): Promise<unknown> {
  return tg(env, "setMyCommands", { commands });
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** A message carrying an inline keyboard, used for the section list. */
export async function sendKeyboardMessage(
  env: Env,
  chatId: number,
  text: string,
  buttons: InlineButton[][],
): Promise<number | undefined> {
  const message = await tg<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
  });
  return message?.message_id;
}

/** Replace a message's text and keyboard in place (used for pagination). */
export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  await tg(env, "editMessageText", payload);
}

/** Remove a message entirely (used to clean up the section list after a pick). */
export async function deleteMessage(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<void> {
  await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  await tg(env, "answerCallbackQuery", payload);
}

/** Send an image straight from a URL; Telegram fetches it itself. */
export async function sendPhoto(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<number | undefined> {
  const payload: Record<string, unknown> = { chat_id: chatId, photo: url };
  if (caption) {
    payload.caption = caption.slice(0, 1024);
    payload.parse_mode = "HTML";
  }
  const message = await tg<{ message_id: number }>(env, "sendPhoto", payload);
  return message?.message_id;
}

/** Send an audio file straight from a URL; Telegram fetches it itself. */
export async function sendAudio(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<number | undefined> {
  const payload: Record<string, unknown> = { chat_id: chatId, audio: url };
  if (caption) {
    payload.caption = caption.slice(0, 1024);
    payload.parse_mode = "HTML";
  }
  const message = await tg<{ message_id: number }>(env, "sendAudio", payload);
  return message?.message_id;
}

/** Send any file straight from a URL; used when audio/photo handling rejects it. */
export async function sendDocument(
  env: Env,
  chatId: number,
  url: string,
  caption?: string,
): Promise<number | undefined> {
  const payload: Record<string, unknown> = { chat_id: chatId, document: url };
  if (caption) {
    payload.caption = caption.slice(0, 1024);
    payload.parse_mode = "HTML";
  }
  const message = await tg<{ message_id: number }>(env, "sendDocument", payload);
  return message?.message_id;
}

const HTML_LIMIT = 3800;

/** Strip tags for the rare oversized block, decoding the entities we produced. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Send pre-built HTML blocks, grouping them so no message splits a tag pair.
 * A single block larger than the limit falls back to plain text.
 */
export async function sendHtml(
  env: Env,
  chatId: number,
  blocks: string[],
): Promise<number[]> {
  const messages: string[] = [];
  const ids: number[] = [];
  let buffer = "";

  for (const block of blocks) {
    if (!block.trim()) {
      // Preserve blank-line separators between blocks.
      if (buffer && !buffer.endsWith("\n")) buffer += "\n";
      if (buffer && !buffer.endsWith("\n\n")) buffer += "\n";
      continue;
    }
    if (block.length > HTML_LIMIT) {
      if (buffer) {
        messages.push(buffer);
        buffer = "";
      }
      messages.push(block);
      continue;
    }
    if (buffer && buffer.length + block.length + 1 > HTML_LIMIT) {
      messages.push(buffer);
      buffer = "";
    }
    buffer = buffer ? `${buffer}\n${block}` : block;
  }
  if (buffer.trim()) messages.push(buffer.trimEnd());

  for (const message of messages) {
    if (message.length <= 4000) {
      const sent = await tg<{ message_id: number }>(env, "sendMessage", {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (sent && typeof sent.message_id === "number") ids.push(sent.message_id);
      continue;
    }
    for (const part of splitText(stripTags(message), 4000)) {
      const sent = await tg<{ message_id: number }>(env, "sendMessage", {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
      });
      if (sent && typeof sent.message_id === "number") ids.push(sent.message_id);
    }
  }
  return ids;
}
