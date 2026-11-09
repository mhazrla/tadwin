"""Cek koneksi: konfigurasi, Notion, dan endpoint AI.

Contoh:  python check.py "https://app.notion.com/p/....-3e53c08bb70580bdb75bd96e26538c7b"
"""
from __future__ import annotations

import asyncio
import sys

import httpx

from config import load_settings
from notion import NotionClient, parse_page_id


async def main() -> int:
    try:
        cfg = load_settings()
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL config: {exc}")
        return 1
    print("PASS config")

    notion = NotionClient(cfg.notion_token, cfg.notion_version)
    try:
        if len(sys.argv) > 1:
            try:
                page_id = parse_page_id(sys.argv[1])
                print(f"PASS page id: {page_id}")
                blocks = await notion.get_children(page_id)
                print(f"PASS notion: {len(blocks)} blok terbaca")
                refs = await notion.find_toggle_examples(page_id)
                print(f"INFO contoh toggle ditemukan: {len(refs)}")
            except Exception as exc:  # noqa: BLE001
                print(f"FAIL notion: {exc}")
        else:
            print("INFO notion: tidak diuji (tidak ada link halaman diberikan)")
    finally:
        await notion.aclose()

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{cfg.ai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {cfg.ai_api_key}", "Content-Type": "application/json"},
                json={
                    "model": cfg.ai_model,
                    "messages": [{"role": "user", "content": "Balas dengan satu kata: pong"}],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            print(f"PASS AI: {content[:80]}")
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL AI: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
