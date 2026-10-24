# Roadmap

中文：[路线图](路线图.md)。

> Directional, not a schedule or a commitment. Priorities can change with
> upstream DSH releases and community feedback. Shipped work is recorded in
> [CHANGELOG.md](CHANGELOG.md).

## Shipped

- **0.3.0** — native Rust file tools and confined PTC batching (Windows x64).
- **0.3.1** — cross-platform: Windows x64, Linux x64 and macOS Apple Silicon
  (`darwin-arm64`). See [linux-build.md](linux-build.md) and
  [macos.md](macos.md).

## 0.4.0 candidate

Separate Native/PTC projections, scoped discovery, bounded CSV/TSV, DOCX and restricted PDF readers, runtime/settings changes and strict TypeScript source are implemented. This is not a release announcement: final evidence must satisfy the approved OPS 0.3.x BM-01 threshold and file/discovery BM-03 budget, while separately reporting the official comparison and full Bash-inclusive startup total. See [candidate status and format limits](release-0.4.0.md).

- macOS Intel (`darwin-x64`) on macOS 13+ is implemented and in review; macOS 12's
  `CLONE_ACL` fallback remains a separate follow-up. See [macOS](macos.md).

## Later

### Platform coverage

- Windows ARM64 and Linux ARM64 targets.
- macOS 12 (`CLONE_ACL` fallback for Intel and arm64) after the macOS 13+ support lands.

### Tool surface (progressive disclosure)

- Broader document-format coverage beyond the bounded 0.4.0 DOCX/PDF subsets.
- Web search and crawl4ai-style HTML-to-Markdown tools.
- More PTC tools and bounded result projections.

### Documentation

- Keep the English/Chinese doc pairs in sync; expand the troubleshooting and
  Windows verification notes.

### Ecosystem

- Track upstream DSH releases (currently `0.2.0-rc.2`) and adapt the plugin
  APIs promptly.

## How to influence it

Open an issue describing the use case. See
[贡献指南.md](贡献指南.md) for the contribution workflow.
