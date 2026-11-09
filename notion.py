"""Klien Notion API untuk bot Tadwin."""
from __future__ import annotations

import re

import httpx

NOTION_API = "https://api.notion.com/v1"
_HEX32 = re.compile(r"[0-9a-fA-F]{32}")
_MAX_CHILDREN = 100


class NotionError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"Notion API error {status}: {body[:500]}")
        self.status = status
        self.body = body


def parse_page_id(url_or_id: str) -> str:
    """Ambil Page ID (UUID) dari link Notion atau ID mentah."""
    raw = url_or_id.strip().split("?")[0].split("#")[0]
    matches = _HEX32.findall(raw.replace("-", ""))
    if not matches:
        raise ValueError("Tidak menemukan Page ID pada link/ID yang diberikan.")
    h = matches[-1].lower()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def rich_text(text: str) -> list[dict]:
    """Pecah teks > 2000 karakter agar lolos batas per rich_text Notion."""
    if not text:
        text = " "
    return [
        {"type": "text", "text": {"content": text[i : i + 2000]}}
        for i in range(0, len(text), 2000)
    ]


def _plain(block: dict) -> str:
    btype = block.get("type")
    obj = block.get(btype, {}) if btype else {}
    parts = obj.get("rich_text", []) if isinstance(obj, dict) else []
    return "".join(p.get("plain_text", "") for p in parts)


class NotionClient:
    def __init__(self, token: str, version: str = "2026-03-11", timeout: float = 60.0):
        self._version = version
        self._auth = f"Bearer {token}"
        self._client = httpx.AsyncClient(base_url=NOTION_API, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    @property
    def _headers(self) -> dict:
        return {
            "Authorization": self._auth,
            "Notion-Version": self._version,
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        resp = await self._client.request(method, path, headers=self._headers, **kwargs)
        if resp.status_code >= 300:
            raise NotionError(resp.status_code, resp.text)
        return resp.json()

    async def get_children(self, block_id: str) -> list[dict]:
        """Ambil semua blok anak (dengan paginasi)."""
        out: list[dict] = []
        cursor = None
        while True:
            params = {"page_size": 100}
            if cursor:
                params["start_cursor"] = cursor
            data = await self._request("GET", f"/blocks/{block_id}/children", params=params)
            out.extend(data.get("results", []))
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
        return out

    async def find_toggle_examples(self, page_id: str, max_examples: int = 3) -> list[str]:
        """Kumpulkan contoh entri (toggle heading) yang sudah ada sebagai acuan format."""
        examples: list[str] = []
        for block in await self.get_children(page_id):
            if len(examples) >= max_examples:
                break
            btype = block.get("type")
            if btype not in ("heading_1", "heading_2", "heading_3"):
                continue
            obj = block.get(btype, {})
            if not obj.get("is_toggleable"):
                continue
            lines = [f"### {_plain(block)}"]
            if block.get("has_children"):
                for child in await self.get_children(block["id"]):
                    if child.get("type") == "divider":
                        lines.append("---")
                        continue
                    text = _plain(child)
                    if text:
                        lines.append(f"[{child.get('type')}] {text}")
            examples.append("\n".join(lines))
        return examples

    async def upload_file(self, filename: str, content_type: str, data: bytes) -> str:
        """Unggah file via File Upload API, kembalikan file_upload id."""
        init = await self._request(
            "POST",
            "/file_uploads",
            json={"filename": filename, "content_type": content_type},
        )
        upload_id = init["id"]
        resp = await self._client.post(
            f"/file_uploads/{upload_id}/send",
            headers={"Authorization": self._auth, "Notion-Version": self._version},
            files={"file": (filename, data, content_type)},
        )
        if resp.status_code >= 300:
            raise NotionError(resp.status_code, resp.text)
        return upload_id

    async def append_children(self, block_id: str, children: list[dict]) -> list[dict]:
        results = []
        for i in range(0, len(children), _MAX_CHILDREN):
            chunk = children[i : i + _MAX_CHILDREN]
            results.append(
                await self._request("PATCH", f"/blocks/{block_id}/children", json={"children": chunk})
            )
        return results

    async def append_entry(
        self,
        page_id: str,
        title: str,
        audio_upload_id: str | None,
        image_upload_id: str | None,
        image_caption: str,
        text_blocks: list[dict],
    ) -> str:
        """Buat satu toggle heading_1 (audio -> gambar -> teks) di halaman, kembalikan block id."""
        media: list[dict] = []
        if audio_upload_id:
            media.append(
                {
                    "object": "block",
                    "type": "audio",
                    "audio": {"type": "file_upload", "file_upload": {"id": audio_upload_id}},
                }
            )
        if image_upload_id:
            image: dict = {"type": "file_upload", "file_upload": {"id": image_upload_id}}
            if image_caption:
                image["caption"] = rich_text(image_caption)
            media.append({"object": "block", "type": "image", "image": image})

        cap = _MAX_CHILDREN - len(media)
        first, rest = text_blocks[:cap], text_blocks[cap:]

        heading = {
            "object": "block",
            "type": "heading_1",
            "heading_1": {
                "rich_text": rich_text(title),
                "color": "default",
                "is_toggleable": True,
                "children": media + first,
            },
        }
        resp = await self._request("PATCH", f"/blocks/{page_id}/children", json={"children": [heading]})
        heading_id = resp["results"][0]["id"]
        if rest:
            await self.append_children(heading_id, rest)
        return heading_id
