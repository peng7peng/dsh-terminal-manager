/**
 * F10/F11 TC 执行样式：汇总条、右键菜单、确认框内的行。
 * @module dsh-terminal-manager/client/styles/tc
 */

export const TC_CSS = `
/* 汇总条（编辑器底部，常驻可关） */
.tm-tcSum { flex:none; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-module-platform, #f5f6f7); max-height:132px; display:flex; flex-direction:column; font:11.3px/1.7 var(--dsw-font-code, monospace); }
.tm-tcSumHead { flex:none; display:flex; align-items:center; gap:8px; padding:3px 10px; font-weight:700; font-family:var(--dsw-font-family, system-ui); font-size:12px; }
.tm-tcSumHead .sp { flex:1; }
.tm-tcSumHead .ok { color:var(--dsw-alias-state-success-primary, #22c55e); }
.tm-tcSumHead .bad { color:var(--dsw-alias-state-error-primary, #ef4444); }
.tm-tcSumHead .warn { color:var(--dsw-alias-state-warn-primary, #d29922); }
.tm-tcSumHead button { display:inline-flex; background:none; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:5px; padding:1px 6px; cursor:pointer; color:var(--dsw-alias-label-secondary, #666); font-size:11px; }
.tm-tcSumBody { flex:1; overflow:auto; padding:0 10px 4px; }
.tm-tcRow { display:flex; gap:8px; white-space:nowrap; }
.tm-tcRow .st { flex:none; width:16px; text-align:center; }
.tm-tcRow.ok .st { color:var(--dsw-alias-state-success-primary, #22c55e); }
.tm-tcRow.timeout .st, .tm-tcRow.error .st, .tm-tcRow.no-target .st { color:var(--dsw-alias-state-error-primary, #ef4444); }
.tm-tcRow.running .st { color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-tcRow.aborted, .tm-tcRow.pending { opacity:.55; }
.tm-tcRow .cmd { overflow:hidden; text-overflow:ellipsis; min-width:0; }
.tm-tcRow .why { color:var(--dsw-alias-label-tertiary, #888); }

/* 右键菜单 */
.tm-ctx { position:fixed; z-index:100; background:var(--dsw-alias-bg-layer-2, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:8px; padding:4px 0; box-shadow:0 4px 16px rgba(0,0,0,.25); min-width:200px; font-size:12.5px; }
.tm-ctxIt { padding:6px 14px; cursor:pointer; color:var(--dsw-alias-label-primary, #000); display:flex; align-items:center; gap:6px; }
.tm-ctxIt:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-ctxIt.go { color:var(--dsw-alias-state-success-primary, #22c55e); font-weight:600; }
.tm-ctxIt.send { color:var(--dsw-alias-state-business-primary, #4170e6); font-weight:600; }
.tm-ctxIt.dis { opacity:.4; cursor:not-allowed; }
.tm-ctxIt.has-sub { position:relative; }
.tm-ctxArrow { margin-left:auto; font-size:9px; color:var(--dsw-alias-label-tertiary, #888); }
.tm-ctxSub { position:absolute; left:100%; top:-5px; margin-left:2px; background:var(--dsw-alias-bg-layer-2, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:8px; padding:4px 0; box-shadow:0 4px 16px rgba(0,0,0,.25); min-width:180px; z-index:101; }
.tm-ctxSep { border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); margin:3px 0; }
`
