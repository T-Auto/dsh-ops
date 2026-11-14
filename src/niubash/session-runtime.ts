/** Qualified complete inventories; accepting a digest does not select a distribution. */
const QUALIFIED_SESSION_RUNTIME_MANIFESTS: ReadonlySet<string> = new Set([
  '24bd2f20fea7e6358aa9f75f1fa4d1896ee3b4962d42042bfd2f5e4ca8317068',
])

/** The qualified candidate requires separate pin adoption; stock remains ineligible. */
export function isQualifiedSessionRuntime(manifestSha256: string): boolean {
  return QUALIFIED_SESSION_RUNTIME_MANIFESTS.has(manifestSha256)
}
