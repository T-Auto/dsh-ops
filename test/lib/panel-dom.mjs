import fs from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const html = fs.readFileSync(new URL('../../lib/panel/panel.html', import.meta.url), 'utf8')

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function flush() {
  await new Promise(resolve => setImmediate(resolve))
}

// Execute the shipped HTML, not a copied renderer. Network and file reads are controlled.
export function panelDom(search = '') {
  const requests = [], readers = [], errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error))
  const dom = new JSDOM(html, {
    url: 'http://panel.test/panel.html' + search, runScripts: 'dangerously', virtualConsole,
    beforeParse(window) {
      window.fetch = (name) => {
        const request = { name, ...deferred() }
        requests.push(request)
        return request.promise
      }
      window.FileReader = class {
        constructor() { readers.push(this) }
        readAsText(file) { this.file = file }
      }
    },
  })
  const { window } = dom
  const node = id => window.document.getElementById(id)
  return {
    window, node, requests, readers, errors,
    select(name) {
      const select = node('sessions')
      if (![...select.options].some(option => option.value === name)) {
        const option = window.document.createElement('option')
        option.value = name; select.appendChild(option)
      }
      select.value = name
      select.dispatchEvent(new window.Event('change'))
    },
    file(name, picker = false) {
      if (picker) {
        Object.defineProperty(node('file'), 'files', { configurable: true, value: [{ name }] })
        node('file').dispatchEvent(new window.Event('change'))
        return readers.at(-1)
      }
      const event = new window.Event('drop')
      event.dataTransfer = { files: [{ name }] }
      node('picker').dispatchEvent(event)
      return readers.at(-1)
    },
    close() { dom.window.close() },
  }
}

export const documentFor = sessionId => ({
  meta: { sessionId }, conversation: [], trace: [], metrics: {}, limits: {}, verify: {},
})
export const response = value => ({ ok: true, text: async () => JSON.stringify(value), json: async () => value })
