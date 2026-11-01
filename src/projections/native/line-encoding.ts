/** One physical source line, with reversible JSON escapes for backslashes and controls.
 * Quotes stay literal because the line is not enclosed in a JSON string. */
export function encodeSourceLine(value: string): string {
  return value.replace(/[\\\r\n\t\x00-\x1f\x7f\u0085\u2028\u2029]/g, char => {
    if (char === '\\') return '\\\\'
    if (/[\x7f\u0085\u2028\u2029]/.test(char)) return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    return JSON.stringify(char).slice(1, -1)
  })
}
