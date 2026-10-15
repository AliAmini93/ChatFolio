#!/usr/bin/env python3
"""Audit a local PDF without printing or uploading any conversation content.

Only page counts, dimensions, per-page text-length thresholds and image counts
are reported. The PDF and its extracted text never leave the local machine.
This cannot prove message completeness or media correctness versus a provider.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import fitz


def audit_pdf(path: Path, *, near_empty_threshold: int = 50) -> dict:
    if near_empty_threshold < 0:
        raise ValueError("near_empty_threshold must be nonnegative")
    with fitz.open(path) as document:
        if document.is_encrypted:
            raise ValueError("Encrypted PDF: unlock it locally before auditing")
        pages = len(document)
        chars_per_page = []
        images = 0
        a4_pages = 0
        for page in document:
            # Never retain or report raw conversation text. PDF extraction is
            # used only for simple local length measurements.
            chars_per_page.append(len(page.get_text().strip()))
            images += len(page.get_images(full=True))
            if (abs(page.rect.width - 595.28) <= 3 and
                    abs(page.rect.height - 841.89) <= 3):
                a4_pages += 1

    nearly_empty = [index + 1 for index, size in enumerate(chars_per_page)
                    if size < near_empty_threshold]
    summary = {
        "pages": pages,
        "a4_portrait_pages": a4_pages,
        "pages_with_selectable_text": sum(n > 0 for n in chars_per_page),
        "total_selectable_characters": sum(chars_per_page),
        "embedded_image_instances": images,
        "near_empty_pages": nearly_empty,
    }
    warnings = []
    if pages == 0:
        warnings.append("PDF has zero pages.")
    if pages and sum(chars_per_page) == 0:
        warnings.append("No selectable text: the PDF may be image-only.")
    if a4_pages != pages:
        warnings.append("Not all pages are portrait A4.")
    if nearly_empty:
        warnings.append("Some pages contain little selectable text; inspect locally.")
    summary["warnings"] = warnings
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="Local PDF file; never uploaded")
    parser.add_argument("--near-empty-threshold", type=int, default=50)
    args = parser.parse_args()
    try:
        result = audit_pdf(args.pdf, near_empty_threshold=args.near_empty_threshold)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(2, f"Unable to inspect local PDF: {type(error).__name__}: {error}\n")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["pages"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
