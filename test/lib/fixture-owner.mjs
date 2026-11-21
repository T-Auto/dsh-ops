/** Read the owner SID from whoami /user /fo csv /nh. */
export function fixtureOwnerSid(probe) {
  if (probe?.status !== 0 || probe.error || probe.signal
    || typeof probe.stdout !== 'string' || typeof probe.stderr !== 'string' || probe.stderr.trim()) return undefined
  const record = /^"(?:[^"\x00-\x1f\x7f]|"")+","([^"\r\n]+)"(?:\r?\n)?$/.exec(probe.stdout)
  if (!record || record[0].length !== probe.stdout.length) return undefined
  const sid = record[1]
  const parts = /^S-1-([0-9]{1,15}|0x[0-9a-fA-F]{1,12})((?:-[0-9]{1,10}){1,15})$/.exec(sid)
  if (!parts) return undefined
  // SID identifier authorities are 48-bit; each of the at most 15 subauthorities is 32-bit.
  if (BigInt(parts[1]) > 0xffffffffffffn
    || parts[2].slice(1).split('-').some(value => BigInt(value) > 0xffffffffn)) return undefined
  return sid
}
