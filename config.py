"""Konfigurasi aplikasi yang dibaca dari file .env."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    notion_token: str
    notion_version: str
    ai_base_url: str
    ai_api_key: str
    ai_model: str


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Variabel {name} belum diisi di .env (lihat .env.example).")
    return value


def load_settings() -> Settings:
    return Settings(
        telegram_bot_token=_required("TELEGRAM_BOT_TOKEN"),
        notion_token=_required("NOTION_TOKEN"),
        notion_version=os.getenv("NOTION_VERSION", "2026-03-11").strip(),
        ai_base_url=_required("AI_BASE_URL").rstrip("/"),
        ai_api_key=_required("AI_API_KEY"),
        ai_model=_required("AI_MODEL"),
    )
