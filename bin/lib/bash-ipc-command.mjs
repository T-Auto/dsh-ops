/** Keep batch bytes ASCII; CreateProcess carries filesystem paths as Unicode environment values. */
export function bashIpcBuildBatch({ vcvars, scratch, sourceDirectory, names }) {
  const commands = ['@echo off', 'setlocal DisableDelayedExpansion', 'call "%DSH_OPS_IPC_VCVARS%" >nul',
    'if errorlevel 1 exit /b 1', 'cd /d "%DSH_OPS_IPC_SCRATCH%"', 'if errorlevel 1 exit /b 1']
  for (const name of names) {
    if (name !== 'opsipc' && name !== 'opsnt') throw new Error(`Unknown IPC proxy: ${name}`)
    commands.push(`cl /nologo /LD /O2 /MT /std:c++20 /EHsc "%DSH_OPS_IPC_SOURCES%\\${name}.cpp" /link /Brepro /DEF:${name}.def /OUT:${name}.dll advapi32.lib normaliz.lib ntdll.lib`, 'if errorlevel 1 exit /b 1')
  }
  return { text: commands.join('\r\n') + '\r\n', env: {
    DSH_OPS_IPC_VCVARS: vcvars, DSH_OPS_IPC_SCRATCH: scratch, DSH_OPS_IPC_SOURCES: sourceDirectory,
  } }
}
