import type { Env } from "./env";
import type { Block } from "./format";
import { inlineRichText, richTextToHtml } from "./markdown";

const API = "https://api.notion.com/v1";
const MAX_CHILDREN = 100;

type Json = Record<string, unknown>;

function baseHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": env.NOTION_VERSION ?? "2026-03-11",
  };
}

async function notion(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Json> {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...baseHeaders(env), ...((init.headers as Record<string, string>) ?? {}) },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${body.slice(0, 500)}`);
  }
  return (await resp.json()) as Json;
}

function plain(block: Json): string {
  const type = block.type as string | undefined;
  const obj = type ? (block[type] as Json | undefined) : undefined;
  const parts = Array.isArray(obj?.rich_text) ? (obj!.rich_text as Json[]) : [];
  return parts.map((part) => (part.plain_text as string) ?? "").join("");
}

export async function getChildren(env: Env, blockId: string): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const data = await notion(env, `/blocks/${blockId}/children?${query.toString()}`);
    out.push(...((data.results as Json[]) ?? []));
    if (!data.has_more) break;
    cursor = (data.next_cursor as string) ?? null;
    if (!cursor) break;
  }
  return out;
}

/** Collect existing toggle-heading entries as formatting references. */
export async function findToggleExamples(
  env: Env,
  pageId: string,
  maxExamples = 3,
): Promise<string[]> {
  const examples: string[] = [];
  for (const block of await getChildren(env, pageId)) {
    if (examples.length >= maxExamples) break;
    const type = block.type as string | undefined;
    if (!type || !["heading_1", "heading_2", "heading_3"].includes(type)) continue;
    const obj = block[type] as Json | undefined;
    if (!obj?.is_toggleable) continue;

    const lines = [`### ${plain(block)}`];
    if (block.has_children) {
      for (const child of await getChildren(env, block.id as string)) {
        if (child.type === "divider") {
          lines.push("---");
          continue;
        }
        const text = plain(child);
        if (text) lines.push(text);
      }
    }
    examples.push(lines.join("\n"));
  }
  return examples;
}

export interface SectionRef {
  id: string;
  title: string;
}

/** Toggle headings on a page, in document order — the readable "sections". */
export async function listSections(
  env: Env,
  pageId: string,
  max = 200,
): Promise<SectionRef[]> {
  const out: SectionRef[] = [];
  for (const block of await getChildren(env, pageId)) {
    if (out.length >= max) break;
    const type = block.type as string | undefined;
    if (!type || !["heading_1", "heading_2", "heading_3"].includes(type)) continue;
    const obj = block[type] as Json | undefined;
    if (!obj?.is_toggleable) continue;
    out.push({
      id: block.id as string,
      title: plain(block).trim() || "Untitled",
    });
  }
  return out;
}

export interface SectionContent {
  html: string[];
  audios: Array<{ url: string | null; caption: string }>;
  images: Array<{ url: string | null; caption: string }>;
}

function fileUrl(obj: Json | undefined): string | null {
  const file = obj?.file as Json | undefined;
  if (typeof file?.url === "string") return file.url;
  const external = obj?.external as Json | undefined;
  if (typeof external?.url === "string") return external.url;
  return null;
}

/** Children of one toggle, split into media and ready-to-send HTML blocks. */
export async function getSectionContent(
  env: Env,
  sectionId: string,
): Promise<SectionContent> {
  const children = await getChildren(env, sectionId);
  const media: MediaSink = { audios: [], images: [] };
  const html = await renderBlocks(env, children, 0, media);
  return { html, audios: media.audios, images: media.images };
}

interface MediaSink {
  audios: SectionContent["audios"];
  images: SectionContent["images"];
}

/** Notion nests translations and sub-points inside quote blocks; do not lose them. */
const MAX_DEPTH = 5;

async function renderBlocks(
  env: Env,
  blocks: Json[],
  depth: number,
  media: MediaSink,
  inQuote = false,
): Promise<string[]> {
  const lines: string[] = [];
  let number = 0;

  for (const block of blocks) {
    const type = block.type as string | undefined;
    if (!type) continue;

    if (type === "numbered_list_item") {
      number += 1;
    } else {
      number = 0;
    }

    lines.push(...(await blockLines(env, block, depth, media, number, inQuote)));
  }
  return lines;
}

