# Bash for Windows x64 — a pin, not a payload

This package is what the [dsh-ops](https://github.com/T-Auto/dsh-ops) plugin
publishes for the bash rung of its command-execution ladder
(`ops_bash`). It contains **no upstream bytes**: it names the exact Git for
Windows release asset to fetch, records its digest, and states where the shell
lands once it is unpacked. Downloading the asset is a deliberate act on the
machine that wants the shell.

| Fact | Value |
| --- | --- |
| This package carries | `package.json`, `provenance.json`, this `README.md` |
| Upstream | https://github.com/git-for-windows/git |
| Release | `v2.56.0.windows.2` (version `2.56.0.2`) |
| Asset | `PortableGit-2.56.0.2-64-bit.7z.exe` |
| Asset URL | https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe |
| Asset sha256 | `075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b` |
| Asset size | 60,027,568 bytes |
| Unpacks to | the archive root: `bin/`, `cmd/`, `dev/`, `etc/`, `tmp/`, `ucrt64/`, `usr/`, `git-bash.exe`, `git-cmd.exe`, `LICENSE.txt`, `README.portable` |
| Unpacked size (measured) | 9,611 files, 351,211,022 bytes (334.9 MiB) counting each inode once — this is what the tree occupies. Summing every file's size instead gives 411,137,776 bytes (392.1 MiB), because 84 paths in upstream's tree are hardlinks to another path in it. Both figures are measured from a real extraction; nothing here was linked, copied, or removed by this pipeline |
| Executable | `bin/bash.exe` (sha256 `6cc575e9112efe6253b6a6999c12aa0240cb3f511aeda3480ae026edc0dc5280`) |
| Upstream licence | GPL-2.0-only |
| Copyright | Copyright (C) Linus Torvalds and others (the Git project), packaged for Windows by the Git for Windows project |
| The package's own licence | MIT (this metadata; the GPL-2.0-covered binaries are upstream's, not ours) |

`provenance.json` is the machine-readable form of this table, and is what an
installer should read rather than parsing this file.

## Installing the shell

1. download the asset URL above;
2. check it against the sha256 above (and the byte count);
3. unpack it — it is a self-extracting 7-Zip archive, so running it with
   `-o<directory> -y` does this with no 7-Zip installation;
4. put the unpacked tree where the plugin resolves it, which is
   `<installed package directory>/bin/bash.exe` — the same place
   `lib/shells.js` probes and the same place `cordis.patch.yml` probes for the
   PowerShell rung.

## Why `bin/bash.exe`, and why PortableGit

`bin/bash.exe` is Git for Windows' own launcher for its bash: it starts
`usr/bin/bash.exe` with the environment that makes the tree work, and it
prepends the tree's own `usr/bin` and `ucrt64/bin` to `PATH` before the shell
runs. So a command executed through it resolves `git`, `sed`, `cygpath`, and the
rest of the POSIX tools that ship beside it, even on a machine with no Git
installed and no Git on the ambient `PATH`.

The smaller MinGit artifact cannot do this: version 2.56 ships no `bin/`
directory and no `bash.exe` at all (its shell is `usr/bin/sh.exe`) and leaves
`PATH` untouched. PortableGit is the smallest upstream artifact that presents a
real `bin/bash.exe` with a working environment around it.

## PATH, and what it never touches

The launcher prepends the tree's directories to `PATH` **inside the child
process it starts** — not globally: it writes no registry value, no system
environment variable, and no file. The plugin does not write the ambient
environment either: `ops_bash` hands the harness subprocess service an explicit
environment holding four terminal overrides, and never writes `process.env`,
`PATH`, or the working directory (`lib/shells.js`, `ENV_OVERRIDES`).

## Why the bytes are not in this package

Redistributing a 60 MB GPL-2.0 binary distribution through npm would mean
publishing a copy of someone else's binaries, with the corresponding-source
obligations and the bandwidth that implies, inside a package whose whole job is
to be installed by a plugin. Pointing at upstream's own release keeps the
licence story where it belongs — upstream publishes the binaries and their
source — and keeps `npm install dsh-ops` from pulling a git distribution nobody
asked for. The pins are published as metadata: not as a dependency of the main
package, but for a deployment that deliberately wants this shell.
