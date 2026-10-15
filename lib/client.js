// Published directly in the host's browser-module format; no separate build step.
window.__ModuleLoader__.load({
  id: 'dsh-ops',
  factory(require) {
    const { createElement: h, useState } = require('react')
    const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const en = {
      title: 'Hide overlapping built-in tools',
      description: 'Hide read/write/edit/glob/grep/bash/pwsh/pwsh_persistent. Keep read_image, third-party tools and run_code. Saves immediately; does not change sandbox permissions. Turn off if the available ops_* tools cannot cover a task.',
      failed: 'Could not save this setting. The accepted value is still shown.',
    }
    const zh = {
      title: '隐藏官方基础工具',
      description: '隐藏 read/write/edit/glob/grep/bash/pwsh/pwsh_persistent；保留 read_image、第三方工具与 run_code。切换即保存，不改变沙箱权限。若可用的 ops_* 无法完成任务，请关闭此开关。',
      failed: '保存失败，仍显示宿主已接受的设置。',
    }
    function Panel({ view, useBuiltinTools, setHidden, t }) {
      const form = useBuiltinTools(state => state)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(false)
      if (view === 'summary') return t('description')
      return h('div', null,
        h(Switch, {
          label: t('title'), checked: form.value?.hideBuiltinTools === true,
          disabled: busy || form.status !== 'ready' || !form.writable,
          async onChange(value) {
            setBusy(true); setError(false)
            try { setError(!await setHidden(value)) }
            catch { setError(true) }
            finally { setBusy(false) }
          },
        }),
        h('p', null, t('description')),
        error ? h('p', { role: 'alert' }, t('failed')) : null)
    }
    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dsh-ops', { en, zh }))
        const form = ctx.configForms.get('dsh-ops-file')
        ctx.effect(() => ctx.configForms.whileServed(['dsh-ops-file'], () =>
          ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-file', locale: 'dsh-ops',
            inject: () => ({ hooks: { builtinTools: form }, setHidden: value => form.set('hideBuiltinTools', value) }),
          }, Panel))))
      },
    }
  },
})
