# ChatFolio 1.8.3 — regression plan

1. Open a **Temporary ChatGPT** conversation with more than ten complete messages and several long replies.
2. Export full chat; verify every user and ChatGPT message and the actual text and images in the PDF.
3. Confirm the export does **not** unexpectedly enter Assisted Visual Backup.
4. Trigger a deliberately blocked scroller in a synthetic test; verify at most 3 recovery attempts, then a clear error without PDF generation.
5. Select Visual backup manually; verify Stop scan remains responsive.
6. Repeat existing Claude/Gemini exports.

Temporary Chat content should not be shared publicly as a diagnostic sample.
