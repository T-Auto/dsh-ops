/** Fixed Windows Bash driver. Only kernel-created endpoint identifiers enter launch argv. */
function endpoint(value: string): string {
  if (!/^\\\\\.\\pipe\\[A-Za-z0-9_.-]{1,200}$/.test(value)) throw new Error('PROTOCOL_ERROR: invalid private shell endpoint.')
  return `'${value}'`
}
export function residentShellBootstrap({ commandPipe, receiptPipe }: { commandPipe: string; receiptPipe: string }): string[] {
  const driver = `exec 3<>${endpoint(receiptPipe)} 4<>${endpoint(commandPipe)}
exec 0</dev/null 1>/dev/null 2>/dev/null
builtin printf 'COMMAND_READY\\n' >&4
builtin printf 'SHELL_READY:%s\\n' "$$" >&3
while IFS= read -r -u 4 _ops_id; do
 IFS= read -r -u 4 _ops_out || exit 125
 IFS= read -r -u 4 _ops_err || exit 125
 IFS= read -r -u 4 _ops_receipt || exit 125
 IFS= read -r -u 4 _ops_cwd_encoded || exit 125
 IFS= read -r -u 4 _ops_encoded || exit 125
 builtin printf -v _ops_cwd '%b' "$_ops_cwd_encoded"
 builtin printf -v _ops_code '%b' "$_ops_encoded"
 exec 0</dev/null 5<>"$_ops_out" 6<>"$_ops_err" 9<>"$_ops_receipt" || exit 125
 builtin printf 'OUT:%s\\n' "$_ops_id" >&5
 builtin printf 'ERR:%s\\n' "$_ops_id" >&6
 builtin printf 'BEGIN:%s\\n' "$_ops_id" >&9
 if builtin test -n "$_ops_cwd"; then builtin cd -- "$_ops_cwd" 2>&6 || exit 125; fi
 builtin eval "$_ops_code" 1>&5 2>&6
 _ops_rc=$?
 exec 5>&- 6>&-
 builtin printf 'END:%s:%s\\n' "$_ops_id" "$_ops_rc" >&9 || exit 125
 builtin jobs -pr >&9 || exit 125
 builtin jobs -ps >&9 || exit 125
 builtin printf 'DONE:%s\\n' "$_ops_id" >&9 || exit 125
 exec 9>&-
done
`
  return ['--noprofile', '--norc', '-c', driver]
}
