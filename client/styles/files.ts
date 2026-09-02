/**
 * F7 本地文件面板样式（广播栏下方的收起条 / 展开面板）。
 * @module dsh-terminal-manager/client/styles/files
 */

export const FILES_CSS = `
.tm-fpanel { flex:none; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-2, #f5f6f7); display:flex; flex-direction:column; min-height:0; }
.tm-fpBar { flex:none; display:flex; align-items:center; gap:8px; padding:5px 12px; cursor:pointer; user-select:none; touch-action:none; font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-primary, #000); white-space:nowrap; }
.tm-fpBar:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-fpBar .arrow { display:inline-flex; color:var(--dsw-alias-label-tertiary, #888); transition:transform .15s; }
.tm-fpBar .arrow svg { width:12px; height:12px; }
.tm-fpanel.open .tm-fpBar .arrow { transform:rotate(90deg); }
.tm-fpanel.open .tm-fpBar { cursor:ns-resize; border-top:2px solid transparent; }
.tm-fpanel.open .tm-fpBar:hover { border-top-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-fpanel.resizing { user-select:none; }
.tm-fpBar .sub { color:var(--dsw-alias-label-tertiary, #888); font-weight:400; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--dsw-font-code, monospace); min-width:0; }
.tm-fpBody { display:flex; flex-direction:column; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); min-height:0; }
.tm-fpToolbar { flex:none; display:flex; align-items:center; gap:6px; padding:5px 10px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; white-space:nowrap; }
.tm-tbtn.icon { padding:3px 6px; }
.tm-tbtn.icon svg { width:14px; height:14px; }
.tm-fpToolbar .hint { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; margin-left:6px; white-space:nowrap; }
.tm-fpPath { flex:none; display:flex; align-items:center; gap:2px; padding:2px 10px 5px; font:11.3px var(--dsw-font-code, monospace); color:var(--dsw-alias-label-tertiary, #888); flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; white-space:nowrap; }
.tm-fpPath .crumb { display:inline-flex; align-items:center; flex:none; }
.tm-fpPath .seg { cursor:pointer; padding:0 3px; border-radius:4px; }
.tm-fpPath .seg:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color:var(--dsw-alias-label-primary, #000); }
.tm-fpPath .seg.cur { color:var(--dsw-alias-label-primary, #000); font-weight:600; }
.tm-fpList { flex:1; overflow:auto; padding:0 6px 6px; min-height:0; }
.tm-fpRow { display:flex; align-items:center; gap:8px; padding:3px 8px; border-radius:6px; font-size:12.3px; cursor:pointer; user-select:none; color:var(--dsw-alias-label-primary, #000); }
.tm-fpRow:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-fpRow.sel { background:var(--dsw-alias-state-business-tertiary, #e4edfd); outline:1px solid var(--dsw-alias-state-business-primary, #4170e6); }
.tm-fpRow .ico { flex:none; width:16px; text-align:center; }
.tm-fpRow .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tm-fpRow .sz { margin-left:auto; color:var(--dsw-alias-label-tertiary, #888); font-size:11px; flex:none; font-family:var(--dsw-font-code, monospace); }
.tm-fpEmpty { color:var(--dsw-alias-label-tertiary, #888); padding:10px; font-size:12px; }
.tm-fpErr { color:var(--dsw-alias-state-error-primary, #ef4444); padding:10px; font-size:12px; }
`
