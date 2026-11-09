import type { Env } from "./env";
import type { Block } from "./format";
import { inlineRichText } from "./markdown";

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

/** Kumpulkan contoh entri (toggle heading) yang sudah ada sebagai acuan format. */
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

/** Unggah file lewat File Upload API, kembalikan file_upload id. */
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

/** Buat satu toggle heading_1 (audio -> gambar -> teks), kembalikan block id. */
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
  if (!headingId) throw new Error("Notion tidak mengembalikan id blok baru.");

  if (rest.length) await appendChildren(env, headingId, rest);
  return headingId;
}
