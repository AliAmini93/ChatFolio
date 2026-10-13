# ChatFolio v1.8.9 - Test Build

Fixes uploaded-image preservation in Claude and Gemini chat-to-PDF export. Handles media beside authored user text, authenticated/lazy image URLs, background previews and canvas images. Adds a local cropped screenshot fallback if Chrome cannot re-fetch an image already visible on screen. If an image cannot be preserved, semantic export reports a clear error rather than silently omitting it. ChatGPT conversation scanning and PDF pagination are unchanged.

This is a **local test build**, not a published GitHub release. Please validate on the original Claude and Gemini chats before tagging a release.
