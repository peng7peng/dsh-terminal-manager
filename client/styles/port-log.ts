/** 端口映射、会话共享与日志扩展样式。 */
export const PORT_LOG_CSS = `
.tm-ext-pl-entry { display:inline-flex; align-items:center; justify-content:center; gap:6px; width:100%; height:36px; border:0; border-radius:8px; cursor:pointer; background:transparent; color:var(--dsw-alias-label-secondary,#666); font-size:13px; font-weight:600; }
.tm-ext-pl-entry:hover,.tm-ext-pl-entry.is-active { color:var(--dsw-alias-state-business-primary,#4170e6); background:var(--dsw-alias-state-business-tertiary,#e4edfd); }
.tm-ext-pl-overlay { position:fixed; inset:0 0 0 264px; z-index:60; display:flex; flex-direction:column; min-width:0; background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#171717); font:14px/1.5 var(--dsw-font-family,system-ui,sans-serif); }
.tm-ext-pl-header { flex:none; display:flex; align-items:center; justify-content:space-between; padding:18px 24px 12px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); }
.tm-ext-pl-header h2 { margin:0; font-size:20px; }
.tm-ext-pl-header p { margin:2px 0 0; color:var(--dsw-alias-label-tertiary,#888); font-size:12px; }
.tm-ext-pl-close { width:34px; height:34px; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); border-radius:9px; background:transparent; color:inherit; font-size:24px; cursor:pointer; }
.tm-ext-pl-tabs { display:flex; gap:4px; padding:10px 24px 0; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); }
.tm-ext-pl-tabs button { border:0; border-bottom:2px solid transparent; padding:8px 14px; background:transparent; color:var(--dsw-alias-label-secondary,#666); cursor:pointer; }
.tm-ext-pl-tabs button.is-active { border-bottom-color:var(--dsw-alias-state-business-primary,#4170e6); color:var(--dsw-alias-state-business-primary,#4170e6); font-weight:700; }
.tm-ext-pl-content { flex:1; min-height:0; overflow:auto; padding:18px 24px 32px; background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff)); }
.tm-ext-pl-section { max-width:1180px; margin:0 auto; }
.tm-ext-pl-form { display:grid; grid-template-columns:90px minmax(130px,1fr) 110px 24px minmax(130px,1fr) 110px auto auto; gap:8px; align-items:center; padding:14px; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); border-radius:12px; background:var(--dsw-alias-bg-layer-2,#f7f7f8); }
.tm-ext-pl-share-form { grid-template-columns:minmax(220px,2fr) minmax(130px,1fr) 110px 110px minmax(180px,1fr); }
.tm-ext-pl-form input,.tm-ext-pl-form select,.tm-ext-pl-toolbar select { min-width:0; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14)); border-radius:7px; padding:7px 9px; background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#171717); }
.tm-ext-pl-form input:focus,.tm-ext-pl-form select:focus { outline:2px solid var(--dsw-alias-state-business-tertiary,#dbe8ff); border-color:var(--dsw-alias-state-business-primary,#4170e6); }
.tm-ext-pl-form button,.tm-ext-pl-toolbar button,.tm-ext-pl-card button,.tm-ext-pl-global-error button { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14)); border-radius:7px; padding:7px 11px; background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#171717); cursor:pointer; }
.tm-ext-pl-form button:disabled { cursor:not-allowed; opacity:.45; }
.tm-ext-pl-primary { border-color:transparent!important; background:var(--dsw-alias-button-info-fill,#4170e6)!important; color:#fff!important; font-weight:650; }
.tm-ext-pl-arrow { text-align:center; color:var(--dsw-alias-label-caption,#aaa); }
.tm-ext-pl-check,.tm-ext-pl-risk { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--dsw-alias-label-secondary,#666); }
.tm-ext-pl-risk { grid-column:1/-2; color:var(--dsw-alias-state-warn-primary,#b45309); }
.tm-ext-pl-toolbar { display:flex; align-items:center; gap:10px; margin:12px 0; }
.tm-ext-pl-toolbar label { display:flex; align-items:center; gap:6px; }
.tm-ext-pl-file { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14)); border-radius:7px; padding:6px 10px; cursor:pointer; }
.tm-ext-pl-file input { display:none; }
.tm-ext-pl-list { display:grid; gap:9px; }
.tm-ext-pl-card { display:grid; grid-template-columns:minmax(240px,1fr) auto; gap:7px 14px; padding:13px 15px; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); border-radius:10px; background:var(--dsw-alias-bg-base,#fff); }
.tm-ext-pl-card-main { min-width:0; display:flex; flex-direction:column; }
.tm-ext-pl-card-main span,.tm-ext-pl-path { overflow:hidden; text-overflow:ellipsis; color:var(--dsw-alias-label-tertiary,#888); font:12px var(--dsw-font-code,monospace); }
.tm-ext-pl-status { align-self:start; border-radius:999px; padding:2px 8px; background:var(--dsw-alias-bg-layer-2,#eee); font-size:11px; font-weight:700; text-transform:uppercase; }
.tm-ext-pl-status.is-running { background:rgba(34,197,94,.14); color:var(--dsw-alias-state-success-primary,#15803d); }
.tm-ext-pl-status.is-error { background:rgba(239,68,68,.12); color:var(--dsw-alias-state-error-primary,#dc2626); }
.tm-ext-pl-metrics,.tm-ext-pl-client { grid-column:1/-1; color:var(--dsw-alias-label-secondary,#666); font-size:12px; }
.tm-ext-pl-client { padding-left:12px; font-family:var(--dsw-font-code,monospace); }
.tm-ext-pl-error { grid-column:1/-1; color:var(--dsw-alias-state-error-primary,#dc2626); font-size:12px; }
.tm-ext-pl-actions { grid-column:1/-1; display:flex; gap:7px; }
.tm-ext-pl-actions .danger { color:var(--dsw-alias-state-error-primary,#dc2626); }
.tm-ext-pl-warning { margin-bottom:12px; padding:10px 12px; border:1px solid var(--dsw-alias-state-warn-primary,#d97706); border-radius:9px; background:rgba(245,158,11,.1); color:var(--dsw-alias-label-primary,#171717); font-size:12px; }
.tm-ext-pl-global-error { margin:10px 24px 0; padding:9px 12px; display:flex; justify-content:space-between; align-items:center; border-radius:8px; background:rgba(239,68,68,.12); color:var(--dsw-alias-state-error-primary,#dc2626); }
.tm-ext-pl-loading { padding:5px 24px; color:var(--dsw-alias-label-tertiary,#888); font-size:12px; }
.tm-ext-pl-empty { padding:30px; text-align:center; color:var(--dsw-alias-label-tertiary,#888); }
.tm-ext-pl-app-log { margin-bottom:12px; }
@media (max-width:900px) { .tm-ext-pl-overlay { left:0; } .tm-ext-pl-form,.tm-ext-pl-share-form { grid-template-columns:1fr 1fr; } .tm-ext-pl-arrow { display:none; } .tm-ext-pl-risk { grid-column:1/-1; } }
`
