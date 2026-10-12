# ChatFolio v1.8.8 pre-release checklist

## Extension package
- [x] Manifest V3; version is 1.8.8
- [x] Chrome ZIP contains runtime files, icons, privacy policy, and license, but no tests or personal chat exports
- [x] JS syntax checks and local DOM/print regression tests
- [x] Real ChatGPT Temporary Chat PDF export verified (16 messages, 11 pages)
- [ ] Real-world regression with multiple chats including Claude and Gemini

## GitHub
- [ ] Push v1.8.8 source to a feature branch with PR review
- [ ] Update main after verification
- [ ] Create `v1.8.8` pre-release tag / GitHub Release
- [ ] Attach `chatfolio-1.8.8-chrome.zip` (installable extension)
- [ ] Attach `chatfolio-1.8.8-source.zip` (optional full sources/tests)

## Public distribution
- [ ] Test with Chrome + recent Chromium print engine
- [ ] Confirm page numbering, tables, images, citations, RTL and code blocks in more samples
- [ ] Update Chrome Web Store only after independent smoke testing

The real Temporary Chat sample PDF contains personal shopping details and must never be committed as a fixture or attached to a public release.
