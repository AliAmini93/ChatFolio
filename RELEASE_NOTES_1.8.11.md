# ChatFolio v1.8.11

**Stable release — Chrome / Chromium (Manifest V3)**

ChatFolio exports ChatGPT, Claude, and Gemini conversations into readable, searchable PDFs, with an assisted screenshot-based Visual Backup when semantic export is not possible.

## What is new since v1.8.8

- **Claude and Gemini image uploads:** capture user-attached screenshots and photos even when image previews are outside the message text element.
- **Gemini protected images:** handle `googleusercontent.com` image access restrictions with an exact on-page image crop; for off-screen images, scroll into view, capture, and restore the conversation position.
- **Gemini pagination:** allow long opening paragraphs to flow across A4 pages instead of leaving a large blank region on the first page.
- **Fail safely:** avoid silently exporting a known missing user image; show a clear error and keep Visual Backup available manually.
- Retain v1.8.8 improvements to reverse ChatGPT scrolling, table headers, page numbers, compact source chips, RTL/LTR text, and safe Temporary Chat handling.

## Validation

- Real ChatGPT conversation: 16 messages with mixed images/tables/links captured and paginated.
- Real Claude screenshot conversation: 4 messages with the uploaded user image embedded.
- Real Gemini conversation: 8 messages with uploaded user image embedded and page-one whitespace corrected.
- Automated Chromium regression tests for off-screen image recovery, grouped answers, negative scroll, long-text pagination, tables, print counters and citations.

## Install or upgrade

1. Download `chatfolio-1.8.11-chrome.zip` from the assets below and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** for the extracted folder containing `manifest.json`.
3. Disable other unpacked ChatFolio versions to prevent running two copies.
4. Open a ChatGPT, Claude or Gemini conversation, select **Export full chat**, then **Save as PDF** in the print dialog.

**Important:** Do not refresh an open Temporary Chat just to upgrade the extension. Keep the existing tab available.

## Limitations

Chat providers may change their DOM and media access rules at any time. If semantic extraction is blocked, use assisted Visual Backup; that mode creates an image-based PDF rather than selectable text. Historical images that are no longer available from their providers may be unrecoverable.

ChatFolio is open source (MIT) and is not affiliated with OpenAI, Anthropic or Google.
