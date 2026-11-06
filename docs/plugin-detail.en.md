
# dsh-ops

A plugin that improves token efficiency by adding `ops_*` tools and hiding some official tools, with a small change surface and low intrusion, so it stays broadly compatible with other plugins.

- (Windows only) Enable `ops_bash` with DSH-native bash semantics; preset rows use it in place of the official pwsh, while compatibility mode keeps the official tools
- Add useful ops tools to the built-in presets (Standard, PTC, Cordis). This can be turned off. Minimal only gains the dynamic tool loading described below.
- Enable DSH's reserved `tools_addition` dynamic tool loading and offer progressively disclosed tools as the loading platform for advanced capabilities (PDF/Word reading, very large multi-file edits), greatly reducing token use in common specific scenarios without inflating the system prompt.

Scroll down, click the group that contains dsh-ops, choose dsh-ops, then open its settings page.

## Contributors

[![Contributors](https://contrib.rocks/image?repo=T-Auto/dsh-ops)](https://github.com/T-Auto/dsh-ops)

## Star history

[![Star history](https://api.star-history.com/svg?repos=T-Auto/dsh-ops&type=Date)](https://star-history.com/#T-Auto/dsh-ops&Date)
