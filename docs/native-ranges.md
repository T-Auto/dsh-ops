# Compact Native file ranges

中文：[紧凑文件范围](紧凑文件范围.md).

A fully returned `ops_read_files` range uses one path header, exact numbered text and one revision/continuation notice per file. When all files have exactly the same absolute parent, a JSON-quoted `Base` appears once and each JSON-quoted filename is relative to it. Different parents retain absolute paths.

```text
[Base: "/workspace/src"]
=== FILE: "server.ts" (Lines 1-2 of 80) ===
1|import { createServer } from 'http';
2|const port = 8080;
[revision=cfd1bc81432fd6b88748b827f46bb4242db17cf8655cf4ea90f3ba0e62065355; more lines; nextOffset=3]
```

The characters after `N|` are the source line, including leading spaces. Line bodies use reversible JSON escapes: backslashes are doubled, controls and Unicode line separators are escaped, and quotes remain literal. For example, an actual tab appears as `\t`, while the two source characters backslash-plus-t appear as `\\t`. This shared encoding applies to compact ranges and ordinary numbered source output, and prevents source text from forging extra rows or headers. LF/CRLF accounting remains the worker's physical-line accounting. `ops_edit_file` first matches literal bytes; only after a raw miss may it decode this rendered form for `oldText` and `newText`, with `renderedMatches` in the receipt. It never decodes a raw match or `write_file` content.

“More lines” means the file has not been exhausted; use the stated `nextOffset`. “End of file; complete=true” means this range reached the end. The aggregate “requested ranges returned” receipt means every requested range body was returned, not that every whole file was read. Full revisions, total line counts and per-file continuation remain visible. Byte sizes and duplicate counters remain available in canonical/PTC data. Per-file revision receipts omit the repeated `Notice: ` prefix and terminal period; the aggregate `Notice` and every revision/continuation/completeness fact remain intact.

Physical clipping, missing files, unexpected coverage, stored references and other uncertain results retain the diagnostic renderer and explicit recovery notices. Final display clipping removes the successful aggregate claim and asks for the original range with a smaller limit. Deduplication recognizes both `N|` and the existing single-file `N | ` format; only an exact prior body in current provider context permits an unchanged-reference receipt.
