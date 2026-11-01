# Configured download alternatives

The optional `download-guard` section of the single `dsh-ops` row refuses recognized
shell downloads to disk and returns the downloader configured by the operator.
It is disabled by default. Enabling it with an empty template also registers no
listener. There is no bundled downloader, automatic rewrite, background download,
network probe, or claim that a replacement is faster on every connection.

```yaml
config:
  download-guard:
    enabled: true
    downloadGuard:
      template: 'my-downloader --output {file} -- {url}'
      shell: bash
```

Replace `my-downloader` with an installed executable or script. `shell` is `bash`
(default) or `pwsh` and controls quoting of the suggested alternative. The template
must be valid in that shell. `{url}` is required; `{file}` is optional. Placeholders
must be standalone, unquoted arguments: the guard quotes their literal values.
No URL or output name is guessed. If the selected template needs `{file}` but the
original call uses a remote-derived name, the call is allowed unchanged.

Detection covers literal, single-URL `curl -o`/`-O`, `wget -O` or bare `wget`,
spaced `> file` redirection, and PowerShell `Invoke-WebRequest`, `Invoke-RestMethod`
or `Start-BitsTransfer` with explicit output parameters. It inspects the shell
tools' `command` arguments, including calls dispatched from PTC. A refusal happens
before the shell tool runs and carries `DOWNLOAD_TO_FILE`. Disabling or unloading
the component removes the guard; it never changes tool schemas or prompt bytes.

This is a workflow preference, not a shell parser or security boundary. It does
not infer download size, inspect `script_path` contents, expand variables, parse
here-documents/substitutions, or translate arbitrary shell programs. Ambiguous
commands, multiple URLs, stdout/discard destinations and unrecognized spellings
are allowed. A detector error also allows the original call. Operators should
not rely on it to prevent network access.

Before using a suggested alternative, preserve authentication, headers, resume
options, workdir, checksums and other required request semantics. Keep the current
sandbox and approval requirements. The guard does not authorize a different tool
or permission mode, verify the configured executable, or run its suggestion.

The `shell` selector affects only alternative syntax; it does not change which
shell executes the original call. An unavailable alternative can be changed or
the optional guard can be disabled by the operator.
