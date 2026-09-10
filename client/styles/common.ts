/**
 * 九月新增模块共用样式：toast、模态框、右键菜单、TC 徽章、小按钮。
 * @module dsh-terminal-manager/client/styles/common
 */

export const COMMON_CSS = `
/* toast */
.tm-toasts { position:fixed; z-index:99; left:50%; bottom:56px; transform:translateX(-50%); display:flex; flex-direction:column; gap:6px; align-items:center; pointer-events:none; }
.tm-toast { background:var(--dsw-alias-bg-layer-2, #161b22); border:1px solid var(--dsw-alias-state-business-primary, #4170e6); color:var(--dsw-alias-label-primary, #000); border-radius:9px; padding:8px 18px; font-size:12.5px; box-shadow:0 8px 24px rgba(0,0,0,.25); max-width:70vw; white-space:pre-wrap; }
.tm-toast.ok { border-color:var(--dsw-alias-state-success-primary, #22c55e); }
.tm-toast.error { border-color:var(--dsw-alias-state-error-primary, #ef4444); }

/* 模态框 */
.tm-mask { position:fixed; inset:0; z-index:95; background:rgba(0,0,0,.42); display:flex; align-items:center; justify-content:center; }
.tm-modal { width:400px; max-width:92vw; background:var(--dsw-alias-bg-layer-2, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:12px; box-shadow:0 14px 44px rgba(0,0,0,.35); overflow:hidden; color:var(--dsw-alias-label-primary, #000); font-size:13px; }
.tm-modal.wide { width:520px; }
.tm-mHead { padding:10px 14px; font-weight:700; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); display:flex; align-items:center; gap:8px; }
.tm-mBody { padding:10px 14px; display:flex; flex-direction:column; gap:4px; max-height:50vh; overflow:auto; }
.tm-mRow { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:7px; font-size:12.5px; }
.tm-mRow.click { cursor:pointer; }
.tm-mRow.click:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-mRow .sub { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; margin-left:auto; font-family:var(--dsw-font-code, monospace); }
.tm-mRow .miss { color:var(--dsw-alias-state-error-primary, #ef4444); font-size:11px; margin-left:auto; }
.tm-mNote { color:var(--dsw-alias-label-tertiary, #888); font-size:11.3px; padding:4px 14px; }
.tm-mNote.warn { color:var(--dsw-alias-state-warn-primary, #d29922); }
.tm-mFoot { display:flex; justify-content:flex-end; align-items:center; gap:8px; padding:10px 14px; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-mFoot .sp { flex:1; }
.tm-mFoot label { font-size:12px; color:var(--dsw-alias-label-secondary, #666); display:flex; align-items:center; gap:4px; }
.tm-btnPlain { padding:5px 14px; background:var(--dsw-alias-bg-base, #fff); color:var(--dsw-alias-label-primary, #000); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:6px; cursor:pointer; font-size:12.5px; }
.tm-btnPrimary { padding:5px 16px; background:var(--dsw-alias-button-info-fill, #4170e6); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:12.5px; }
.tm-btnGo { padding:5px 16px; background:var(--dsw-alias-state-success-primary, #22c55e); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:12.5px; }
.tm-btnPrimary:disabled, .tm-btnGo:disabled, .tm-btnPlain:disabled { opacity:.45; cursor:not-allowed; }
.tm-modal input[type=text] { width:100%; box-sizing:border-box; background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; color:var(--dsw-alias-label-primary, #000); padding:6px 9px; font-size:12.5px; font-family:var(--dsw-font-code, monospace); }

/* 小工具按钮（面板工具栏 / 编辑器底栏） */
.tm-tbtn { display:inline-flex; align-items:center; gap:4px; background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); color:var(--dsw-alias-label-primary, #000); border-radius:6px; padding:2px 8px; cursor:pointer; font-size:11.5px; line-height:1.6; white-space:nowrap; }
.tm-tbtn:hover:not(:disabled) { border-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-tbtn:disabled { opacity:.4; cursor:not-allowed; }
.tm-tbtn svg { width:14px; height:14px; }

/* TC 编号徽章 */
.tm-tcn { flex:none; font-size:9.5px; font-weight:700; color:#fff; background:var(--dsw-alias-state-business-primary, #4170e6); border-radius:4px; padding:0 5px; line-height:1.6; font-family:var(--dsw-font-code, monospace); }
.tm-tcn.ghost { background:transparent; color:var(--dsw-alias-state-business-primary, #4170e6); border:1px solid var(--dsw-alias-state-business-primary, #4170e6); }

/* 「浏览」标准目录选择器 */
.tm-dp { width:660px; max-width:94vw; height:440px; max-height:88vh; display:flex; flex-direction:column; }
.tm-dp-body { flex:1; min-height:0; display:flex; }
.tm-dp-side { flex:none; width:172px; border-right:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); overflow-y:auto; padding:6px 0; background:var(--dsw-alias-bg-layer-1, #f7f8fa); box-sizing:border-box; }
.tm-dp-sideLabel { padding:7px 14px 4px; font-size:10.5px; color:var(--dsw-alias-label-tertiary, #888); letter-spacing:.05em; }
.tm-dp-item { display:flex; align-items:center; gap:7px; padding:5px 14px; font-size:12.5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tm-dp-item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-dp-item.act { background:var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.12)); font-weight:600; }
.tm-dp-main { flex:1; min-width:0; display:flex; flex-direction:column; }
.tm-dp-toolbar { flex:none; display:flex; align-items:center; gap:2px; padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-dp-nav { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; color:var(--dsw-alias-label-secondary, #666); border-radius:6px; cursor:pointer; padding:0; }
.tm-dp-nav:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.08)); }
.tm-dp-nav:disabled { opacity:.35; cursor:not-allowed; }
.tm-dp-nav svg { width:15px; height:15px; }
.tm-dp-addr { flex:1; min-width:0; display:flex; align-items:center; gap:3px; margin-left:6px; background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; padding:2px 8px; cursor:text; overflow:hidden; }
.tm-dp-addr:focus-within { border-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-dp-addr input { flex:1; min-width:0; border:none; outline:none; background:transparent; color:var(--dsw-alias-label-primary, #000); font-size:12.5px; font-family:var(--dsw-font-code, monospace); padding:3px 0; }
.tm-dp-crumb { display:inline-flex; align-items:center; gap:3px; max-width:150px; padding:3px 7px; border-radius:6px; font-size:12px; color:var(--dsw-alias-label-secondary, #666); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:var(--dsw-font-code, monospace); }
.tm-dp-crumb:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.08)); }
.tm-dp-crumb.act { background:var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.12)); color:var(--dsw-alias-label-primary, #000); }
.tm-dp-crumbSep { flex:none; color:var(--dsw-alias-label-tertiary, #aaa); font-size:11px; }
.tm-dp-list { flex:1; min-height:0; overflow-y:auto; padding:5px; box-sizing:border-box; }
.tm-dp-row { display:flex; align-items:center; gap:8px; padding:5px 9px; border-radius:7px; font-size:12.5px; cursor:pointer; white-space:nowrap; }
.tm-dp-row:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-dp-row .ico { flex:none; font-size:14px; line-height:1; }
.tm-dp-row .nm { overflow:hidden; text-overflow:ellipsis; font-family:var(--dsw-font-code, monospace); }
.tm-dp-hint { color:var(--dsw-alias-label-tertiary, #888); font-size:12px; padding:14px; text-align:center; }
.tm-dp-err { color:var(--dsw-alias-state-error-primary, #ef4444); font-size:12px; padding:12px 8px; margin:5px; background:var(--dsw-alias-bg-layer-2, #f5f6f7); border-radius:7px; }
`
