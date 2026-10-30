/**
 * The plugin pages' own chrome, drawn only with host theme tokens.
 *
 * No hex fallbacks on purpose: a token that disappears must fail loudly in review
 * instead of silently painting a colour that belongs to no theme. The page around
 * these elements is the Host's, so the 32px rhythm between detail sections and the
 * section title metrics come from it, not from here.
 */
export const SETTINGS_CSS = `
.ops-settings { display:flex; flex-direction:column; gap:12px; min-width:0; color:var(--dsw-alias-label-primary); font:inherit; }
.ops-settings p { margin:0; line-height:1.55; overflow-wrap:anywhere; }
.ops-group { display:flex; flex-direction:column; min-width:0; }
/* One bordered card per group, the same chrome the PowerShell status card uses. */
/* The outline borrows the sunken block's colour, so a card reads as one surface
   rather than a box drawn on top of the page. */
/* Matches the settings cards in the native account page: a visible hairline. */
.ops-card { border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); padding:14px; gap:10px; }
.ops-card .ops-group-head { align-items:flex-start; }
.ops-group-head > button[role=switch] { flex:none; margin-top:1px; }
/* The card head is a disclosure: title + description on the left, enable switch on
   the right; only the text side toggles the body, so the switch stays a switch. */
.ops-disclosure { flex:1 1 auto; min-width:0; display:flex; align-items:flex-start; gap:8px; margin:0; padding:0; border:0; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.ops-disclosure:hover .ops-group-title { color:var(--dsw-alias-label-primary); }
.ops-chevron { flex:none; width:12px; height:12px; margin-top:4px; color:var(--dsw-alias-label-tertiary); transition:transform .12s ease; }
.ops-disclosure:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; border-radius:var(--dsw-radius-sm); }
.ops-card .ops-group-title { margin:0; }
/* The sub-switches sit on their own surface, like the status card's fact block:
   the card is the object, the body is what you can change inside it. */
.ops-card-body { display:flex; flex-direction:column; min-width:0; padding:12px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-interactive-bg-hover); }
.ops-card-body > .ops-field { padding:10px 0; }
.ops-card-body > .ops-field:first-child { padding-top:0; }
.ops-card-body > .ops-field:last-child { padding-bottom:0; }
.ops-card-body .ops-field + .ops-field { border-top:.5px solid var(--dsw-alias-border-l2); }
.ops-group-head { display:flex; align-items:flex-start; gap:16px; min-width:0; }
.ops-group-head .ops-field-text { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }

.ops-group-head > button:not(.ops-disclosure) { flex:none; }
.ops-group-title { margin:0 0 4px; font-size:13px; font-weight:600; line-height:20px; color:var(--dsw-alias-label-secondary); }
.ops-field { display:flex; flex-direction:column; gap:6px; padding:12px 0; min-width:0; }
.ops-field + .ops-field { border-top:.5px solid var(--dsw-alias-border-l2); }
.ops-field-label { font-size:13px; font-weight:500; line-height:1.5; color:var(--dsw-alias-label-primary); }
.ops-field-hint { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); }
.ops-field-error { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.ops-field-text { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:4px; }
.ops-switch-row { display:flex; align-items:flex-start; gap:16px; min-width:0; }
.ops-input { box-sizing:border-box; width:100%; height:34px; padding:0 12px; border:.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:1.5; }
.ops-input:focus-visible { outline:none; border-color:var(--dsw-alias-state-business-primary); }
.ops-input:disabled { color:var(--dsw-alias-label-tertiary); cursor:default; }
.ops-input[aria-invalid=true] { border-color:var(--dsw-alias-state-error-primary); }
.ops-list { border:0; margin:0; padding:12px 0; display:flex; flex-direction:column; gap:6px; min-width:0; }
.ops-choice { display:flex; align-items:center; gap:10px; min-height:28px; cursor:pointer; font-size:13px; }
.ops-choice input { width:16px; height:16px; accent-color:var(--dsw-alias-button-primary-fill); }
.ops-choice code { overflow-wrap:anywhere; font-size:12px; color:var(--dsw-alias-label-secondary); }
.ops-inline { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.ops-text-button { appearance:none; border:0; background:none; padding:0; font:inherit; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); cursor:pointer; text-align:left; }
.ops-text-button:hover:not(:disabled) { color:var(--dsw-alias-label-primary); }
.ops-text-button:disabled { color:var(--dsw-alias-label-tertiary); cursor:default; }
.ops-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-top:4px; }
.ops-primary, .ops-settings-primary { appearance:none; border:1px solid transparent; border-radius:var(--dsw-radius-md); padding:5px 14px; font:inherit; font-size:13px; line-height:1.5; cursor:pointer; background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-layer-3); }
.ops-primary:disabled, .ops-settings-primary:disabled { opacity:.4; cursor:default; }
.ops-settings-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-top:4px; }
/* The reset is a text action, like the PowerShell plugin's: secondary colour, no chrome. */
.ops-small { box-sizing:border-box; height:28px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm); background:transparent; font:inherit; font-size:12px; line-height:18px; color:var(--dsw-alias-label-primary); cursor:pointer; }
.ops-small:disabled { opacity:.4; cursor:not-allowed; }
.ops-reset { border:none; background:none; padding:0; font:inherit; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.ops-reset:disabled { opacity:.4; cursor:default; }
.ops-status-lead { margin:0 0 12px; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1.6; }
.ops-status-note { margin:12px 0 0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.6; }
.ops-row-action { margin-left:10px; }
.ops-link { border:none; background:none; padding:0; font:inherit; color:var(--dsw-alias-label-secondary); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.ops-link:hover { color:var(--dsw-alias-label-primary); }
.ops-note { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.6; }
.ops-text-button:focus-visible, .ops-primary:focus-visible, .ops-settings-primary:focus-visible, .ops-small:focus-visible, .ops-reset:focus-visible, .ops-input:focus-visible, .ops-choice input:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:1px; }
.ops-detail { display:flex; flex-direction:column; gap:12px; min-width:0; }
.ops-detail-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }
.ops-detail-title { margin:0; flex:none; font-size:13px; font-weight:600; line-height:20px; color:var(--dsw-alias-label-primary); }
.ops-detail-metric { font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary); }
.ops-detail-action { margin-left:auto; flex:none; }
.ops-status-card { display:flex; flex-direction:column; gap:10px; padding:14px; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); min-width:0; }
/* The facts sit on their own surface, the way the PowerShell plugin's card nests its
   estimate block: the card is the object, the shaded body is what it reports. */
.ops-status-body { padding:12px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-interactive-bg-hover); min-width:0; }
.ops-facts { display:grid; gap:6px; margin:0; }
/* Native description list: max-content label column, baseline alignment, 14px gap. */
.ops-facts > div { display:grid; grid-template-columns:max-content minmax(0,1fr); align-items:baseline; column-gap:14px; }
.ops-facts dt { color:var(--dsw-alias-label-tertiary); font-size:13px; }
.ops-facts dd { margin:0; overflow-wrap:anywhere; font-size:13px; }
.ops-note { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-tertiary); }
.ops-preview { display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-interactive-bg-hover); font-size:13px; }
.ops-preview ul { margin:0; padding-left:20px; line-height:1.55; overflow-wrap:anywhere; }
.ops-result { display:flex; flex-direction:column; gap:4px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.ops-result p { margin:0; }
@media(max-width:440px) { .ops-facts > div { grid-template-columns:1fr; gap:2px; } }
`
