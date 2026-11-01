/**
 * Text helpers: newline counting and surrogate-safe truncation.
 *
 * @module dsh-ops/file/reader/text
 */

import { TRUNCATED_MARK } from './core.cjs'

/** Count `\n` without allocating a split array. */
export function countNewlines(text: string): number {
  let count = 0
  let index = -1
  while ((index = text.indexOf('\n', index + 1)) !== -1) count += 1
  return count
}

/**
 * Cut to `max` UTF-16 units without splitting a surrogate pair — half an emoji becomes two replacement
 * characters, which is a silent corruption of the content the caller is about to edit.
 */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

/** Truncate and append the marker; the marker is not counted against `maxChars`. */
export function truncate(text: string, maxChars: number): { content: string, truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false }
  return { content: cutChars(text, maxChars) + TRUNCATED_MARK, truncated: true }
}
