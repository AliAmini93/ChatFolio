# ChatFolio

ChatFolio is a Chrome extension that exports conversations from ChatGPT, Claude, and Gemini to PDF.

## Supported platforms

- ChatGPT
- Claude
- Gemini

## Features

- Full-conversation scanning for long chats
- Stop and stall-recovery controls
- User/assistant separation
- Multilingual RTL/LTR layout
- Tables, code blocks, links, images, and detected attachments
- Comfortable and Compact reading density
- Light, Graphite, and Dark extension themes
- Local preference storage

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extension folder that contains `manifest.json`.

## Usage

1. Open a conversation in ChatGPT, Claude, or Gemini.
2. Open ChatFolio from the Chrome toolbar.
3. Choose the reading density and options you want.
4. Click **Export full chat**.
5. In Chrome's print dialog, choose **Save to PDF**.

For a cleaner PDF, disable **Headers and footers** in Chrome's print dialog.

## Privacy

ChatFolio processes conversation content in the browser to create the printable document. It does not send conversation content to a ChatFolio-controlled server. When image embedding is enabled, the extension may fetch image resources from the AI provider domains that already host those resources.

See [PRIVACY.md](PRIVACY.md).

## Known limitations

- ChatGPT, Claude, and Gemini can change their page structure without notice. Provider UI changes may temporarily affect extraction.
- Some historical attachments may no longer be represented in the provider's page DOM and therefore cannot always be reconstructed in the PDF.
- Browser-added print headers/footers are controlled by Chrome, not ChatFolio.

## License

MIT. See [LICENSE](LICENSE).

## Trademark notice

ChatGPT, Claude, Gemini, OpenAI, Anthropic, and Google are trademarks of their respective owners. ChatFolio is not affiliated with or endorsed by those companies.
