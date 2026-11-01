# Choosing the `read_files` reader: `fileReader`

`fileReader` decides which implementation answers `read_files`. It is an explicit switch, not a
silent upgrade, because the two readers differ in something a default must not decide for you.

| Value | Reader | Emits host `fs/observed` | Cost |
| --- | --- | --- | --- |
| `native` (default) | `dsh-ops-worker` (Rust, spawned per call) | **yes** | ~20–40 ms per call |
| `inproc` | `engine/parallel-read` (in-process) | **no** | 0.3–1.6 ms per call |

```yaml
dsh-ops:
  fileReader: inproc   # omit for native
```

## Why `native` is the default

The native read is what writes the host's read-before-edit table. With `inproc`, a model can edit a
file it only "read" through a path the host never recorded. That is a correctness change, so it is
opt-in.

## What `inproc` buys

Measured on this package's benchmark (`bench/read-path-comparison.mjs`, median of three):

| Request | `native` | `inproc` | Speed-up |
| --- | --- | --- | --- |
| 24 files × 30 lines (34 KiB) | 35.0 ms | 1.6 ms | 21× |
| 8 files × 800 lines (317 KiB) | 22.4 ms | 1.1 ms | 20× |
| 1 file × 20 000 lines (1 MiB) | 18.4 ms | 0.3 ms | 53× |

The token cost is the same: both apply the schema default of 200 lines per file, and both stop at
the worker output budget, so the same request returns the same bytes.

## Failure handling

`fileReader` is validated: an unknown value is a configuration error naming the accepted values,
never a silent fall back to `native`.

## Where to set it

Set `fileReader` in your **profile** configuration (or through the plugin's settings page). Do not add
it to the shipped `cordis.patch.yml`: the manifest validator rejects row keys the plugin does not
declare there, and the code default (`native`) is what that file is supposed to agree with.
