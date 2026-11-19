/** Row draft and status lifetimes under host revision and language changes. */
import { JSDOM } from 'jsdom'
import { assert, test, report } from './lib/harness.mjs'
import { RowForm } from '../lib/client/row-form.js'
import { en, zh } from '../lib/client/locales.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) globalThis[name] = dom.window[name]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const translate = dictionary => (key, params) => String(dictionary[key]).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`))
const Switch = ({ checked, label, disabled, onChange }) => h('button', {
  type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': String(checked), disabled,
  onClick: () => onChange(!checked),
})
const ready = (value, revision = 'v1') => ({ status: 'ready', writable: true, value, base: {}, user: {}, revision })
const selectedPath = 'C:/draft/bash.exe'
const modes = ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']
const pathOps = file => modes.map(mode => ({ op: 'set', path: [mode, 'bashPath'], value: file }))
const pathRow = file => Object.fromEntries(modes.map(mode => [mode, { bashPath: file }]))
const switchOp = { op: 'set', path: ['global', 'hideOfficialTools'], value: false }
async function mount(form, select = async request => ({ ok: true, value: {
  clear: request.source === 'niubash', file: request.path, detail: 'Validated.', restriction: '',
} })) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const executor = { api: { select }, snapshot: { git: ['C:/candidate/bash.exe'] }, busy: false, refresh() {} }
  const render = (dictionary = en) => act(async () => root.render(h(RowForm, { form, t: translate(dictionary), Switch, executor })))
  await render()
  return { container, render, save: () => container.querySelector('button[type=submit]'),
    reset: () => container.querySelector('.ops-reset'), input: () => container.querySelector('input[type=text]'),
    radio: engine => container.querySelectorAll('input[type=radio]')[engine === 'niubash' ? 0 : 1],
    switch: () => container.querySelector(`[role=switch][aria-label="${en.hideOfficialTools}"]`),
    status: () => container.querySelector('.ops-note')?.textContent,
    async close() { await act(async () => root.unmount()); container.remove() } }
}
async function click(node) { assert.ok(node, 'DOM target exists'); await act(async () => node.click()) }
async function type(view, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(view.input(), value)
    view.input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

await test('executor-only drafts retain the original revision and write set through a conflict, then reset to the host', async () => {
  const calls = [], selections = []
  const form = { state: ready({}), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(form, async request => {
    selections.push(request)
    return { ok: true, value: { clear: false, file: request.path, detail: 'Validated.', restriction: '' } }
  })
  try {
    await click(view.radio('git')); await type(view, selectedPath)
    assert.equal(view.input().value, selectedPath)
    assert.equal(view.save().disabled, false)
    form.state = ready({ ptc: { bashPath: 'C:/other/bash.exe' }, presets: { later: { bashPath: 'C:/later/bash.exe' } } }, 'v2')
    await view.render()
    assert.equal(view.input().value, selectedPath, 'host refresh must not discard an executor-only draft')
    assert.equal(view.save().disabled, false)
    assert.deepEqual(calls, [], 'refresh does not write')
    await click(view.save())
    assert.deepEqual(selections, [{ source: 'git', path: selectedPath }])
    assert.deepEqual(calls, [[pathOps(selectedPath), 'v1']], 'new host paths are not silently adopted into the draft write set')
    assert.equal(view.status(), en.rejected)
    assert.equal(view.input().value, selectedPath)
    assert.equal(view.save().disabled, false)
    await click(view.reset())
    assert.equal(view.input(), null, 'reset adopts the mixed executor from the latest host row')
    assert.equal(view.status(), undefined)
    assert.equal(view.save().disabled, true)
    await click(view.switch()); await click(view.save())
    assert.deepEqual(calls[1], [[switchOp], 'v2'], 'reset adopts the latest revision without rewriting executor paths')
  } finally { await view.close() }
})

await test('combined drafts keep both fields and clear only executor paths from their original baseline', async () => {
  const calls = []
  const form = { state: ready({ ptc: { bashPath: 'C:/saved/bash.exe' } }), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(form)
  try {
    await click(view.switch()); await click(view.radio('niubash'))
    form.state = ready({ ptc: { bashPath: 'C:/other/bash.exe' }, standard: { bashPath: 'C:/new/bash.exe' } }, 'v2')
    await view.render()
    assert.equal(view.radio('niubash').checked, true)
    assert.equal(view.switch().getAttribute('aria-checked'), 'false')
    await click(view.save())
    assert.deepEqual(calls, [[[switchOp, { op: 'unset', path: ['ptc', 'bashPath'] }], 'v1']])
    assert.equal(view.status(), en.rejected)
  } finally { await view.close() }
})

await test('switch-only drafts never adopt or write an executor changed by another editor', async () => {
  const calls = [], selections = []
  const form = { state: ready({ ptc: { bashPath: 'C:/saved/bash.exe' } }), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(form, async request => { selections.push(request); throw new Error('Unexpected executor validation') })
  try {
    await click(view.switch())
    form.state = ready({ ptc: { bashPath: 'C:/other/bash.exe' } }, 'v2')
    await view.render(); await click(view.save())
    assert.equal(view.input().value, 'C:/saved/bash.exe')
    assert.deepEqual(calls, [[[switchOp], 'v1']])
    assert.deepEqual(selections, [])
  } finally { await view.close() }
})

await test('successful executor-only saves adopt the host-normalized path and next revision', async () => {
  const calls = [], canonicalPath = 'C:/canonical/bash.exe'
  const form = { state: ready({}), mutate: async (...args) => {
    calls.push(args); form.state = ready(pathRow(canonicalPath), 'v2'); return true
  } }
  const view = await mount(form, async () => ({ ok: true, value: { clear: false, file: canonicalPath, detail: 'Validated.', restriction: '' } }))
  try {
    await click(view.radio('git')); await type(view, selectedPath); await click(view.save())
    assert.deepEqual(calls, [[pathOps(canonicalPath), 'v1']])
    assert.equal(view.input().value, canonicalPath)
    assert.equal(view.save().disabled, true)
    assert.equal(view.status(), en.saved)
    await click(view.switch()); await click(view.save())
    assert.deepEqual(calls[1], [[switchOp], 'v2'])
  } finally { await view.close() }
})

await test('clean forms follow host revisions and candidate edits keep their revision after refresh', async () => {
  const calls = []
  const form = { state: ready({}), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(form)
  try {
    form.state = ready({ ptc: { bashPath: 'C:/host/bash.exe' } }, 'v2')
    await view.render()
    assert.equal(view.input().value, 'C:/host/bash.exe')
    assert.equal(view.save().disabled, true)
    await click(view.container.querySelector('.ops-candidate'))
    form.state = ready({}, 'v3'); await view.render()
    assert.equal(view.input().value, 'C:/candidate/bash.exe')
    await click(view.save())
    assert.deepEqual(calls, [[pathOps('C:/candidate/bash.exe'), 'v2']])
  } finally { await view.close() }
})

for (const accepted of [true, false]) await test(`${accepted ? 'saved' : 'refused'} status retranslates on the mounted form without another write`, async () => {
  let writes = 0
  const form = { state: ready({}), mutate: async () => { writes++; return accepted } }
  const view = await mount(form)
  try {
    await click(view.switch()); await click(view.save())
    const key = accepted ? 'saved' : 'rejected'
    assert.equal(view.status(), en[key])
    await view.render(zh)
    assert.equal(view.save().textContent, zh.save)
    assert.equal(view.status(), zh[key])
    await view.render(en)
    assert.equal(view.status(), en[key])
    assert.equal(writes, 1)
  } finally { await view.close() }
})

await test('in-flight save completion uses the current language while raw host errors stay literal', async () => {
  let finish, writes = 0
  const form = { state: ready({}), mutate: () => { writes++; return new Promise(resolve => { finish = resolve }) } }
  const view = await mount(form)
  try {
    await click(view.switch()); await click(view.save()); await view.render(zh)
    assert.equal(view.save().textContent, zh.saving)
    await act(async () => finish(false))
    assert.equal(view.status(), zh.rejected)
    form.mutate = async () => { writes++; throw new Error('saved') }
    await click(view.save())
    assert.equal(view.status(), 'saved', 'raw errors are not interpreted as translation keys')
    await view.render(en)
    assert.equal(view.status(), 'saved')
    assert.equal(writes, 2)
    await click(view.reset())
    assert.equal(view.status(), undefined)
  } finally { await view.close() }
})

dom.window.close()
report('settings-editor')
