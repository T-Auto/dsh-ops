/**
 * The shipped panel viewer template, read from `panel.html` beside this module.
 *
 * The template lives in `lib/` on purpose: `files` publishes `lib`, so the viewer
 * is available from the installed package with no build step and `npm run verify`
 * never renders it. It is read once and cached, and a read failure is the
 * caller's to report — never a reason to stop writing the JSON, which is the only
 * data source.
 *
 * @module dsh-ops/panel/render
 */

import { readFileSync } from 'node:fs'

/** The published viewer asset, resolved from this module rather than the cwd. */
export const PANEL_TEMPLATE_URL = new URL('./panel.html', import.meta.url)

/** @type {string|undefined} */
let cached

/**
 * The viewer HTML: a static page that reads a JSON document and inlines none.
 * @returns {string} the template text.
 * @throws when the shipped asset cannot be read (packaging defect).
 */
export function renderPanelHtml() {
  if (cached === undefined) cached = readFileSync(PANEL_TEMPLATE_URL, 'utf8')
  return cached
}
