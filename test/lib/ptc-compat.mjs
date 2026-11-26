/** Alpha.2 test adapter for legacy function-body snippets and returned fixtures. */
import ts from 'typescript'

/** Wrap only scripts that use function-body top-level return syntax. */
export function adaptPtcCode(code) {
  const source = ts.createSourceFile('program.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let hasTopLevelReturn = false
  const visit = (node, inFunction) => {
    if (!inFunction && ts.isReturnStatement(node)) hasTopLevelReturn = true
    const nested = inFunction || ts.isFunctionLike(node)
    ts.forEachChild(node, child => visit(child, nested))
  }
  visit(source, false)
  if (!hasTopLevelReturn) return { code, capturesReturn: false }
  return {
    code: (code.match(/^\/\/ plan:[^\r\n]*/)?.[0] ?? '') + '\nconst __dshOpsTestResult = await (async () => {\n' + code + '\n})(); if (__dshOpsTestResult !== undefined) inspect(\"DSH_TEST_RETURN:\" + JSON.stringify(__dshOpsTestResult))',
    capturesReturn: true,
  }
}

/** Restore the explicit JSON value emitted by the adapter to test expectations. */
export function capturePtcReturn(result, capturesReturn) {
  if (!capturesReturn || result.isError || !Array.isArray(result.value?.logs)) return result
  for (const line of [...result.value.logs].reverse()) {
    const marker = 'DSH_TEST_RETURN:'
    if (!line.startsWith(marker)) continue
    try {
      const value = JSON.parse(line.slice(marker.length))
      return { ...result, value: { ...result.value, result: value } }
    } catch { /* A malformed adapter record is not a result. */ }
  }
  return result
}
