/**
 * WinuxCmd argv0 command faces materialized for the pinned Niubash v1.5.0 payload (WinuxCmd 1.2.1).
 * Includes the 171 commands advertised by `winuxcmd wpm links list` plus the 6 external utility
 * faces (`env`, `false`, `kill`, `test`, `[`, `true`) needed by non-shell callers (`find -exec`,
 * `xargs`, etc.), while omitting removed/conflicting faces (`jq`, now a `wpm` package; `link`,
 * which shadows MSVC `link.exe`). `bash`/`sh` keep their original Niubash shims.
 */
export const NIUBASH_FACES: readonly string[] = Object.freeze([
  'arch', 'b2sum', 'base32', 'base64', 'basename', 'basenc', 'cal', 'cat', 'chattr', 'chcon',
  'chgrp', 'chmod', 'chown', 'chroot', 'cksum', 'clear', 'cmp', 'col', 'column', 'comm',
  'cp', 'cpio', 'csplit', 'cut', 'cygpath', 'd2u', 'date', 'dd', 'df', 'diff',
  'diff3', 'dir', 'dircolors', 'dirname', 'dos2unix', 'du', 'echo', 'egrep', 'env', 'envsubst',
  'expand', 'expr', 'factor', 'false', 'fgrep', 'file', 'find', 'fmt', 'fold', 'free',
  'getconf', 'getfacl', 'getopt', 'grep', 'groups', 'head', 'hexdump', 'hmac256', 'hostid', 'hostname',
  'id', 'infocmp', 'install', 'join', 'kill', 'killall', 'ldd', 'less', 'ln', 'locale',
  'locate', 'logger', 'logname', 'look', 'ls', 'lsattr', 'lsof', 'man', 'md5sum', 'mkdir',
  'mkfifo', 'mkgroup', 'mknod', 'mkpasswd', 'mktemp', 'more', 'mpicalc', 'mv', 'namei', 'nice',
  'nl', 'nohup', 'nproc', 'numfmt', 'od', 'paste', 'patch', 'pathchk', 'pgrep', 'pidof',
  'pinky', 'pkill', 'pldd', 'pr', 'printenv', 'printf', 'ps', 'ptx', 'pwd', 'readlink',
  'realpath', 'regtool', 'renice', 'reset', 'rev', 'rm', 'rmdir', 'runcon', 'sdiff', 'sed',
  'seq', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'shred', 'shuf', 'sleep', 'sort',
  'split', 'stat', 'stdbuf', 'strings', 'stty', 'sum', 'sync', 'tac', 'tail', 'tee',
  'test', '[', 'tic', 'timeout', 'toe', 'top', 'touch', 'tput', 'tr', 'tree',
  'true', 'truncate', 'tsort', 'tty', 'tzset', 'u2d', 'uname', 'unexpand', 'uniq', 'unix2dos',
  'unlink', 'updatedb', 'uptime', 'users', 'vdir', 'vmstat', 'w', 'watch', 'wc', 'whereis',
  'which', 'who', 'whoami', 'wpm', 'xargs', 'xxd', 'yes',
])
/** The multi-call binary every face dispatches to. */
export const NIUBASH_WINUXCMD = 'winuxcmd/usr/bin/winuxcmd.exe'
/** Payload-relative path of one argv0 face. */
export const niubashFacePath = (face: string): string => `winuxcmd/usr/bin/${face}.exe`
