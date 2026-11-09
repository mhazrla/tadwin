"""Bot Telegram: terima link halaman Notion + materi + media, lalu tempel sebagai entri baru."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters
from telegram.request import HTTPXRequest

from config import load_settings
from formatter import format_material
from notion import NotionClient, parse_page_id

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("tadwin")

_URL_RE = re.compile(r"https?://(?:www\.)?(?:app\.)?notion\.(?:so|com)/\S+", re.IGNORECASE)

# Notion hanya menerima content_type audio/* pada blok audio. Telegram kadang
# melaporkan berkas audio sebagai video/* (mis. m4a di dalam container mp4).
_VIDEO_TO_AUDIO = {
    "video/mp4": "audio/mp4",
    "video/quicktime": "audio/mp4",
    "video/ogg": "audio/ogg",
    "video/webm": "audio/webm",
    "video/3gpp": "audio/3gpp",
    "video/x-matroska": "audio/webm",
    "video/x-msvideo": "audio/mpeg",
}


def _audio_mime(mime: str | None) -> str:
    """Paksa content_type menjadi audio/* agar diterima Notion."""
    m = (mime or "").lower().split(";")[0].strip()
    if m in _VIDEO_TO_AUDIO:
        return _VIDEO_TO_AUDIO[m]
    if m.startswith("audio/"):
        return m
    if m.startswith("video/"):
        return "audio/mp4"
    return "audio/mpeg"

SESSIONS: dict[int, dict] = {}

_TEXT_EXT = {".txt", ".md", ".markdown", ".text", ".log"}

HELP = (
    "Cara pakai:\n"
    "1. Kirim link halaman Notion.\n"
    "2. Kirim materi: teks biasa, atau unggah file .txt (untuk materi panjang).\n"
    "3. Kirim audio dan gambar (caption = deskripsi).\n"
    "4. Kirim /selesai untuk memproses.\n\n"
    "Perintah: /status  /batal  /help"
)


def _session(chat_id: int) -> dict:
    return SESSIONS.setdefault(
        chat_id,
        {"page_id": None, "page_url": None, "materials": [], "audios": [], "images": []},
    )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Assalamu'alaikum \U0001F44B\n\n" + HELP)


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    s = _session(update.effective_chat.id)
    await update.message.reply_text(
        f"Halaman: {'sudah' if s['page_id'] else 'belum'}\n"
        f"Materi: {len(s['materials'])} bagian\n"
        f"Audio: {len(s['audios'])}\n"
        f"Gambar: {len(s['images'])}"
    )


async def cmd_batal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    SESSIONS.pop(update.effective_chat.id, None)
    await update.message.reply_text("Sesi dibersihkan. \U0001F5D1")


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = update.message.text.strip()
    s = _session(update.effective_chat.id)
    match = _URL_RE.search(text)
    if match:
        try:
            s["page_id"] = parse_page_id(match.group(0))
        except ValueError:
            await update.message.reply_text("Link Notion tidak valid.")
            return
        s["page_url"] = match.group(0)
        await update.message.reply_text("Link halaman diterima. \U0001F4C4")
        return
    if not text:
        return
    s["materials"].append(text)
    await update.message.reply_text(f"Materi diterima ({len(text)} karakter). \U0001F4DD")


async def on_audio(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    media = update.message.voice or update.message.audio
    if media is None:
        return
    s = _session(update.effective_chat.id)
    name = getattr(media, "file_name", None) or "audio.m4a"
    raw = getattr(media, "mime_type", None) or ""
    s["audios"].append(
        {"file_id": media.file_id, "name": name, "mime": _audio_mime(raw), "raw_mime": raw}
    )
    await update.message.reply_text("Audio diterima. \U0001F3A7")


async def on_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    photo = update.message.photo[-1]
    s = _session(update.effective_chat.id)
    s["images"].append(
        {
            "file_id": photo.file_id,
            "name": "gambar.jpg",
            "mime": "image/jpeg",
            "caption": update.message.caption or "",
        }
    )
    await update.message.reply_text("Gambar diterima. \U0001F5BC")


def _decode_text(data: bytes) -> str:
    """Dekode berkas teks; coba beberapa encoding umum."""
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


async def _read_text_file(context: ContextTypes.DEFAULT_TYPE, file_id: str) -> str:
    """Unduh berkas teks dan dekode isinya."""
    return _decode_text(await _download(context, file_id))


async def on_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    doc = update.message.document
    mime = doc.mime_type or ""
    fname = doc.file_name or ""
    ext = os.path.splitext(fname)[1].lower()
    s = _session(update.effective_chat.id)

    if mime.startswith("text/") or ext in _TEXT_EXT:
        try:
            text = (await _read_text_file(context, doc.file_id)).strip()
        except Exception as exc:  # noqa: BLE001
            log.exception("Gagal membaca file teks")
            await update.message.reply_text(f"Gagal membaca file: {exc}")
            return
        if not text:
            await update.message.reply_text("File teks kosong.")
            return
        s["materials"].append(text)
        await update.message.reply_text(
            f"Materi dari file diterima ({len(text)} karakter). \U0001F4C4"
        )
        return

    if ext in {".pdf", ".doc", ".docx", ".rtf", ".odt"}:
        await update.message.reply_text(
            "Format file itu belum didukung. Simpan materi sebagai .txt lalu kirim ulang."
        )
        return

    if mime.startswith("image/"):
        s["images"].append(
            {
                "file_id": doc.file_id,
                "name": doc.file_name or "gambar",
                "mime": mime,
                "caption": update.message.caption or "",
            }
        )
        await update.message.reply_text("Gambar diterima. \U0001F5BC")
    else:
        s["audios"].append(
            {
                "file_id": doc.file_id,
                "name": doc.file_name or "audio",
                "mime": _audio_mime(mime),
                "raw_mime": mime,
            }
        )
        await update.message.reply_text("Audio diterima. \U0001F3A7")


async def on_video(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Video diperlakukan sebagai audio (Notion hanya punya blok audio)."""
    msg = update.message
    media = msg.video or msg.video_note
    if media is None:
        return
    s = _session(update.effective_chat.id)
    name = getattr(media, "file_name", None) or "audio.mp4"
    raw = getattr(media, "mime_type", None) or ""
    s["audios"].append(
        {"file_id": media.file_id, "name": name, "mime": _audio_mime(raw), "raw_mime": raw}
    )
    await update.message.reply_text("Audio diterima. \U0001F3A7")


async def cmd_selesai(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    s = _session(chat_id)
    if not s["page_id"]:
        await update.message.reply_text("Belum ada link halaman Notion.")
        return
    if not s["materials"]:
        await update.message.reply_text("Belum ada materi teks.")
        return

    material = "\n\n".join(s["materials"]).strip()
    title = _extract_title(material)
    status = await update.message.reply_text("Memproses... \u23F3")
    notion: NotionClient = context.bot_data["notion"]
    cfg = context.bot_data["cfg"]

    try:
        references = await notion.find_toggle_examples(s["page_id"])
        if not references:
            await status.edit_text(
                "Halaman ini belum punya contoh entri (toggle heading). "
                "Tambahkan 1 contoh dulu agar format bisa ditiru, lalu ulangi /selesai."
            )
            return

        blocks = await format_material(material, title, references, cfg)

        audio_id = None
        if s["audios"]:
            a = s["audios"][0]
            data = await _download(context, a["file_id"])
            name, mime = a["name"], a["mime"]
            if str(a.get("raw_mime", "")).lower().startswith("video/"):
                extracted = await _extract_audio(data, name)
                if extracted is not None:
                    data, name, mime = extracted
            audio_id = await notion.upload_file(name, mime, data)

        image_id = None
        image_caption = ""
        if s["images"]:
            im = s["images"][0]
            data = await _download(context, im["file_id"])
            image_id = await notion.upload_file(im["name"], im["mime"], data)
            image_caption = im.get("caption", "")

        await notion.append_entry(s["page_id"], title, audio_id, image_id, image_caption, blocks)
        await status.edit_text(f"Berhasil ditambahkan ke halaman.\n{s['page_url']} \u2705")
        SESSIONS.pop(chat_id, None)
    except Exception as exc:  # noqa: BLE001 - laporkan ke pengguna
        log.exception("Gagal memproses entri")
        await status.edit_text(f"Gagal: {exc}")


async def _download(context: ContextTypes.DEFAULT_TYPE, file_id: str) -> bytes:
    last_exc = None
    for _ in range(3):
        try:
            tg_file = await context.bot.get_file(file_id)
            return bytes(await tg_file.download_as_bytearray())
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            await asyncio.sleep(2)
    raise last_exc


async def _extract_audio(data: bytes, name: str) -> tuple[bytes, str, str] | None:
    """Ambil trek audio dari berkas video via ffmpeg. None bila gagal/tak tersedia."""
    suffix = os.path.splitext(name)[1].lower() or ".mp4"
    tmpdir = tempfile.mkdtemp(prefix="aik_")
    src = os.path.join(tmpdir, f"in{suffix}")
    dst = os.path.join(tmpdir, "out.m4a")
    try:
        with open(src, "wb") as fh:
            fh.write(data)
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error", "-i", src,
            "-vn", "-acodec", "aac", "-b:a", "128k", dst,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=300)
        except asyncio.TimeoutError:
            proc.kill()
            log.warning("ffmpeg timeout saat ekstrak audio")
            return None
        if proc.returncode != 0 or not os.path.exists(dst):
            log.warning("ffmpeg gagal: %s", (err or b"").decode("utf-8", "replace")[:300])
            return None
        with open(dst, "rb") as fh:
            out = fh.read()
        if not out:
            return None
        return out, os.path.splitext(name)[0] + ".m4a", "audio/mp4"
    except FileNotFoundError:
        log.warning("ffmpeg tidak ditemukan; unggah apa adanya sebagai audio")
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("ekstrak audio gagal: %r", exc)
        return None
    finally:
        for p in (src, dst):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def _extract_title(material: str) -> str:
    lines = [ln.strip() for ln in material.splitlines() if ln.strip()]
    for ln in lines:
        if ln.lower().startswith("judul"):
            parts = ln.split(":", 1)
            if len(parts) == 2 and parts[1].strip():
                return parts[1].strip()
    return lines[0] if lines else "Entri baru"


async def on_error(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    err = context.error
    if err is not None:
        log.error("Error tak tertangani: %r", err, exc_info=(type(err), err, err.__traceback__))
    try:
        if update and update.effective_message:
            await update.effective_message.reply_text("Terjadi kesalahan internal. Coba lagi.")
    except Exception:  # noqa: BLE001
        pass


def main() -> None:
    cfg = load_settings()
    notion = NotionClient(cfg.notion_token, cfg.notion_version)
    request = HTTPXRequest(
        connect_timeout=30.0,
        read_timeout=120.0,
        write_timeout=120.0,
        pool_timeout=30.0,
    )
    app = (
        Application.builder()
        .token(cfg.telegram_bot_token)
        .request(request)
        .get_updates_request(HTTPXRequest(connect_timeout=30.0, read_timeout=30.0))
        .build()
    )
    app.bot_data["cfg"] = cfg
    app.bot_data["notion"] = notion

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("batal", cmd_batal))
    app.add_handler(CommandHandler("selesai", cmd_selesai))
    app.add_handler(MessageHandler(filters.PHOTO, on_photo))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, on_audio))
    app.add_handler(MessageHandler(filters.VIDEO | filters.VIDEO_NOTE, on_video))
    app.add_handler(MessageHandler(filters.Document.ALL, on_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.add_error_handler(on_error)

    log.info("Bot berjalan. Tekan Ctrl+C untuk berhenti.")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
