import { blockOf } from "./markdown";

export type Block = Record<string, unknown>;

export interface AiItem {
  type?: string;
  text?: string;
}

export const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".text", ".log"]);

const VIDEO_TO_AUDIO: Record<string, string> = {
  "video/mp4": "audio/mp4",
  "video/quicktime": "audio/mp4",
  "video/ogg": "audio/ogg",
  "video/webm": "audio/webm",
  "video/3gpp": "audio/3gpp",
  "video/x-matroska": "audio/webm",
  "video/x-msvideo": "audio/mpeg",
};

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** Audio content types actually accepted by the Notion File Upload API. */
const AUDIO_EXT: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".webm",
};

/** MIME aliases Telegram commonly sends that Notion rejects. */
const MIME_ALIAS: Record<string, string> = {
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/mp4a": "audio/mp4",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/opus": "audio/ogg",
  "audio/x-ogg": "audio/ogg",
  "audio/vorbis": "audio/ogg",
  "audio/x-webm": "audio/webm",
};

const EXT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
};

export interface AudioUpload {
  filename: string;
  contentType: string;
}

function cleanMime(raw: string | undefined): string {
  return (raw ?? "").toLowerCase().split(";")[0].trim();
}

/** A Notion-supported audio content type, or null if it cannot be mapped. */
export function audioMime(raw: string | undefined): string | null {
  const mime = cleanMime(raw);
  if (!mime) return null;
  const alias = MIME_ALIAS[mime] ?? VIDEO_TO_AUDIO[mime] ?? mime;
  return AUDIO_EXT[alias] ? alias : null;
}

/**
 * Filename + content_type for the File Upload API. Notion rejects content_type
 * values outside its official list AND rejects filenames whose extension does
 * not match. The original extension wins because Telegram's MIME is often wrong
 * (e.g. .m4a sent as audio/m4a).
 */
export function audioUpload(name: string, rawMime: string | undefined): AudioUpload | null {
  const contentType = EXT_MIME[extOf(name)] ?? audioMime(rawMime);
  if (!contentType) return null;

  const basename = name.split(/[/\\]/).pop() ?? name;
  const base = basename.replace(/\.[^./\\]*$/, "").trim() || "audio";
  return { filename: base + AUDIO_EXT[contentType], contentType };
}

/** Decode a text file: UTF-8 first, then Windows-1252. */
export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function extractTitle(material: string): string {
  const cleanLine = (line: string): string =>
    line
      .replace(/^[\s\p{P}\p{S}\p{Extended_Pictographic}]+/u, "")
      .replace(/[*_`]+$/g, "")
      .trim();

  const lines = material
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const cleaned = cleanLine(line);
    const lower = cleaned.toLowerCase();
    if (lower.startsWith("judul") || lower.startsWith("title")) {
      const idx = cleaned.indexOf(":");
      if (idx >= 0) {
        const value = cleanLine(cleaned.slice(idx + 1));
        if (value) return value.slice(0, 120);
      }
    }
  }
  // Prefer explicit entry markers commonly used in study notes ("Audio ke-397 ...", "Halaqah ...").
  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (/^(?:audio\s+ke[-\s]*\d+|halaq[ao]h)\b/i.test(cleaned)) {
      return cleaned.slice(0, 120);
    }
  }
  const isNoise = (line: string): boolean => {
    const cleaned = cleanLine(line);
    if (/^https?:\/\//i.test(cleaned) || /^https?:\/\//i.test(line)) return true;
    if (/^[\s\p{P}\p{S}\p{Extended_Pictographic}═╔╗╚╝║╠╣╦╩╬❖•ೋ°☛]+$/u.test(line)) return true;
    if (/^(whatsapp|telegram|instagram|facebook|fanspage|website|official|grup|group|channel)\b/i.test(cleaned)) return true;
    if (/^(oleh|pemateri|ustadz|ustadzah|kitab|pertemuan|sesi|episode)\b/i.test(cleaned) && cleaned.length < 160) return true;
    if (/^(senin|selasa|rabu|kamis|jumat|sabtu|ahad|minggu)\b/i.test(cleaned)) return true;
    if (/^\d{1,2}\s+(muharram|safar|rabi|jumad|rajab|sya'?ban|ramadhan|syawwal|dzul|dhu)/i.test(cleaned)) return true;
    if (/^\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b/i.test(cleaned)) return true;
    const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, "");
    return letters.length < 4;
  };
  for (const line of lines) {
    if (isNoise(line)) continue;
    return cleanLine(line).slice(0, 120);
  }
  return cleanLine(lines[0] ?? "New entry").slice(0, 120);
}

/** Notion caps rich_text at 2000 characters. */
export function richText(text: string): Array<Record<string, unknown>> {
  const content = text.length ? text : " ";
  const parts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < content.length; i += 2000) {
    parts.push({ type: "text", text: { content: content.slice(i, i + 2000) } });
  }
  return parts;
}

/** Notion block from an AI item; inline Markdown becomes annotations. */
export function toBlock(item: AiItem): Block | null {
  if (!item || typeof item !== "object") return null;
  return blockOf(item.type ?? "paragraph", item.text ?? "");
}

function tryParseBlocksJson(raw: string): AiItem[] | null {
  try {
    const data = JSON.parse(raw) as { blocks?: unknown };
    return data && typeof data === "object" && Array.isArray(data.blocks)
      ? (data.blocks as AiItem[])
      : null;
  } catch {
    return null;
  }
}

/** Extract the blocks array from an AI reply that may be wrapped in code fences. */
export function parseBlocks(content: string | null): AiItem[] | null {
  if (!content) return null;
  const trimmed = content.trim();

  const direct = tryParseBlocksJson(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsedFence = tryParseBlocksJson(fenced[1].trim());
    if (parsedFence) return parsedFence;
  }

  const stripped = trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return tryParseBlocksJson(stripped.slice(start, end + 1));
}

const HEX32 = /[0-9a-fA-F]{32}/g;
const HEX32_EXACT = /^[0-9a-fA-F]{32}$/;

/** Extract a Page ID (UUID) from a Notion link or a raw ID. */
export function parsePageId(input: string): string {
  const raw = input.trim().split("?")[0].split("#")[0].replace(/\/+$/, "");
  const compact = raw.replace(/-/g, "");

  // Main path: the last 32 hex characters (the ID is always at the end of a Notion URL).
  const tail = compact.slice(-32);
  if (HEX32_EXACT.test(tail)) {
    return uuid(tail.toLowerCase());
  }

  const matches = raw.replace(/-/g, "").match(HEX32);
  if (!matches || matches.length === 0) {
    throw new Error("No Page ID found in the given link/ID.");
  }
  return uuid(matches[matches.length - 1].toLowerCase());
}

function uuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
