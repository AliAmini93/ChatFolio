# ChatFolio Privacy Policy

Last updated: October 15, 2026

ChatFolio is a browser extension for exporting supported AI conversations to PDF.

## Data handling

ChatFolio processes conversation content locally in the user's browser in order to create the printable export. ChatFolio does not operate a server that receives or stores conversation content.

For ChatGPT, ChatFolio may make an authenticated, same-provider request from the open ChatGPT tab to ChatGPT's own conversation metadata endpoint to retrieve the complete active conversation branch when the page uses virtualization. A short-lived ChatGPT access token may be read in memory for that request. ChatFolio does not store, log, export, or send that token to a ChatFolio-controlled service. If this metadata path is unavailable, ChatFolio falls back to page-DOM extraction.

When the user enables conversation-image embedding, ChatFolio may request image resources from the same provider or content-delivery domains that host those images. These requests are used only to include the images in the export.

To preserve the typography of the active AI service, ChatFolio may also read the provider page's font-face declarations and request the corresponding font resources from that provider or its static-content domains. When available, those font bytes are embedded directly into the temporary printable document and are not sent to a ChatFolio-controlled service or stored as user data.

## Data collection

ChatFolio does not collect analytics, advertising identifiers, account credentials, browsing history, or conversation content for a ChatFolio-controlled service.

## Local storage

The extension may store local preferences such as theme, reading density, message-number visibility, image inclusion, and export-time display using Chrome extension storage. These settings remain in the user's browser unless the user clears extension data or removes the extension.

For print-preview recovery, ChatFolio may temporarily save a **completed** printable conversation (including embedded images and text) in IndexedDB under the extension's own browser origin. This local snapshot allows the print view to be restored if Chrome suspends its service worker after the transfer completes. It is deleted when the print view confirms consumption, when a related tab closes, or through expiry cleanup after 10 minutes while the extension runs. If the browser or extension is not running, expired snapshots are cleaned up on the next service-worker activation. Snapshots are never uploaded to a ChatFolio service. Clearing the extension's website/storage data or uninstalling the extension removes them.

## Permissions

ChatFolio requests permissions needed to identify the active supported conversation, inject the exporter when the user asks for an export, preserve preferences, and access supported provider pages and their hosted media.

## Third-party services

ChatFolio works with pages provided by ChatGPT/OpenAI, Claude/Anthropic, and Gemini/Google. Those services have their own privacy policies and terms. ChatFolio is not affiliated with or endorsed by those companies.

## Contact

Project support and issue reporting are provided through the public ChatFolio GitHub repository.


## Visual archive fallback

If semantic conversation extraction is unavailable, ChatFolio may use Chrome's active-tab capture capability to create sequential screenshots while it scrolls the currently open AI conversation. These captures remain in the browser/extension process and are transferred only to ChatFolio's local print page for PDF creation. ChatFolio does not upload these captures to a ChatFolio-controlled server.
