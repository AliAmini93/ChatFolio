import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";

const src = readFileSync(new URL("../../src/content/main.js", import.meta.url), "utf8");
const from = src.indexOf("function chatGPTAttachmentIdentityKeys(value) {");
const to = src.indexOf("function chatGPTAttachmentUserSignature(", from);
assert.ok(from >= 0 && to > from, "Cannot find attachment identity implementation");
const extract = runInNewContext(
  "(" + src.slice(from, to).trim() + ")", {}, {timeout: 5000}
);
test("file-card keys preserve unique extensions and unicode case folding", () => {
  assert.deepEqual(Array.from(extract(
    "Long-report-name.PDF long-image-name.png another-report.xlsx " +
    "Long-report-name.PDF short.txt گزارش-آزمایش.pdf"
  )), [
    "another-report.xlsx","long-image-name.png","long-report-name.pdf",
    "گزارش-آزمایش.pdf"
  ]);
});
test("dot-heavy non-filenames are bounded and cannot stall matching", () => {
  const start = performance.now();
  const names = extract(".".repeat(100_000) + " no extension here");
  assert.equal(names.length, 0);
  assert.ok(performance.now() - start < 3000, "file-signature scan exceeded 3 seconds");
});
