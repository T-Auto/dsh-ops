# Release notes

One file per release tag: `v<version>.md`. The tag push's `publish` job uses
`docs/release-notes/$GITHUB_REF_NAME.md` as the release body when it exists; otherwise the
workflow falls back to GitHub's generated notes.

Convention (see v0.5.2–v0.5.5): a bilingual body opened by
`[中文](#cn-vX) | [English](#en-vX)`, a one-line patch summary, `问题修复` / `Bug Fixes`
followed by `其他变更` / `Chores` when needed, author handles, and a
`**Full Changelog**` compare link. Commit the file before tagging so the tagged commit
carries the exact text.
