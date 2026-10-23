#!/usr/bin/env python3
"""Extract text from digital and scanned PDFs with PyMuPDF and Tesseract OCR."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

try:
    import pymupdf as fitz
except ImportError:  # older PyMuPDF releases only ship the fitz module
    import fitz


DEFAULT_LANGUAGE = "ind+eng"


class PdfExtractionError(Exception):
    """A PDF or OCR problem that should be reported to the caller."""


def _parse_pages(spec: str | None, page_count: int) -> list[int]:
    if spec is None or not spec.strip():
        return list(range(page_count))
    selected: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start_text, end_text = chunk.split("-", 1)
            try:
                start = int(start_text)
                end = int(end_text)
            except ValueError as exc:
                raise PdfExtractionError(
                    f"Invalid page range {chunk!r}; use numbers such as 1-5."
                ) from exc
            if start < 1 or end < start or end > page_count:
                raise PdfExtractionError(
                    f"Page range {chunk!r} is outside 1-{page_count}."
                )
            selected.update(range(start - 1, end))
        else:
            try:
                page = int(chunk)
            except ValueError as exc:
                raise PdfExtractionError(
                    f"Invalid page number {chunk!r}."
                ) from exc
            if page < 1 or page > page_count:
                raise PdfExtractionError(
                    f"Page {page} is outside 1-{page_count}."
                )
            selected.add(page - 1)
    if not selected:
        raise PdfExtractionError("No pages were selected.")
    return sorted(selected)


def _tesseract_languages(binary: str) -> set[str]:
    try:
        result = subprocess.run(
            [binary, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if result.returncode != 0:
        return set()
    languages: set[str] = set()
    for line in result.stdout.splitlines():
        value = line.strip()
        if not value or value.startswith("List of available"):
            continue
        languages.add(value)
    return languages


def _resolve_languages(
    requested: str, binary: str, warnings: list[str]
) -> str:
    parts = [part.strip() for part in requested.split("+") if part.strip()]
    if not parts:
        raise PdfExtractionError("At least one Tesseract language is required.")
    available = _tesseract_languages(binary)
    if not available:
        return "+".join(parts)
    missing = [part for part in parts if part not in available]
    if not missing:
        return "+".join(parts)
    usable = [part for part in parts if part in available]
    if not usable:
        raise PdfExtractionError(
            "Tesseract has none of the requested languages "
            f"({', '.join(parts)}). Installed: {', '.join(sorted(available))}."
        )
    warnings.append(
        "Tesseract language(s) not installed: "
        f"{', '.join(missing)}; using {'+'.join(usable)}."
    )
    return "+".join(usable)


def _ocr_page(
    page: fitz.Page,
    *,
    binary: str,
    language: str,
    dpi: int,
    psm: int,
    timeout: int,
) -> str:
    pixmap = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
    payload = pixmap.tobytes("png")
    image_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="legal-ocr-", suffix=".png", delete=False
        ) as image:
            image.write(payload)
            image_path = image.name
        result = subprocess.run(
            [
                binary,
                image_path,
                "stdout",
                "-l",
                language,
                "--psm",
                str(psm),
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise PdfExtractionError(
            f"Tesseract timed out after {timeout}s on page {page.number + 1}."
        ) from exc
    except OSError as exc:
        raise PdfExtractionError(
            f"Could not run Tesseract at {binary!r}: {exc}"
        ) from exc
    finally:
        if image_path:
            try:
                os.unlink(image_path)
            except OSError:
                pass
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        message = detail[-1] if detail else f"exit code {result.returncode}"
        raise PdfExtractionError(
            f"Tesseract failed on page {page.number + 1}: {message}"
        )
    return result.stdout


def extract(
    input_path: Path,
    *,
    output_path: Path | None = None,
    language: str = DEFAULT_LANGUAGE,
    dpi: int = 300,
    ocr_mode: str = "auto",
    min_text_chars: int = 40,
    psm: int = 3,
    pages_spec: str | None = None,
    timeout: int = 120,
    include_text: bool = False,
    max_text_chars: int = 0,
    tesseract_binary: str | None = None,
) -> dict[str, Any]:
    if ocr_mode not in {"auto", "always", "never"}:
        raise PdfExtractionError("ocr mode must be auto, always, or never.")
    if dpi < 72 or dpi > 600:
        raise PdfExtractionError("dpi must be between 72 and 600.")
    if timeout < 1:
        raise PdfExtractionError("timeout must be a positive number of seconds.")
    if min_text_chars < 0:
        raise PdfExtractionError("min-text-chars cannot be negative.")

    try:
        document = fitz.open(input_path)
    except Exception as exc:
        raise PdfExtractionError(f"Could not open {input_path} as a PDF: {exc}") from exc

    if document.needs_pass:
        document.close()
        raise PdfExtractionError("The PDF is encrypted and needs a password.")

    page_count = document.page_count
    if page_count == 0:
        document.close()
        raise PdfExtractionError("The PDF contains no pages.")

    selected = _parse_pages(pages_spec, page_count)
    warnings: list[str] = []
    binary = tesseract_binary or os.environ.get("TESSERACT_BIN", "tesseract")
    resolved_language = (
        _resolve_languages(language, binary, warnings)
        if ocr_mode != "never"
        else language
    )

    page_reports: list[dict[str, Any]] = []
    page_texts: list[str] = []
    ocr_pages: list[int] = []
    total_chars = 0

    try:
        for index in selected:
            page = document.load_page(index)
            text = page.get_text("text").strip()
            method = "text"
            should_ocr = ocr_mode == "always" or (
                ocr_mode == "auto" and len(text) < min_text_chars
            )
            if should_ocr:
                try:
                    ocr_text = _ocr_page(
                        page,
                        binary=binary,
                        language=resolved_language,
                        dpi=dpi,
                        psm=psm,
                        timeout=timeout,
                    ).strip()
                except PdfExtractionError:
                    if ocr_mode == "always" or not text:
                        raise
                    warnings.append(
                        f"Page {index + 1}: OCR failed; kept the embedded text layer."
                    )
                    ocr_text = ""
                if ocr_text:
                    if ocr_mode == "auto" and len(ocr_text) < len(text):
                        warnings.append(
                            f"Page {index + 1}: OCR text was shorter than the "
                            "embedded text; kept the embedded text."
                        )
                    else:
                        text = ocr_text
                        method = "ocr"
                        ocr_pages.append(index + 1)
                elif ocr_mode == "always":
                    raise PdfExtractionError(
                        f"Tesseract returned no text for page {index + 1}."
                    )

            page_texts.append(text)
            total_chars += len(text)
            page_reports.append(
                {
                    "page": index + 1,
                    "method": method,
                    "chars": len(text),
                }
            )
    finally:
        document.close()

    full_text = "\n\n".join(page_texts)
    truncated = False
    if max_text_chars and len(full_text) > max_text_chars:
        full_text = full_text[:max_text_chars]
        truncated = True

    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("\n\n".join(page_texts), encoding="utf-8")

    report: dict[str, Any] = {
        "ok": True,
        "input": str(input_path),
        "output": str(output_path) if output_path is not None else None,
        "pageCount": page_count,
        "processedPages": len(selected),
        "language": resolved_language,
        "ocrMode": ocr_mode,
        "dpi": dpi,
        "psm": psm,
        "textChars": total_chars,
        "ocrPages": ocr_pages,
        "pages": page_reports,
        "warnings": warnings,
    }
    if include_text:
        report["text"] = full_text
        report["textTruncated"] = truncated
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract text from a PDF, OCRing scanned pages with Tesseract."
    )
    parser.add_argument("--input", required=True, help="Input PDF path.")
    parser.add_argument("--output", default=None, help="Optional UTF-8 text output path.")
    parser.add_argument("--json", action="store_true", help="Print a JSON report.")
    parser.add_argument(
        "--include-text",
        action="store_true",
        help="Include extracted text in the JSON report.",
    )
    parser.add_argument(
        "--max-text-chars",
        type=int,
        default=0,
        help="Truncate text in the JSON report at this many characters (0 = no limit).",
    )
    parser.add_argument(
        "--lang",
        default=DEFAULT_LANGUAGE,
        help="Tesseract languages joined with + (default: ind+eng).",
    )
    parser.add_argument("--dpi", type=int, default=300, help="OCR render DPI.")
    parser.add_argument(
        "--ocr",
        choices=("auto", "always", "never"),
        default="auto",
        help="OCR every page, never, or only when the text layer is too short.",
    )
    parser.add_argument(
        "--min-text-chars",
        type=int,
        default=40,
        help="Auto mode OCRs a page whose text layer is shorter than this.",
    )
    parser.add_argument(
        "--psm",
        type=int,
        default=3,
        help="Tesseract page segmentation mode (default: 3).",
    )
    parser.add_argument(
        "--pages",
        default=None,
        help="Pages to process, such as 1-5,8 (default: all).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Per-page Tesseract timeout in seconds.",
    )
    parser.add_argument(
        "--tesseract",
        default=None,
        help="Tesseract binary path (default: TESSERACT_BIN or tesseract).",
    )
    args = parser.parse_args(argv)

    try:
        report = extract(
            Path(args.input),
            output_path=Path(args.output) if args.output else None,
            language=args.lang,
            dpi=args.dpi,
            ocr_mode=args.ocr,
            min_text_chars=args.min_text_chars,
            psm=args.psm,
            pages_spec=args.pages,
            timeout=args.timeout,
            include_text=args.include_text,
            max_text_chars=args.max_text_chars,
            tesseract_binary=args.tesseract,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False),
              file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(report.get("text", ""))
        if args.output:
            print(f"Text written to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
