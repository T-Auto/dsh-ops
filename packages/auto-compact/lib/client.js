/** Browser artifact in the host's closure-factory module format; no globals except its loader. */
window.__ModuleLoader__.load({ id: '@dsh-ops/auto-compact', factory: require => {
  const { createElement: h, useState, useEffect, useRef } = require('react')
  const NS = 'dshOps.autoCompact'
  const dictionaries = {
    en: {
      title: 'Settings', threshold: 'Context threshold (%)', cooldown: 'Cooldown (seconds)', timeout: 'Compaction timeout (seconds)',
      save: 'Save', reset: 'Restore defaults', saved: 'Saved', failed: 'Not saved. Configuration may have changed; reload and retry.',
      unavailable: 'Enable this component to configure it. This client must have host settings write access.',
      hint: 'When the Web context meter is strictly above the threshold, compact at the next idle boundary using the same service as /compact. Running tools are not interrupted. Summarization may call your configured model and incur cost. No extra model-facing tool is added.',
      invalid: 'Enter integers: threshold 1–99, cooldown 30–3600, timeout 10–600.',
    },
    zh: {
      title: '设置', threshold: '上下文阈值（%）', cooldown: '冷却时间（秒）', timeout: '压缩超时（秒）',
      save: '保存', reset: '恢复默认', saved: '已保存', failed: '未保存，配置可能已变化，请重新加载后重试。',
      unavailable: '请先启用此组件；当前客户端还需具有宿主设置写入权限。',
      hint: 'Web 上下文占用严格高于阈值后，在下一次空闲边界调用与 /compact 相同的服务；不会打断正在运行的工具。摘要可能调用已配置模型并产生费用，不额外增加模型可调用工具。',
      invalid: '请输入整数：阈值 1–99，冷却 30–3600 秒，超时 10–600 秒。',
    },
  }
  const defaults = { thresholdPercent: 50, cooldownSeconds: 120, timeoutSeconds: 120 }
  const fields = [
    ['thresholdPercent', 'threshold', 1, 99],
    ['cooldownSeconds', 'cooldown', 30, 3600],
    ['timeoutSeconds', 'timeout', 10, 600],
  ]
  function Settings({ view, form, t }) {
    const [draft, setDraft] = useState(defaults)
    const [revision, setRevision] = useState(undefined)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const alive = useRef(false)
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    useEffect(() => {
      if (form?.state.status === 'ready') {
        setDraft({ ...defaults, ...form.state.value })
        setRevision(form.state.revision)
      }
    }, [form?.state.revision, form?.state.status])
    if (view === 'summary') return t('hint')
    const writable = form?.state.status === 'ready' && form.state.writable && form.state.mode === 'host'
    async function save(reset) {
      if (!writable || busy || revision === undefined) return
      if (!reset && fields.some(([key, , min, max]) => !Number.isInteger(Number(draft[key])) || String(draft[key]).trim() === '' || Number(draft[key]) < min || Number(draft[key]) > max)) {
        setMessage(t('invalid')); return
      }
      setBusy(true); setMessage('')
      try {
        const ops = fields.map(([key]) => reset
          ? { op: 'unset', path: [key] }
          : { op: 'set', path: [key], value: Number(draft[key]) })
        const ok = await form.mutate(ops, revision)
        if (alive.current) setMessage(t(ok ? 'saved' : 'failed'))
      } catch { if (alive.current) setMessage(t('failed')) }
      finally { if (alive.current) setBusy(false) }
    }
    return h('section', { 'data-dsh-ops-auto-compact-settings': true },
      h('h4', null, t('title')),
      h('p', null, t('hint')),
      !writable ? h('p', { role: 'status' }, t('unavailable')) : null,
      ...fields.map(([key, label, min, max]) => h('label', { key, style: { display: 'block', marginBottom: 12 } },
        t(label), ' ', h('input', {
          type: 'number', min, max, step: 1, value: draft[key], disabled: !writable || busy,
          onChange: event => setDraft(current => ({ ...current, [key]: event.target.value })),
        }))),
      h('button', { type: 'button', disabled: !writable || busy, onClick: () => save(false) }, t('save')), ' ',
      h('button', { type: 'button', disabled: !writable || busy, onClick: () => save(true) }, t('reset')),
      h('p', { role: 'status' }, message))
  }
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.get('locale').register(NS, dictionaries), 'dsh-ops settings locales')
      ctx.get('slots').inject('plugins.row.config', () => ctx.get('slots').register({
        name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-auto-compact', locale: NS,
      }, Settings))
    },
  }
} })
