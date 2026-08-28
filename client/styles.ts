/**
 * 工作区样式 —— 注入一个 <style data-plugin="term-manager"> 标签，用 DSH 页面上的 --dsw-* token。
 * 不用 CSS Modules（省去构建插件），全局类名加 .tm- 前缀防冲突。
 * @module dsh-terminal-manager/client/styles
 */

export const WORKSPACE_CSS = `
.tm-overlay { position:fixed; top:0; bottom:0; z-index:50; display:flex; background:var(--dsw-alias-bg-base, #fff); color:var(--dsw-alias-label-primary, #000); font:14px/1.5 var(--dsw-font-family, system-ui, sans-serif); box-shadow:-2px 0 12px rgba(0,0,0,.12); }
.tm-overlay[hidden] { display:none; }

/* 可拖动分隔条（聊天 ↔ 终端） */
.tm-draghandle { position:absolute; top:0; bottom:0; left:-3px; width:6px; cursor:col-resize; z-index:51; }
.tm-draghandle::after { content:''; position:absolute; inset:0 2px; border-radius:3px; opacity:0; transition:opacity .15s; background:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-draghandle:hover::after, .tm-draghandle:active::after { opacity:1; }

/* 两栏：终端区 | 连接面板 */
.tm-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; border-right:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-side { flex:0 0 300px; display:flex; flex-direction:column; min-height:0; background:var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2, #f5f6f7)); }
@media (max-width:1000px) { .tm-side { flex-basis:240px; } .tm-sideScroll { padding:8px; } }

/* 终端区头 */
.tm-head { flex:none; display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-head .t { font-size:14px; font-weight:600; }
.tm-head .sp { flex:1; }
.tm-head .onb { font-size:12px; color:var(--dsw-alias-label-tertiary, #888); }
.tm-head .onb b { color:var(--dsw-alias-state-success-primary, #22c55e); }
.tm-close { border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:transparent; color:var(--dsw-alias-label-secondary, #666); border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
.tm-close:hover { color:var(--dsw-alias-state-error-primary, #ef4444); border-color:var(--dsw-alias-state-error-primary, #ef4444); }

/* 终端网格：auto-fit + 封顶 760px + 居中——小屏填满、全屏不无限拉伸（窗格过宽行长难读） */
.tm-grid { flex:1; min-height:0; overflow:auto; padding:6px; display:grid; grid-template-columns:repeat(auto-fit, minmax(min(280px, 100%), 760px)); justify-content:center; gap:6px; background:var(--dsw-alias-bg-base, #fff); }
.tm-pane { display:flex; flex-direction:column; min-height:180px; border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.16)); border-radius:6px; overflow:hidden; }
.tm-paneBar { flex:none; display:flex; align-items:center; gap:7px; padding:4px 9px; background:var(--dsw-alias-bg-layer-2, #161b22); border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); font-size:11.5px; color:var(--dsw-alias-label-secondary, #8a91a5); }
.tm-paneBar .dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-static-green-500, #22c55e); }
.tm-paneBar .nm { font-weight:600; font-family:var(--dsw-font-code, monospace); color:var(--dsw-alias-label-primary, #fff); }
.tm-paneBar .tgt { color:var(--dsw-alias-label-tertiary, #67718a); font-family:var(--dsw-font-code, monospace); font-size:10px; }
.tm-paneBar button { margin-left:auto; background:none; border:none; color:var(--dsw-alias-label-caption, #768390); cursor:pointer; font-size:12px; }
.tm-paneBar button:hover { color:var(--dsw-alias-state-error-primary, #ef4444); }
.tm-paneBody { flex:1; min-height:0; overflow:hidden; }

/* 广播栏（两行：第一行目标 chips，第二行输入框+发送） */
.tm-bcast { flex:none; display:flex; flex-direction:column; gap:6px; padding:7px 12px; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-brow { display:flex; align-items:center; gap:6px; min-width:0; }
.tm-bcast .lb { font-size:12px; color:var(--dsw-alias-label-secondary, #666); flex:none; }
.tm-bchips { display:flex; gap:3px; flex-wrap:wrap; flex:1; min-width:0; }
.tm-bchip { font-size:11px; padding:1px 8px; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:999px; cursor:pointer; color:var(--dsw-alias-label-tertiary, #888); user-select:none; }
.tm-bchip.on { border-color:var(--dsw-alias-state-business-primary, #4170e6); color:var(--dsw-alias-state-business-primary, #4170e6); background:var(--dsw-alias-state-business-tertiary, #e4edfd); }
.tm-bcast input { flex:1; min-width:60px; background:var(--dsw-alias-bg-module-platform, #f5f6f7); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; color:var(--dsw-alias-label-primary, #000); padding:4px 9px; font:12px var(--dsw-font-code, monospace); outline:none; }
.tm-bcast input:focus { border-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-bsend { border:none; background:var(--dsw-alias-button-info-fill, #4170e6); color:#fff; border-radius:7px; padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer; flex:none; }
.tm-bsend:hover { background:var(--dsw-alias-button-info-hover, #5a8aff); }

/* 连接面板 */
.tm-sideHead { flex:none; display:flex; align-items:center; gap:6px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-sideHead .t { font-size:13px; font-weight:600; }
.tm-sideScroll { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.tm-ptabs { display:flex; gap:2px; }
.tm-ptab { flex:1; text-align:center; padding:5px 0; font-size:12px; font-weight:600; color:var(--dsw-alias-label-tertiary, #888); cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; user-select:none; }
.tm-ptab.on { color:#fff; background:var(--dsw-alias-state-business-primary, #4170e6); border-color:transparent; }
.tm-fld { display:flex; flex-direction:row; align-items:center; gap:8px; margin-bottom:6px; }
.tm-fld label { font-size:12px; color:var(--dsw-alias-label-secondary, #666); flex:0 0 auto; min-width:42px; text-align:right; }
.tm-fld input { background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; color:var(--dsw-alias-label-primary, #000); padding:6px 9px; font-size:12.5px; outline:none; width:100%; flex:1; box-sizing:border-box; }
.tm-fld input:focus { border-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-fld.error input { border-color:var(--dsw-alias-state-error-primary, #ef4444); }
.tm-fld select { background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:7px; color:var(--dsw-alias-label-primary, #000); padding:6px 9px; font-size:12.5px; outline:none; flex:1; box-sizing:border-box; }
.tm-req { color:var(--dsw-alias-state-error-primary, #ef4444); }
.tm-opt { font-size:9px; color:var(--dsw-alias-label-caption, #aaa); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:5px; padding:0 4px; margin-left:3px; }
.tm-pwdWrap { position:relative; flex:1; }
.tm-pwdWrap input { padding-right:28px; }
.tm-pwdToggle { position:absolute; right:8px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:14px; opacity:.6; user-select:none; }
.tm-pwdToggle:hover { opacity:1; }
.tm-advToggle { display:flex; align-items:center; gap:5px; cursor:pointer; font-size:11px; color:var(--dsw-alias-label-tertiary, #888); margin:8px 0 4px; user-select:none; }
.tm-advToggle:hover { color:var(--dsw-alias-label-primary, #000); }
.tm-advToggle .arrow { transition:transform .2s; }
.tm-advToggle.open .arrow { transform:rotate(90deg); }
.tm-advBody { display:none; }
.tm-advBody.open { display:block; }
.tm-unread { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-business-primary, #4170e6); flex:none; }
.tm-ctxMenu { position:fixed; z-index:100; background:var(--dsw-alias-bg-layer-2, #161b22); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:8px; padding:4px 0; box-shadow:0 4px 16px rgba(0,0,0,.2); min-width:120px; }
.tm-ctxItem { padding:6px 16px; cursor:pointer; font-size:12px; color:var(--dsw-alias-label-secondary, #666); }
.tm-ctxItem:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color:var(--dsw-alias-label-primary, #000); }
.tm-ctxSep { height:1px; background:var(--dsw-alias-border-l2, rgba(0,0,0,.1)); margin:4px 0; }
.tm-authSwitch { display:flex; gap:4px; margin-bottom:7px; }
.tm-authSwitch span { flex:1; text-align:center; font-size:11px; padding:4px 0; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius:6px; cursor:pointer; color:var(--dsw-alias-label-secondary, #666); user-select:none; }
.tm-authSwitch span.on { border-color:var(--dsw-alias-state-business-primary, #4170e6); color:var(--dsw-alias-state-business-primary, #4170e6); background:var(--dsw-alias-state-business-tertiary, #e4edfd); }
.tm-btn { border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base, #fff); color:var(--dsw-alias-label-secondary, #666); border-radius:8px; padding:6px 10px; font-size:12px; cursor:pointer; }
.tm-btn:hover { border-color:var(--dsw-alias-state-business-primary, #4170e6); color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-btn.primary { flex:1; background:var(--dsw-alias-button-info-fill, #4170e6); border-color:transparent; color:#fff; }
.tm-btn.primary:hover { background:var(--dsw-alias-button-info-hover, #5a8aff); }
.tm-secLabel { font-size:10px; color:var(--dsw-alias-label-caption, #aaa); font-weight:600; letter-spacing:.5px; margin-bottom:4px; }
.tm-ritem { display:flex; align-items:center; gap:7px; padding:6px 8px; border-radius:7px; background:var(--dsw-alias-bg-base, #fff); border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); font-size:12px; cursor:pointer; margin-bottom:4px; }
.tm-ritem:hover { border-color:var(--dsw-alias-border-l3, rgba(0,0,0,.16)); }
.tm-pico { font-size:9px; font-weight:700; padding:1px 5px; border-radius:4px; font-family:var(--dsw-font-code, monospace); }
.tm-pico.ssh { background:var(--dsw-alias-state-business-tertiary, #e4edfd); color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-pico.telnet { background:var(--dsw-alias-state-warn-primary, #f59e0b); color:#fff; }
.tm-ritem .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
.tm-sub { display:block; font-size:10px; font-weight:400; color:var(--dsw-alias-label-caption, #aaa); font-family:var(--dsw-font-code, monospace); }
.tm-ritem .st { width:7px; height:7px; border-radius:50%; flex:none; }
.tm-ritem .st.off { background:var(--dsw-alias-label-caption, #aaa); opacity:.5; }
.tm-ritem .st.connecting { background:var(--dsw-alias-state-warn-primary, #f59e0b); }
.tm-ritem .st.on { background:var(--dsw-alias-state-success-primary, #22c55e); box-shadow:0 0 4px var(--dsw-alias-state-success-primary, #22c55e); }
.tm-ritem.pinned { border-left:2px solid var(--dsw-alias-state-warn-primary, #f59e0b); }
.tm-ritem.dimmed { opacity:.5; border-style:dashed; }
.tm-drag { flex:none; cursor:grab; color:var(--dsw-alias-label-caption, #aaa); font-size:14px; padding-right:2px; }
.tm-eye-off { font-size:13px; color:var(--dsw-alias-label-caption, #aaa); flex:none; }
.tm-eye-btn { flex:none; background:none; border:none; cursor:pointer; font-size:14px; padding:0 2px; opacity:.6; }
.tm-eye-btn:hover { opacity:1; }
.tm-term-hidden { display:none !important; }
.tm-ritem.dragging { opacity:.3; }
.tm-empty { color:var(--dsw-alias-label-caption, #aaa); padding:10px; text-align:center; font-size:12px; }
`
