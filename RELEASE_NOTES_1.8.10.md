# ChatFolio v1.8.10 - Local test build

Fixes the remaining Gemini uploaded-image error observed in v1.8.9. Gemini can display an authenticated image from `lh3.googleusercontent.com` while blocking Chrome extension `fetch()` after a redirect, and an older message image may be outside the viewport after full-chat collection. ChatFolio now brings that image into view briefly, waits for loading, embeds a tight image-only screenshot crop and restores the original scroll positions.

- Claude uploaded-image handling is unchanged (confirmed to work in the user's PDF).
- Does not silently omit images if capture still fails.
- ChatGPT scanning/Stop and print layout are unchanged.
- Automated tests pass for off-screen image in and beside Gemini prompts, including nested scrollers and blocked fetches.

**Not published to GitHub.** Validate the original Gemini conversation before tagging a new release.
