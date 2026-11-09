import type { Env } from "./env";
import { parseBlocks, toBlock, type AiItem, type Block } from "./format";
import { markdownToBlocks } from "./markdown";

const SYSTEM = `Anda mengubah materi kajian Islam (dari WhatsApp) menjadi blok Notion yang berurutan.

Aturan:
- Keluarkan HANYA JSON valid berbentuk {"blocks":[{"type":"...","text":"..."}]}. Tanpa penjelasan, tanpa pagar kode.
- Nilai "type" hanya boleh salah satu dari: paragraph, quote, heading_2, heading_3, bulleted_list_item, numbered_list_item, divider.
- Pertahankan teks Arab dan harakat PERSIS seperti aslinya; jangan menerjemahkan atau mengubahnya.
- PERTAHANKAN penanda format inline Markdown di dalam "text": **tebal**, *miring*, \`kode\`, ~~coret~~, [teks](url). Jangan membuangnya dan jangan mengubah teksnya.
- Di sumber, baris kutipan/hadits yang diawali tanda '>' jadikan type "quote".
- Judul/uraian bab singkat boleh "heading_2" atau "heading_3"; daftar berbutir pakai "bulleted_list_item".
- Pisahkan uraian panjang menjadi paragraf-paragraf yang wajar. Jangan sertakan baris judul entri.
- Ikuti gaya blok pada CONTOH yang diberikan bila ada.
`;

/** Batas waktu panggilan AI; sisa waktu dipakai untuk unggah media + tulis Notion. */
const AI_TIMEOUT_MS = 20_000;

export async function formatMaterial(
  env: Env,
  material: string,
  title: string,
  references: string[],
): Promise<Block[]> {
  const parsed = await callAi(env, material, title, references);
  const blocks = (parsed ?? [])
    .map((item) => toBlock(item))
    .filter((block): block is Block => block !== null);

  // Tanpa AI (atau AI mengembalikan sampah): tetap parse Markdown-nya sendiri.
  return blocks.length ? blocks : markdownToBlocks(material);
}

async function callAi(
  env: Env,
  material: string,
  title: string,
  references: string[],
): Promise<AiItem[] | null> {
  const parts: string[] = [];
  if (references.length) {
    parts.push("CONTOH ENTRI YANG SUDAH ADA (acuan gaya):\n" + references.join("\n\n"));
  }
  parts.push("JUDUL ENTRI:\n" + title);
  parts.push("MATERI MENTAH:\n" + material);

  const base = env.AI_BASE_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: parts.join("\n\n") },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.error("AI error", resp.status, (await resp.text()).slice(0, 300));
      return null;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: Record<string, unknown> }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) return null;

    const content = textOf(message);
    return parseBlocks(content);
  } catch (error) {
    console.error("AI request gagal", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Respons reasoning kadang menaruh teks di content:null + reasoning_content. */
function textOf(message: Record<string, unknown>): string | null {
  for (const key of ["content", "reasoning_content"]) {
    let value = message[key];
    if (Array.isArray(value)) {
      value = value
        .map((part) =>
          typeof part === "string"
            ? part
            : ((part as { text?: string })?.text ?? ""),
        )
        .join("");
    }
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
