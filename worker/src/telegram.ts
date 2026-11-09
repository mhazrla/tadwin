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
  const resp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const data = (await resp.json()) as TgResponse<T>;
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description ?? resp.status}`);
  }
  return data.result as T;
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
): Promise<void> {
  for (const chunk of splitText(text)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
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
    allowed_updates: ["message"],
  });
}

/** Registers the slash-command menu shown in Telegram's UI. */
export async function setMyCommands(
  env: Env,
  commands: Array<{ command: string; description: string }>,
): Promise<unknown> {
  return tg(env, "setMyCommands", { commands });
}
