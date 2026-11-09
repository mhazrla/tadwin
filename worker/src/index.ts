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
import { appendEntry, findToggleExamples, uploadFile } from "./notion";
import { entitiesToMarkdown } from "./markdown";
import { emptyState, type SessionState } from "./session";
import { downloadFile, sendMessage, setWebhook } from "./telegram";

export { SessionDO } from "./session";

const URL_RE = /https?:\/\/(?:www\.)?(?:app\.)?notion\.(?:so|com)\/\S+/i;

const HELP =
  "Cara pakai:\n" +
  "1. Kirim link halaman Notion.\n" +
  "2. (Opsional) Kirim /judul <teks> untuk judul entri.\n" +
  "3. Kirim materi: teks biasa, atau unggah file .txt (materi panjang).\n" +
  "4. Kirim audio dan gambar (caption = deskripsi).\n" +
  "5. Kirim /selesai untuk memproses.\n\n" +
  "Perintah: /judul  /status  /batal  /help";

const AUDIO_UNSUPPORTED =
  "Format audio itu belum didukung Notion. Kirim sebagai mp3, m4a, ogg, wav, atau webm.";

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

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
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
        handleUpdate(env, update).catch((error) => console.error("update gagal", error)),
      );
      return new Response("ok");
    }

    if (url.pathname === `/setup/${secret}`) {
      const target = `${url.origin}/webhook/${secret}`;
      try {
        const result = await setWebhook(env, target);
        return Response.json({ url: target, result });
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
      return new Response("tadwin worker siap");
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;

  if (env.ALLOWED_CHAT_IDS) {
    const allowed = env.ALLOWED_CHAT_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(String(chatId))) {
      await sendMessage(env, chatId, "Maaf, bot ini privat.");
      return;
    }
  }

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

async function handleCommand(env: Env, chatId: number, text: string): Promise<void> {
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(env, chatId, "Assalamu'alaikum \u{1F44B}\n\n" + HELP);
      return;

    case "/status": {
      const session = await sessionCall(env, chatId, { op: "get" });
      const chars = session.materials.join("").length;
      await sendMessage(
        env,
        chatId,
        `Halaman: ${session.pageId ? "sudah" : "belum"}\n` +
          `Judul: ${session.title ?? "(otomatis)"}\n` +
          `Materi: ${session.materials.length} bagian (${chars} karakter)\n` +
          `Audio: ${session.audios.length}\n` +
          `Gambar: ${session.images.length}`,
      );
      return;
    }

    case "/judul": {
      const value = text.replace(/^\/judul(@\w+)?\s*/i, "").trim();
      if (!value) {
        const session = await sessionCall(env, chatId, { op: "get" });
        await sendMessage(
          env,
          chatId,
          session.title
            ? `Judul sekarang: ${session.title}\nUbah: /judul <teks baru>`
            : "Belum ada judul manual. Kirim /judul <teks> atau biarkan otomatis dari baris pertama materi.",
        );
        return;
      }
      await sessionCall(env, chatId, { op: "setTitle", title: value });
      await sendMessage(env, chatId, `Judul entri diset: ${value} \u{1F3F7}`);
      return;
    }

    case "/batal":
      await sessionCall(env, chatId, { op: "clear" });
      await sendMessage(env, chatId, "Sesi dibersihkan. \u{1F5D1}");
      return;

    case "/selesai":
      await sendMessage(env, chatId, "Memproses... \u23F3");
      await processEntry(env, chatId);
      return;

    default:
      await sendMessage(env, chatId, HELP);
  }
}

async function handleText(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  const raw = typeof msg.text === "string" ? msg.text.trim() : "";
  // Format Telegram (bold/italic/link/quote) dibawa sebagai entity, bukan karakter.
  const text = entitiesToMarkdown(raw, msg.entities);
  const match = raw.match(URL_RE);
  if (match) {
    try {
      const pageId = parsePageId(match[0]);
      await sessionCall(env, chatId, { op: "setPage", pageId, pageUrl: match[0] });
    } catch {
      await sendMessage(env, chatId, "Link Notion tidak valid.");
      return;
    }
    await sendMessage(env, chatId, "Link halaman diterima. \u{1F4C4}");
    return;
  }

  await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
  await sendMessage(env, chatId, `Materi diterima (${raw.length} karakter). \u{1F4DD}`);
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
        await sendMessage(env, chatId, "File teks kosong.");
        return;
      }
      await sessionCall(env, chatId, { op: "push", field: "materials", value: text });
      await sendMessage(
        env,
        chatId,
        `Materi dari file diterima (${text.length} karakter). \u{1F4C4}`,
      );
    } catch (error) {
      await sendMessage(env, chatId, `Gagal membaca file: ${messageOf(error)}`);
    }
    return;
  }

  if ([".pdf", ".doc", ".docx", ".rtf", ".odt"].includes(ext)) {
    await sendMessage(
      env,
      chatId,
      "Format file itu belum didukung. Simpan materi sebagai .txt lalu kirim ulang.",
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
    await sendMessage(env, chatId, "Gambar diterima. \u{1F5BC}");
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
  await sendMessage(env, chatId, "Audio diterima. \u{1F3A7}");
}

async function handlePhoto(env: Env, chatId: number, msg: TgMessage): Promise<void> {
  const photo = msg.photo![msg.photo!.length - 1];
  await sessionCall(env, chatId, {
    op: "push",
    field: "images",
    value: {
      fileId: photo.file_id,
      name: "gambar.jpg",
      mime: "image/jpeg",
      caption: entitiesToMarkdown(msg.caption ?? "", msg.caption_entities),
    },
  });
  await sendMessage(env, chatId, "Gambar diterima. \u{1F5BC}");
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
  await sendMessage(env, chatId, "Audio diterima. \u{1F3A7}");
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
  await sendMessage(env, chatId, "Audio diterima. \u{1F3A7}");
}

async function processEntry(env: Env, chatId: number): Promise<void> {
  const session = await sessionCall(env, chatId, { op: "get" });
  if (!session.pageId) {
    await sendMessage(env, chatId, "Belum ada link halaman Notion.");
    return;
  }
  if (session.materials.length === 0) {
    await sendMessage(env, chatId, "Belum ada materi teks.");
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
        "Halaman ini belum punya contoh entri (toggle heading). " +
          "Tambahkan 1 contoh dulu agar format bisa ditiru, lalu ulangi /selesai.",
      );
      return;
    }

    // AI dan unggahan media berjalan paralel agar total waktu < batas waitUntil.
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
      `Berhasil ditambahkan ke halaman.\n${session.pageUrl ?? ""} \u2705`,
    );
    await sessionCall(env, chatId, { op: "clear" });
  } catch (error) {
    let message = messageOf(error);
    if (/file size|size limit|too large|exceed/i.test(message)) {
      message += "\n\nCatatan: plan Notion Free membatasi 5 MB per file.";
    }
    await sendMessage(env, chatId, `Gagal: ${message}`);
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
