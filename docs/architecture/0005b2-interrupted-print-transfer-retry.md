# ADR 0005B2: Retry an interrupted print transfer while its source tab is alive

Status: experimental, Phase 5B2. Published stable v1.8.11 remains unchanged.

## Problem

A Chrome MV3 service worker can lose its in-memory partial Print Job before receiving PRINT_END. Phase 5B1 made already-completed previews recoverable from extension-local IndexedDB, but deliberately did not persist partial exports. Without a retry, the source's request fails and the print view may be stranded.

## Decision

Keep the already-assembled HTML in the source content script and **retry the transfer once** with a fresh cryptographically random job ID when the background reports a missing job or a transient runtime message-port/service-worker failure.

- Preserve the PDF document's HTML bytes and source extraction results; never re-scan or re-render provider content during a transport retry.
- Before retrying, query CHATFOLIO_PRINT_STATUS to distinguish a lost response to a successfully committed PRINT_END from a genuinely incomplete transfer. If the job is complete, do not print twice.
- Use the existing per-chunk and total-memory limits from 5A. Abort and close the previous preview; after worker loss, close only a tab whose extension URL **exactly** matches the expected random job ID and print.html route.
- Stop on cancellation, non-transient errors (including size limits), or the second failure.
- Keep 5B1 IndexedDB snapshots **completed-only**. No new storage permission or partial-chat persistence is needed.

## Boundaries

This handles interruptions **while the content script, session and full document HTML remain alive**. It cannot recover a source tab that itself reloads/closes, a Chrome process crash, an aborted export or a disk quota failure. A lost response from the initial PRINT_BEGIN before its tab ID is reported may leave a temporary orphan preview; a separate cleanup improvement can address this. No promise is made that Chrome MV3 worker suspension is impossible.

## Acceptance gates

- Existing and new Node tests, browser regressions, generated bundle integrity and package build must pass in CI.
- The Ubuntu workstation should reproduce all suites plus a full real-chat PDF smoke test before merging this experimental PR.
- No release-tag changes and no user/private fixture files in the repository.
