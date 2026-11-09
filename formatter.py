"""Ubah materi mentah menjadi blok Notion memakai AI (endpoint kompatibel OpenAI)."""
from __future__ import annotations

import json
import re

import httpx

_ALLOWED = {
    "paragraph",
    "quote",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "divider",
}

_SYSTEM = """Anda mengubah materi kajian Islam (dari WhatsApp) menjadi blok Notion yang berurutan.

Aturan:
- Keluarkan HANYA JSON valid berbentuk {"blocks":[{"type":"...","text":"..."}]}. Tanpa penjelasan, tanpa pagar kode.
- Nilai "type" hanya boleh salah satu dari: paragraph, quote, heading_2, heading_3, bulleted_list_item, numbered_list_item, divider.
- Pertahankan teks Arab dan harakat PERSIS seperti aslinya; jangan menerjemahkan atau mengubahnya.
- Di sumber, baris kutipan/hadits yang diawali tanda '>' jadikan type "quote".
- Judul/uraian bab singkat boleh "heading_2" atau "heading_3"; daftar berbutir pakai "bulleted_list_item".
- Pisahkan uraian panjang menjadi paragraf-paragraf yang wajar. Jangan sertakan baris judul entri.
- Ikuti gaya blok pada CONTOH yang diberikan bila ada.
"""


async def format_material(material: str, title: str, references: list[str], cfg) -> list[dict]:
    parsed = await _call_ai(material, title, references, cfg)
    if not parsed:
        parsed = _fallback(material)
    blocks = [b for b in (_to_block(item) for item in parsed) if b]
    if not blocks:
        blocks = _fallback(material)
    return blocks


async def _call_ai(material: str, title: str, references: list[str], cfg) -> list[dict] | None:
    parts: list[str] = []
    if references:
        parts.append("CONTOH ENTRI YANG SUDAH ADA (acuan gaya):\n" + "\n\n".join(references))
    parts.append("JUDUL ENTRI:\n" + title)
    parts.append("MATERI MENTAH:\n" + material)

    payload = {
        "model": cfg.ai_model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": "\n\n".join(parts)},
        ],
        "temperature": 0.2,
    }
    headers = {"Authorization": f"Bearer {cfg.ai_api_key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f"{cfg.ai_base_url}/chat/completions", headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception:  # noqa: BLE001 - fallback apa pun ke pemecahan sederhana
        return None
    choices = data.get("choices") or []
    if not choices:
        return None
    content = _extract_text(choices[0].get("message") or {})
    if not content:
        return None
    return _parse_blocks(content)


def _extract_text(message: dict) -> str | None:
    """Ambil teks dari message; tangani content null/list dan reasoning_content."""
    for key in ("content", "reasoning_content"):
        value = message.get(key)
        if isinstance(value, list):
            value = "".join(part.get("text", "") for part in value if isinstance(part, dict))
        if isinstance(value, str) and value.strip():
            return value
    return None


def _parse_blocks(content: str | None) -> list[dict] | None:
    if not content:
        return None
    text = content.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    blocks = data.get("blocks")
    return blocks if isinstance(blocks, list) else None


def _to_block(item: dict) -> dict | None:
    if not isinstance(item, dict):
        return None
    btype = item.get("type", "paragraph")
    text = (item.get("text") or "").strip()
    if btype == "divider":
        return {"object": "block", "type": "divider", "divider": {}}
    if not text:
        return None
    if btype not in _ALLOWED:
        btype = "paragraph"
    rich = [
        {"type": "text", "text": {"content": text[i : i + 2000]}}
        for i in range(0, len(text), 2000)
    ]
    return {
        "object": "block",
        "type": btype,
        btype: {"rich_text": rich},
    }


def _fallback(material: str) -> list[dict]:
    parts = [p.strip() for p in re.split(r"\n\s*\n", material) if p.strip()]
    if not parts:
        parts = [material.strip()]
    return [{"type": "paragraph", "text": p} for p in parts]
