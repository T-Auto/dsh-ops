# Optional WSL file reads

Apply the environment setting to the DSH daemon/desktop process, then restart that process. Changing it in an unrelated terminal does not affect an already running DSH process. Existing WSL cursors fail explicitly while the opt-in is disabled.

中文：[WSL 只读文件操作](WSL只读文件操作.md).

On Windows x64, set `DSH_OPS_WSL_READS=1` in the environment that starts DSH to opt in to Linux-side `ops_glob`, `ops_grep`, and `ops_read_files` for a session rooted at `\\wsl.localhost\<distribution>\...` or `\\wsl$\<distribution>\...`. This targets repeated metadata access through the WSL network filesystem. WSL startup and verification cost can make a small read slower; measure the actual workspace before enabling it broadly.

The installed package must contain the same-version, receipt-verified `runtime/linux-x64/dsh-ops-worker` as well as the normal Windows worker. The distribution must already be installed, support Linux x64, and provide `/usr/bin/wslpath` and `/usr/bin/sha256sum`. OPS neither installs WSL nor downloads a runtime. An explicit `workerPath` or `DSH_OPS_WORKER_BIN` selection keeps its existing Windows execution path. Turning the opt-in off restores the existing path for new calls.

The worker receives JSON data through `wsl.exe --distribution <name> --exec <verified-worker>`; no command shell or model-supplied code runs. Inputs must resolve to the same distribution as the session. Windows drive mappings are resolved anew for every call, including credential deny roots and the worker payload. The Linux-visible payload hash must match the packaged receipt. Windows case-insensitive credential matching and reserved-name restrictions remain enabled inside the Linux traversal. Links and special objects retain no-follow checks; an invalid filename is a scan gap, not a complete count.

Tools, argument schemas, prompt text, relative path bases, and host read observations stay the same. Only documented result path fields become UNC paths; file contents are untouched. Writes, Bash, PTC execution, and result-cache ownership remain on the existing Windows path.

Search pages use opaque `w1:` continuations bound to the distribution, worker digest, and Windows path policy. The original native cursor still validates the complete query, session, authority and filesystem snapshot. Old Windows cursors stay on Windows. A WSL cursor with a missing backend fails explicitly; a changed payload/distribution or stale snapshot requires a fresh query. WSL cursors are scoped to this Native route and cannot be transferred to PTC. Do not edit or strip the marker.

The Linux worker never receives result-storage authority. If a new request needs byte-clipped capture or stored continuation, its speculative read is discarded and the existing Windows worker handles the original request with its protected storage. Only that final result is observed. A pinned WSL cursor cannot switch storage backends: an oversized page fails with `OUTPUT_LIMIT`, requiring a fresh, narrower query. Normal line ranges and bounded search row pages remain valid inline output. Preparation, delegation and any Windows fallback share one worker timeout; cancellation and timeout never start another attempt.

Validation is split deliberately: ordinary CI covers path/cursor/coverage contracts and native restrictions; an actual Windows + WSL run is required to validate delegation, paging, observations and fallback before this feature is treated as ready. See the linked PR for the tested distribution, payload digest and exact commands; a passing Windows-only unit suite is not WSL evidence.
