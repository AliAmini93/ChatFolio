# Provider adapters (migration target)

This directory will contain isolated ChatGPT, Claude and Gemini implementations
in phase 3. The provider-independent contracts already live in `src/core/`.

Do not copy the legacy `createPlatformAdapter()` into three new files until the
new adapters can run against the existing DOM/browser regression fixtures.
The MV3 injector currently loads `content.js`, which remains the authoritative
production implementation during this phase.
