#!/bin/sh
# Drive the syscall probe: one operation per process, so a SIGSYS kill cannot
# hide the operations that follow it. Prints one line per operation and a
# summary of the syscalls the kernel terminated.
#
# Targets: the host by default. For an OpenHarmony device, export the target and
# the SDK linker first (see docs/verification.md):
#   DSH_OPS_PROBE_TARGET=aarch64-unknown-linux-ohos \
#   CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER=aarch64-linux-ohos-gcc \
#   RUSTFLAGS="-L native=<sdk>/llvm/lib/aarch64-linux-ohos" sh tools/syscall-probe/run.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
target=${DSH_OPS_PROBE_TARGET:-}
if [ -n "$target" ]; then
  ( cd "$here" && cargo build --release --target "$target" ) || exit 1
  bin="$here/target/$target/release/dsh-ops-syscall-probe"
else
  ( cd "$here" && cargo build --release ) || exit 1
  bin="$here/target/release/dsh-ops-syscall-probe"
fi
[ -x "$bin" ] || { echo "probe binary missing: $bin" >&2; exit 1; }

OPS="ambient_open_abs_dir entries_on_ambient_dir dir_metadata_fstat std_lstat_abs std_open_abs_file std_read_dir_abs \
cap_open_dir_relative cap_open_dir_nofollow_relative cap_open_with_relative cap_symlink_metadata_relative cap_read_dir_relative cap_canonicalize_relative \
raw_openat_abs raw_openat_dirfd raw_fstatat_dirfd raw_statx_abs raw_getdents64 raw_renameat2 raw_faccessat2 raw_getrandom \
raw_openat2_abs raw_openat2_dirfd raw_fchmodat2 raw_rseq raw_clone3 \
root_openable_root root_openable_storage root_openable_lib root_openable_home root_stat_root"

echo "host: $(node -e 'console.log(process.platform, process.arch)' 2>/dev/null || echo unknown)"
echo
sigsys=""
for op in $OPS; do
  line=$("$bin" "$op" 2>&1 | tail -1)
  printf '  %-34s %s\n' "$op" "$line"
  case "$line" in *SIGSYS*) sigsys="$sigsys $(printf '%s' "$line" | sed -n 's/.*syscall=\([0-9]*\).*/\1/p')";; esac
done
echo
if [ -n "$sigsys" ]; then
  echo "terminated by SIGSYS (seccomp denies these outright):$sigsys"
else
  echo "no SIGSYS terminations: this kernel allows every probed call"
fi
