# ChatFolio 1.8.10 — Gemini off-screen attachment regression

### Verified with synthetic Chromium fixtures

- `tests/test_gemini_offscreen_190.py`: nested and adjacent user-uploaded images at >1000px outside a scrollable viewport, with a `googleusercontent.com` image source and intentionally forbidden `fetch()`.
- During screenshot capture the image is scrolled into view; afterwards scrolling is restored to the original offset **0**.
- Correct cropped image pixels, imageCount=1, embedded=1, missing=0, blocked fetch calls=0.
- Earlier 1.8.9 upload tests, grouped ChatGPT responses, negative scrolling, PDF generation, print margin counters, print tables, layout and false scrollport detection also passed.
- `tests/test_scroller_184.py` has been made package-relative rather than relying on an old absolute build directory.

### Live validation still required

- Gemini chat 'ناتوانی در بررسی لینک اینستاگرام', with the user-uploaded image in message 5.
- The final PDF must show the actual image rather than 'Uploaded image preview', with all eight messages retained.
- Claude already passed on an actual user-uploaded image in build 1.8.9; do not regress that behavior.

If the provider removes the source image from the DOM, or if captureVisibleTab is unavailable, semantic export still stops with an explicit warning instead of silently omitting an attachment.
