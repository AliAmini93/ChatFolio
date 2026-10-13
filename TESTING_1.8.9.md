# ChatFolio 1.8.9 - Media extraction verification

## Problem reports

- Claude: PDF contained the user text but lost an attached screenshot displayed next to the user message in the live UI.
- Gemini: PDF displayed `Uploaded image preview` with a broken image instead of the user's uploaded picture.

## Implementation

- Append authenticated user image media from sibling DOM wrappers, only within the same Claude render turn or Gemini conversation container; exclude model responses/toolbars.
- Normalize actual image data from `img`, lazy sources, CSS background images or canvas elements.
- First try page fetch; then existing extension-origin data resource route; finally a picture-only visible-tab crop when the entire picture is visible in the viewport.
- Explicit incomplete-image warning stops semantic export if embedding remains impossible when `embedImages` is enabled.
- ChatGPT's original image embed path and all scanner methods are unchanged.

## Synthetic Chromium results

- `python tests/test_upload_images_189.py`: four user-image fixtures (Claude sibling image; Gemini user image; Gemini sibling image; Claude background picture) PASS.
- `python tests/test_upload_capture_fallback_189.py`: two live-loaded but CORS-blocked source image fixtures; local capture crop yields an embedded JPEG for Claude and Gemini PASS.
- `python tests/test_media_pdf_189.py`: generated a Chrome A4 PDF containing a user's 640 x 360 attached image; `pdfimages -list` verified embedded 640 x 360 picture PASS.
- `python tests/test_grouped_renderer.py` and `python tests/test_layout_186.py`: PASS.
- Previous synthetic scanner/print tests remain unchanged. The full legacy suite should be rerun before stable release.

## Manual acceptance checks (required)

1. Export the exact short Claude conversation with the Ubuntu screenshot. The user message must include the screenshot and report one media.
2. Export the Gemini screenshot conversation; the fifth user message should include its actual picture, not `Uploaded image preview` or a broken icon.
3. Test an image larger than one viewport, with the photo visible before export.
4. Compare captured image counts, message counts, URLs and output quality. Do not publish the user's conversation or screenshot as a repository fixture.
5. If image embedding fails, confirm normal export stops with a clear warning and that Visual Backup remains manually available.
