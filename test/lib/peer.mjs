/**
 * The Peer rc.5 requires every `typertGateway.invoke` to name.
 *
 * A suite's call stands in for the Host itself, so the principal is the owner
 * and no live client stream exists. Kept in one place: the shape has five
 * fields and a copied literal drifts the moment the Host adds a sixth.
 * @param {object} ctx - the calling context the Peer speaks through.
 * @param {AbortSignal} signal - cancellation for the invocation.
 * @returns {object} the PeerScope literal.
 */
export const ownerPeer = (ctx, signal) => ({
  id: 'suite-peer',
  ctx,
  principal: { kind: 'owner' },
  signal,
  interactions: 'none',
  dispose: async () => {},
})
