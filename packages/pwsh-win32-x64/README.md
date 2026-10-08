# PowerShell 7 for Windows x64 — a pin, not a payload

This package is what the [dsh-ops](https://github.com/T-Auto/dsh-ops) plugin
publishes for the PowerShell rung of its command-execution ladder: the
executable the plugin's bundle patch points the host's `pwsh-sandbox` row at, so
the plugin's own shell runs under the host's sandbox, credential scrub, and
output governance. It contains **no upstream bytes**: it names the exact
PowerShell release asset to fetch, records its digest, and states where the
shell lands once it is unpacked.

| Fact | Value |
| --- | --- |
| This package carries | `package.json`, `provenance.json`, this `README.md` |
| Upstream | https://github.com/PowerShell/PowerShell |
| Release | `v7.6.6` (version `7.6.6`) |
| Asset | `PowerShell-7.6.6-win-x64.zip` |
| Asset URL | https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip |
| Asset sha256 | `02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860` |
| Asset size | 106,328,873 bytes |
| Unpacks to | `bin/`: the archive root (`pwsh.exe`, its DLLs, `Modules/`, `LICENSE.txt`) goes under `bin/` |
| Unpacked size (measured) | 658 files, 256,625,143 bytes (244.7 MiB) — measured from a real extraction; no two paths in this archive share an inode, so summing every file's size gives the same number |
| Executable | `bin/pwsh.exe` (sha256 `bfb46af89433268872ddb43d1ca7a3f433452ee91ed356a9786940f90118e285`) |
| Licence | MIT — Copyright (c) Microsoft Corporation |
| The package's own licence | MIT |

`provenance.json` is the machine-readable form of this table, and is what an
installer should read rather than parsing this file.

## Installing the shell

1. download the asset URL above;
2. check it against the sha256 above (and the byte count);
3. unpack the archive's **root contents into `bin/`** of the installed package
   directory, so the shell lands at `<installed package directory>/bin/pwsh.exe`
   — the place `lib/shells.js` probes and the same place `cordis.patch.yml`
   probes, which is what keeps the plugin's ladder and the host's `pwsh-sandbox`
   row one fact instead of two;
4. `bin/LICENSE.txt` comes with the archive and stays where upstream put it.

## Why the bytes are not in this package

The plugin needs a specific, digestible PowerShell release, not a copy of one:
pointing at upstream's own release keeps this package at a few kilobytes, keeps
`npm install dsh-ops` from pulling a 100 MB download for a rung most deployments
never reach, and leaves PowerShell's own licensing and attribution with the
project that publishes it. The pins are published as metadata: not as a
dependency of the main package, but for a deployment that deliberately wants
this shell.
