# ChatFolio v1.8.11 release checklist

## Verified in this build
- [x] Manifest V3 and `manifest.json` version `1.8.11`
- [x] Chrome ZIP contains only runtime assets and icons
- [x] Chrome ZIP runtime bytes match the source tree
- [x] JavaScript syntax validation and Python test syntax validation
- [x] Synthetic Chromium checks: Gemini uploads (including off-screen/CORS), Claude uploads, print/pagination, negative scrolling, grouped responses, table headers
- [x] Real PDF smoke tests on ChatGPT, Claude, and Gemini
- [x] No private conversation PDFs or uploaded screenshots included in the source/release ZIP

## GitHub publishing
- [ ] Merge the reviewed v1.8.11 update into `main`
- [ ] Pull updated `main` into local repository
- [ ] Set the repository About description and topics
- [ ] Create and push annotated tag `v1.8.11`
- [ ] Publish `v1.8.11` as the latest stable release
- [ ] Upload `chatfolio-1.8.11-chrome.zip` as the release asset
- [ ] Verify downloadable ZIP and tag in GitHub release UI

## Chrome Web Store (optional, separate distribution step)
- [ ] Review Store listing screenshots and permissions
- [ ] Upload the new ZIP to the Chrome Web Store developer dashboard
- [ ] Review privacy/data-use disclosures and submit update
