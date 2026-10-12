# ChatFolio v1.8.6 - layout regression

Problem report: 15-page PDF named "خرید ست لطافه(1).pdf" rendered all 16 messages but showed large white gaps, especially pages 1, 3 and 11. The source file itself is not included in this release.

The collected conversation content was left untouched. The print clone now drops application-specific class/data hooks and inline flex/grid/height/spacing hints, while keeping KaTeX and code-class subtrees. Product cards may split between text blocks on adjacent PDF pages without splitting image media. This targets source-page layout rules bleeding into the extension's live-page print view.

In browser-only A4 fixture tests, page one contained 346 extractable characters without the new normalization and 722 with it, with the same 856 total characters in both PDF outputs. Both fixtures have two pages; no page-count reduction is claimed for the real conversation. A fully representative test requires re-exporting the original Temporary Chat.

Tests:

  python tests/test_layout_186.py
  python tests/test_grouped_renderer.py
  python tests/test_negative_scroll_185.py
  python tests/test_scroller_184.py

When using Chrome Print, turn **Headers and footers OFF** (Chrome adds those; JavaScript cannot force them off).

Manual acceptance checklist:
- Original 16 messages = 8 user and 8 ChatGPT replies
- No large blank runs before product/result cards on pages 1, 3 and 11
- Images are visible at natural compact sizes, not missing or distorted
- Persian/English text, tables, source references and links are present
- Scrolling completes without a stall and Stop remains responsive
