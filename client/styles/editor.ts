/**
 * F8/F9 浮动编辑器样式（窗体 / 标签栏 / 编辑区 / 底栏 / 最小化标签）。
 * @module dsh-terminal-manager/client/styles/editor
 */

export const EDITOR_CSS = `
.tm-floatEd { position:fixed; z-index:60; display:flex; flex-direction:column; overflow:hidden; background:var(--dsw-alias-bg-layer-2, #fff); border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.16)); border-radius:10px; box-shadow:0 14px 44px rgba(0,0,0,.35); color:var(--dsw-alias-label-primary, #000); font-size:13px; }
.tm-floatEd.dragging { user-select:none; }
.tm-floatEd.dragging iframe, .tm-floatEd.dragging textarea, .tm-floatEd.dragging .cm-editor { pointer-events:none; }
.tm-feHead { flex:none; display:flex; align-items:center; gap:8px; padding:5px 8px; min-height:30px; background:var(--dsw-alias-bg-module-platform, #f5f6f7); border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); cursor:grab; user-select:none; touch-action:none; }
.tm-feHead:active { cursor:grabbing; }
.tm-feTabs { display:flex; gap:4px; flex:1; min-width:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; }
.tm-feTab { display:flex; align-items:center; gap:6px; padding:3px 6px 3px 10px; border-radius:6px; font-size:12px; cursor:pointer; color:var(--dsw-alias-label-tertiary, #888); white-space:nowrap; flex:none; max-width:220px; }
.tm-feTab .nm { overflow:hidden; text-overflow:ellipsis; }
.tm-feTab.active { background:var(--dsw-alias-bg-layer-2, #fff); color:var(--dsw-alias-label-primary, #000); font-weight:600; box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-feTab .dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-warn-primary, #d29922); display:none; flex:none; }
.tm-feTab.dirty .dot { display:inline-block; }
.tm-feTab .x { display:inline-flex; background:none; border:none; padding:2px; border-radius:4px; cursor:pointer; color:inherit; opacity:.5; }
.tm-feTab .x:hover { opacity:1; background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.tm-feTab .x svg { width:12px; height:12px; }
.tm-feCtrls { display:flex; gap:2px; flex:none; }
.tm-feCtrls button { display:inline-flex; align-items:center; background:transparent; border:none; color:var(--dsw-alias-label-tertiary, #888); cursor:pointer; padding:3px 6px; border-radius:5px; font-size:13px; }
.tm-feCtrls button:hover { background:var(--dsw-alias-bg-layer-2, #fff); color:var(--dsw-alias-label-primary, #000); }
.tm-feCtrls button svg { width:14px; height:14px; }
.tm-feBody { flex:1; min-height:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-base, #fff); position:relative; }
.tm-feBanner { flex:none; padding:4px 12px; font-size:11.5px; background:var(--dsw-alias-state-warn-tertiary, #fff7e6); color:var(--dsw-alias-state-warn-primary, #d29922); border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.tm-feTextarea { flex:1; min-height:0; width:100%; box-sizing:border-box; resize:none; border:none; outline:none; padding:8px 12px; background:transparent; color:var(--dsw-alias-label-primary, #000); font:12px/1.6 var(--dsw-font-code, "JetBrains Mono", Consolas, monospace); white-space:pre; overflow:auto; tab-size:4; }
.tm-feCm { flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column; }
.tm-feCm .cm-editor { height:100%; }
.tm-feLoading { flex:1; display:flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-tertiary, #888); }
.tm-feFoot { flex:none; display:flex; align-items:center; gap:8px; padding:6px 10px; border-top:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-2, #fff); }
.tm-feFoot .hint { color:var(--dsw-alias-label-tertiary, #888); font-size:11.3px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--dsw-font-code, monospace); }
.tm-feBtn { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base, #fff); color:var(--dsw-alias-label-primary, #000); border-radius:7px; padding:4px 12px; font-size:12px; cursor:pointer; font-weight:600; white-space:nowrap; }
.tm-feBtn svg { width:14px; height:14px; }
.tm-feBtn.send { color:var(--dsw-alias-state-business-primary, #4170e6); border-color:var(--dsw-alias-state-business-primary, #4170e6); }
.tm-feBtn.go { background:var(--dsw-alias-state-success-primary, #22c55e); border-color:var(--dsw-alias-state-success-primary, #22c55e); color:#fff; }
.tm-feBtn:disabled { opacity:.4; cursor:not-allowed; }
.tm-feBtn:not(:disabled):hover { filter:brightness(1.08); }
/* 四角四边缩放把手（行为同浏览器窗口）；角比边高一层 */
.tm-feRs { position:absolute; touch-action:none; z-index:2; }
.tm-feRs.n, .tm-feRs.s { left:8px; right:8px; height:6px; }
.tm-feRs.e, .tm-feRs.w { top:8px; bottom:8px; width:6px; }
.tm-feRs.n { top:-3px; cursor:ns-resize; } .tm-feRs.s { bottom:-3px; cursor:ns-resize; }
.tm-feRs.e { right:-3px; cursor:ew-resize; } .tm-feRs.w { left:-3px; cursor:ew-resize; }
.tm-feRs.ne, .tm-feRs.nw, .tm-feRs.se, .tm-feRs.sw { width:14px; height:14px; z-index:3; }
.tm-feRs.nw { left:-4px; top:-4px; cursor:nwse-resize; } .tm-feRs.se { right:-4px; bottom:-4px; cursor:nwse-resize; }
.tm-feRs.ne { right:-4px; top:-4px; cursor:nesw-resize; } .tm-feRs.sw { left:-4px; bottom:-4px; cursor:nesw-resize; }
.tm-feRs.se { background:linear-gradient(135deg, transparent 55%, var(--dsw-alias-border-l3, rgba(0,0,0,.2)) 55%, var(--dsw-alias-border-l3, rgba(0,0,0,.2)) 65%, transparent 65%, transparent 80%, var(--dsw-alias-border-l3, rgba(0,0,0,.2)) 80%); }
.tm-feMinIcon { position:fixed; z-index:59; right:316px; bottom:14px; width:36px; height:36px; border-radius:50%; border:1px solid var(--dsw-alias-state-business-primary, #4170e6); background:var(--dsw-alias-bg-layer-2, #fff); color:var(--dsw-alias-label-primary, #000); font-size:16px; line-height:1; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,.25); display:flex; align-items:center; justify-content:center; padding:0; }
.tm-feMinIcon:hover { transform:scale(1.08); }
.tm-feMinIcon .cnt { position:absolute; top:-5px; right:-5px; min-width:16px; height:16px; padding:0 4px; border-radius:8px; background:var(--dsw-alias-state-business-primary, #4170e6); color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.tm-feMinIcon.dirty .cnt { background:var(--dsw-alias-state-warn-primary, #d29922); }
`