async function blockLines(
  env: Env,
  block: Json,
  depth: number,
  media: MediaSink,
  number: number,
  inQuote: boolean,
): Promise<string[]> {
  const type = block.type as string | undefined;
  if (!type) return [];
  const obj = (block[type] as Json | undefined) ?? {};

  if (type === "audio") {
    media.audios.push({ url: fileUrl(obj), caption: richTextToHtml(obj.caption) });
    return [];
  }
  if (type === "image") {
    media.images.push({ url: fileUrl(obj), caption: richTextToHtml(obj.caption) });
    return [];
  }

  const children =
    block.has_children && depth < MAX_DEPTH
      ? await getChildren(env, block.id as string)
      : [];

  if (type === "divider") return ["———"];

  if (type === "quote") {
    const lines: string[] = [];
    const own = richTextToHtml(obj.rich_text).trim();
    if (own) lines.push(own);
    lines.push(...(await renderBlocks(env, children, depth + 1, media, true)));
    if (!lines.length) return [];
    // Nested quotes stay inside the outer one: Telegram cannot nest blockquotes.
    return inQuote ? lines : [`<blockquote>${lines.join("\n")}</blockquote>`];
  }

  const inner = richTextToHtml(obj.rich_text);
  const lines: string[] = [];

  if (inner.trim()) {
    if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
      lines.push(`<b>${inner}</b>`);
    } else if (type === "bulleted_list_item") {
      lines.push(`• ${inner}`);
    } else if (type === "numbered_list_item") {
      lines.push(`${number}. ${inner}`);
    } else if (type === "code") {
      lines.push(`<pre>${inner}</pre>`);
    } else {
      lines.push(inner);
    }
  }

  if (children.length) {
    const sub = await renderBlocks(env, children, depth + 1, media, inQuote);
    for (const line of sub) lines.push(inQuote ? line : `  ${line}`);
  }

  return lines;
}

/** Upload a file through the File Upload API; returns the file_upload id. */
export async function uploadFile(
  env: Env,
  filename: string,
  contentType: string,
  bytes: ArrayBuffer,
): Promise<string> {
  const init = await notion(env, "/file_uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_type: contentType }),
  });
  const uploadId = init.id as string;

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);

  const resp = await fetch(`${API}/file_uploads/${uploadId}/send`, {
    method: "POST",
    headers: baseHeaders(env),
    body: form,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Notion upload error ${resp.status}: ${body.slice(0, 500)}`);
  }
  return uploadId;
}

async function appendChildren(
  env: Env,
  blockId: string,
  children: Block[],
): Promise<void> {
  for (let i = 0; i < children.length; i += MAX_CHILDREN) {
    const chunk = children.slice(i, i + MAX_CHILDREN);
    await notion(env, `/blocks/${blockId}/children`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ children: chunk }),
    });
  }
}

/** Create one heading_1 toggle (audio -> image -> text); returns the block id. */
export async function appendEntry(
  env: Env,
  pageId: string,
  title: string,
  audioUploadId: string | null,
  imageUploadId: string | null,
  imageCaption: string,
  textBlocks: Block[],
): Promise<string> {
  const media: Block[] = [];

  if (audioUploadId) {
    media.push({
      object: "block",
      type: "audio",
      audio: { type: "file_upload", file_upload: { id: audioUploadId } },
    });
  }

  if (imageUploadId) {
    const image: Json = {
      type: "file_upload",
      file_upload: { id: imageUploadId },
    };
    if (imageCaption) image.caption = inlineRichText(imageCaption);
    media.push({ object: "block", type: "image", image });
  }

  const capacity = MAX_CHILDREN - media.length;
  const first = textBlocks.slice(0, capacity);
  const rest = textBlocks.slice(capacity);

  const heading = {
    object: "block",
    type: "heading_1",
    heading_1: {
      rich_text: inlineRichText(title),
      color: "default",
      is_toggleable: true,
      children: [...media, ...first],
    },
  };

  const resp = await notion(env, `/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ children: [heading] }),
  });

  const results = (resp.results as Json[]) ?? [];
  const headingId = results[0]?.id as string | undefined;
  if (!headingId) throw new Error("Notion did not return the new block id.");

  if (rest.length) await appendChildren(env, headingId, rest);
  return headingId;
}
