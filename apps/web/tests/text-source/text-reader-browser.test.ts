import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeTextSpanSelection } from "@/lib/workspace/text-span-selection";
import { buildTextSegments, findLiteralMatches, resolveTextOffsetFromNode, resolveContainerSelectionOffsets } from "@/lib/workspace/text-dom-segments";

test("Chrome selections preserve Unicode offsets across segments, element boundaries, and wrapping", () => {
  const directory = mkdtempSync(join(tmpdir(), "text-reader-browser-"));
  try {
    const functions = { normalizeTextSpanSelection, buildTextSegments, findLiteralMatches, resolveTextOffsetFromNode, resolveContainerSelectionOffsets };
    const definitions = Object.entries(functions).map(([name, fn]) => `const ${name} = ${fn.toString()};`).join("\n");
    const script = `${definitions}
      const fixtures = ["OpenAI builds AI.", "A😀B", "e\\u0301", "é", "👩‍💻", "中文", "\\uFEFFA\\r\\nB\\rC\\n", "", "   "];
      function check(condition, message) { if (!condition) throw new Error(message); }
      try {
        for (const source of fixtures) {
          const container = document.createElement('pre');
          container.style.whiteSpace = 'pre-wrap';
          document.body.append(container);
          const matches = findLiteralMatches(source, source.slice(0, 1));
          const segments = buildTextSegments(source, matches.map((m, i) => ({...m, key: String(i), kind: 'search-match'})));
          for (const segment of segments) {
            const span = document.createElement('span');
            span.dataset.textStart = String(segment.startOffset);
            span.append(document.createTextNode(segment.text));
            container.append(span);
          }
          check(container.textContent === source, 'source changed');
          for (const width of ['20px', '800px']) {
            container.style.width = width;
            check(resolveTextOffsetFromNode(container, container, container.childNodes.length) === source.length, 'container end');
            let offset = 0;
            for (const span of container.children) {
              check(resolveTextOffsetFromNode(container, span, 0) === offset, 'element start');
              for (let i = 0; i <= span.textContent.length; i++) {
                check(resolveTextOffsetFromNode(container, span.firstChild, i) === offset + i, 'text offset');
              }
              offset += span.textContent.length;
              check(resolveTextOffsetFromNode(container, span, 1) === offset, 'element end');
            }
            if (source.length) {
              const selected = window.getSelection();
              selected.setBaseAndExtent(container.lastChild.firstChild, container.lastChild.textContent.length, container.firstChild.firstChild, 0);
              const range = resolveContainerSelectionOffsets(container);
              check(range && range.startOffset === 0 && range.endOffset === source.length, 'reversed selection');
              selected.removeAllRanges();
            }
          }
          container.remove();
        }
        const unicode = document.createElement('pre');
        unicode.textContent = 'A😀B';
        document.body.append(unicode);
        const selection = window.getSelection();
        selection.setBaseAndExtent(unicode.firstChild, 2, unicode.firstChild, 3);
        const normalized = normalizeTextSpanSelection(resolveContainerSelectionOffsets(unicode), [0, 1, 3, 4]);
        check(normalized.startOffset === 1 && normalized.endOffset === 3, 'verified Unicode boundary normalization');
        check(unicode.textContent.slice(normalized.startOffset, normalized.endOffset) === '😀', 'whole entity text');
        selection.removeAllRanges();
        unicode.remove();
        document.body.textContent = 'TEXT_READER_BROWSER_PASS';
      } catch (error) { document.body.textContent = 'FAIL: ' + error.message; }
    `;
    const path = join(directory, "reader.html");
    writeFileSync(path, `<!doctype html><body><script>${script}</script></body>`);
    const output = execFileSync(process.env.CHROME_BIN ?? "/usr/bin/google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${join(directory, "profile")}`, "--dump-dom", `file://${path}`], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(output, /<body>TEXT_READER_BROWSER_PASS<\/body>/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
