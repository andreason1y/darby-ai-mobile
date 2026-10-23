#!/usr/bin/env python3
"""Client for the Centralized Legal DB API (Supreme Court rulings and regulations)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Mapping, Sequence
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict


DEFAULT_SEARCH_PATH = "/v1/search"
DEFAULT_DOCUMENT_PATH = "/v1/documents"
DEFAULT_SCOPE = "all"
SCOPES = ("all", "putusan", "regulasi")


class LegalDBError(Exception):
    """Any failure while talking to the Legal DB API."""


class LegalDBConfigError(LegalDBError):
    """The client is not configured with an API base URL."""


class LegalDocument(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str | None = None
    type: str | None = None
    title: str | None = None
    nomor: str | None = None
    tahun: int | None = None
    snippet: str | None = None
    citation: str | None = None
    url: str | None = None
    score: float | None = None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _integer(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first(item: Mapping[str, Any], names: Sequence[str]) -> Any:
    for name in names:
        if name in item and item[name] not in (None, ""):
            return item[name]
    return None


def _document_type(item: Mapping[str, Any], scope: str) -> str | None:
    raw = _text(_first(item, ("type", "doc_type", "document_type", "kategori")))
    if raw:
        lowered = raw.lower()
        if "putus" in lowered or "court" in lowered or "yurisprud" in lowered:
            return "putusan"
        if any(word in lowered for word in ("regul", "undang", "peratur", "uu", "pp")):
            return "regulasi"
        if lowered in SCOPES:
            return lowered
        return raw
    if scope in {"putusan", "regulasi"}:
        return scope
    if _first(item, ("nomor_putusan", "putusan_id", "pengadilan", "majelis")):
        return "putusan"
    if _first(item, ("nomor_peraturan", "jenis_peraturan", "status_berlaku")):
        return "regulasi"
    return None


def _normalise_document(
    item: Any, scope: str
) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        value = _text(item) or ""
        return {"id": value, "title": value}

    data = dict(item)
    document_id = _text(
        _first(item, ("id", "doc_id", "document_id", "putusan_id", "regulasi_id", "_id"))
    )
    title = _text(_first(item, ("title", "judul", "nama_dokumen", "nama")))
    nomor = _text(
        _first(
            item,
            (
                "nomor",
                "number",
                "nomor_putusan",
                "nomor_peraturan",
                "nomor_regulasi",
            ),
        )
    )
    snippet = _text(
        _first(
            item,
            (
                "snippet",
                "excerpt",
                "ringkasan",
                "summary",
                "abstrak",
                "text",
                "content",
            ),
        )
    )
    citation = _text(_first(item, ("citation", "sitasi", "cite", "referensi")))
    url = _text(_first(item, ("url", "pdf_url", "document_url", "link", "tautan")))
    score = _number(_first(item, ("score", "relevance", "similarity", "rank")))
    tahun = _integer(_first(item, ("tahun", "year", "tanggal_tahun")))

    data.update(
        {
            "id": document_id,
            "type": _document_type(item, scope),
            "title": title or citation or nomor,
            "nomor": nomor,
            "tahun": tahun,
            "snippet": snippet,
            "citation": citation,
            "url": url,
            "score": score,
        }
    )
    try:
        return LegalDocument.model_validate(data).model_dump(exclude_none=True)
    except Exception as exc:
        raise LegalDBError(f"Unexpected document shape from the Legal DB: {exc}") from exc


def _unwrap_documents(data: Any) -> tuple[list[Any], int | None, dict[str, Any]]:
    if isinstance(data, list):
        return data, len(data), {}
    if not isinstance(data, Mapping):
        raise LegalDBError("The Legal DB returned a response that is not JSON.")

    items: list[Any] | None = None
    for key in ("results", "data", "items", "hits", "documents"):
        value = data.get(key)
        if isinstance(value, list):
            items = value
            break
    if items is None:
        items = []
    total = _integer(_first(data, ("total", "total_results", "count", "num_found")))
    meta = data.get("meta") if isinstance(data.get("meta"), Mapping) else {}
    return items, total, dict(meta)


class LegalDBClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        *,
        timeout: float | None = None,
        retries: int = 1,
        search_path: str | None = None,
        document_path: str | None = None,
    ) -> None:
        resolved = (base_url or os.environ.get("LEGAL_DB_API_URL") or "").strip()
        if not resolved:
            raise LegalDBConfigError(
                "LEGAL_DB_API_URL is not set. Point it at the Centralized Legal DB API."
            )
        self.base_url = resolved.rstrip("/")
        self.api_key = (api_key or os.environ.get("LEGAL_DB_API_KEY") or "").strip()
        self.timeout = timeout or float(
            os.environ.get("LEGAL_DB_TIMEOUT", "30") or 30
        )
        self.retries = max(0, retries)
        self.search_path = search_path or os.environ.get(
            "LEGAL_DB_SEARCH_PATH", DEFAULT_SEARCH_PATH
        )
        self.document_path = document_path or os.environ.get(
            "LEGAL_DB_DOCUMENT_PATH", DEFAULT_DOCUMENT_PATH
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "legal-agent-computer/1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{self.base_url}/{path.lstrip('/')}"

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = self._url(path)
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                with httpx.Client(
                    timeout=self.timeout, follow_redirects=False
                ) as client:
                    response = client.request(
                        method, url, headers=self._headers(), **kwargs
                    )
            except httpx.TimeoutException as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(min(0.5 * (attempt + 1), 2.0))
                    continue
                raise LegalDBError(
                    f"The Legal DB API timed out after {self.timeout:g}s."
                ) from exc
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(min(0.5 * (attempt + 1), 2.0))
                    continue
                raise LegalDBError(f"Could not reach the Legal DB API: {exc}") from exc

            if response.status_code in {429, 500, 502, 503, 504} and attempt < self.retries:
                delay = _retry_delay(response)
                if delay is not None:
                    time.sleep(min(delay, 5.0))
                    continue

            if response.status_code >= 400:
                detail = _error_detail(response)
                raise LegalDBError(
                    f"Legal DB API returned HTTP {response.status_code}: {detail}"
                )

            try:
                return response.json()
            except ValueError as exc:
                raise LegalDBError(
                    "The Legal DB API returned a success response that is not JSON."
                ) from exc

        raise LegalDBError(f"The Legal DB API request failed: {last_error}")

    def search(
        self,
        query: str,
        *,
        scope: str = DEFAULT_SCOPE,
        limit: int = 10,
        filters: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise LegalDBError("A search query is required.")
        if scope not in SCOPES:
            raise LegalDBError(
                f"scope must be one of {', '.join(SCOPES)}; got {scope!r}."
            )
        if limit < 1 or limit > 50:
            raise LegalDBError("limit must be between 1 and 50.")
        payload: dict[str, Any] = {
            "query": query,
            "scope": scope,
            "limit": limit,
        }
        if filters:
            payload["filters"] = dict(filters)
        data = self._request("POST", self.search_path, json=payload)
        items, total, meta = _unwrap_documents(data)
        results = [_normalise_document(item, scope) for item in items]
        return {
            "ok": True,
            "query": query,
            "scope": scope,
            "total": total if total is not None else len(results),
            "results": results,
            "meta": meta,
        }

    def search_putusan(
        self, query: str, *, limit: int = 10, filters: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return self.search(query, scope="putusan", limit=limit, filters=filters)

    def search_regulasi(
        self, query: str, *, limit: int = 10, filters: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return self.search(query, scope="regulasi", limit=limit, filters=filters)

    def get_document(self, document_id: str) -> dict[str, Any]:
        document_id = document_id.strip()
        if not document_id:
            raise LegalDBError("A document id is required.")
        data = self._request(
            "GET",
            f"{self.document_path.rstrip('/')}/{quote(document_id, safe='')}",
        )
        if isinstance(data, Mapping):
            for key in ("document", "data", "result"):
                value = data.get(key)
                if isinstance(value, Mapping):
                    data = value
                    break
        if not isinstance(data, Mapping):
            raise LegalDBError("The Legal DB returned an unexpected document shape.")
        return {
            "ok": True,
            "document": LegalDocument.model_validate(dict(data)).model_dump(
                exclude_none=True
            ),
        }


def _retry_delay(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, Mapping):
        for key in ("error", "message", "detail", "error_message"):
            value = payload.get(key)
            if value:
                return str(value)[:500]
    text = (response.text or "").strip()
    return (text[:500] if text else "no error detail")


def _parse_filters(raw: str | None) -> dict[str, Any] | None:
    if raw is None or not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LegalDBError(f"--filters-json is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise LegalDBError("--filters-json must decode to a JSON object.")
    return value


def _client_from_args(args: argparse.Namespace) -> LegalDBClient:
    return LegalDBClient(
        base_url=args.api_url,
        api_key=args.api_key,
        timeout=args.timeout,
        retries=args.retries,
    )


def _print_human(result: Mapping[str, Any]) -> None:
    if "document" in result:
        document = result["document"]
        print(f"{document.get('type', 'document')}: {document.get('title', document.get('id', ''))}")
        for key in ("nomor", "tahun", "citation", "url", "snippet"):
            value = document.get(key)
            if value:
                print(f"{key}: {value}")
        return
    results = result.get("results", [])
    print(f"{result.get('total', len(results))} results for {result.get('query', '')!r}")
    for index, document in enumerate(results, start=1):
        label = document.get("type") or "document"
        title = document.get("title") or document.get("id") or "(untitled)"
        print(f"{index}. [{label}] {title}")
        for key in ("nomor", "tahun", "citation", "snippet", "url", "score"):
            value = document.get(key)
            if value:
                print(f"   {key}: {value}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Query the Centralized Legal DB API."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--api-url",
        default=None,
        help="Legal DB base URL (default: LEGAL_DB_API_URL).",
    )
    common.add_argument(
        "--api-key",
        default=None,
        help="Bearer token (default: LEGAL_DB_API_KEY). Prefer the environment variable.",
    )
    common.add_argument(
        "--timeout", type=float, default=30.0, help="Request timeout in seconds."
    )
    common.add_argument(
        "--retries", type=int, default=1, help="Retries for transient failures."
    )
    common.add_argument("--json", action="store_true", help="Print JSON.")

    search_parser = subparsers.add_parser(
        "search", parents=[common], help="Search rulings and regulations."
    )
    search_parser.add_argument("query", help="Search query.")
    search_parser.add_argument(
        "--scope", choices=SCOPES, default=DEFAULT_SCOPE, help="Document scope."
    )
    search_parser.add_argument("--limit", type=int, default=10, help="Maximum results.")
    search_parser.add_argument(
        "--filters-json",
        default=None,
        help='Optional JSON object, for example {"tahun": 2024}.',
    )

    get_parser = subparsers.add_parser(
        "get", parents=[common], help="Fetch one document by id."
    )
    get_parser.add_argument("document_id", help="Document id.")

    args = parser.parse_args(argv)
    try:
        client = _client_from_args(args)
        if args.command == "search":
            result = client.search(
                args.query,
                scope=args.scope,
                limit=args.limit,
                filters=_parse_filters(args.filters_json),
            )
        else:
            result = client.get_document(args.document_id)
    except LegalDBError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False),
              file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        _print_human(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
