# ADR 0005B1: Recovering completed print previews

Status: experimental, Phase 5B1. Stable release **v1.8.11 is unchanged**.

## Problem
The classic Manifest V3 service worker holds print-transfer chunks only in a JavaScript Map. A restart after the transfer is complete but before the print page consumes them makes its existing port return "job expired", even when the source finished successfully.

## Decision
Save **completed** bounded jobs in extension-origin IndexedDB before acknowledging PRINT_END. Recreate the in-memory job on a print page's PRINT_READY when the worker Map is empty. On a port reconnect, replay all chunks from index zero; the print page overwrites by index and assembles only after a complete END. Keep print data under the extension origin, never send it to third-party servers.

- Retain 5A per-chunk and cumulative size limits.
- Reject requests with missing/expired or malformed snapshots.
- Tie recovery to the original print tab ID when Chrome exposes it.
- Clear stored data after PRINT_CONSUMED, on closing a related tab and after a 10-minute TTL; periodically prune stale records.
- Keep the old memory-only path where IndexedDB is unavailable, such as existing Node test stubs.
- If storage fails, do **not** acknowledge a completed job as successfully persisted.

## Scope and limitations
This step recovers only jobs for which PRINT_END was durably acknowledged. It **does not resume incomplete source-to-background chunk transfers** after worker suspension. That is the separate Phase 5B2 scope. IndexedDB quota errors may reject a large archive rather than silently promising recovery. A completed snapshot may remain on local disk for at most its TTL while the extension is active; if the extension is not running, expiry removal occurs at the next worker start. No manifest permission or provider request changes.

## Acceptance
Node unit tests, the existing Chromium suite and the additional synthetic worker-restart regression must all pass. Also test a real larger PDF before promoting this refactor to a new public release.