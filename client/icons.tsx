/**
 * 自绘 inline SVG 图标 —— 补充 dsh-client-ui-primitives 里缺失的终端 / 广播图标。
 * 风格统一为线条图标，fill="currentColor"，16x16 viewBox。
 * @module dsh-terminal-manager/client/icons
 */

/** 终端图标 `>_` —— 用于侧边栏入口和终端区头部 */
export function IconTerminal16({ size = 16, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4 6L6 8L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="8" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 广播 / 喇叭图标 —— 用于广播栏标签 */
export function IconBroadcast16({ size = 16, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 6.5V9.5H4L7.5 12V4L4 6.5H2Z" fill="currentColor" />
      <path d="M9.5 5.5C10.5 6.5 10.5 9.5 9.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M11.5 3.5C13.5 5.5 13.5 10.5 11.5 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
    </svg>
  )
}

/** 存盘图标 —— 实心软盘，外壳颜色由按钮状态通过 currentColor 控制。 */
export function IconSave16({ size = 16, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2.25 1H11.5L15 4.5V14C15 14.55 14.55 15 14 15H2C1.45 15 1 14.55 1 14V2.25C1 1.56 1.56 1 2.25 1Z" fill="currentColor" />
      <path d="M3.25 1H11.25V6.5H3.25V1Z" fill="#f7f8fa" />
      <path d="M9.25 1H11.25V5.5H9.25V1Z" fill="#263238" />
      <path d="M3.5 9H12.5V15H3.5V9Z" fill="#e5e7eb" />
      <path d="M5 10.5H11V11.5H5V10.5ZM5 12.5H11V13.5H5V12.5Z" fill="#9ca3af" />
      <path d="M1 13.75H3.5V15H2C1.45 15 1 14.55 1 14V13.75ZM12.5 13.75H15V14C15 14.55 14.55 15 14 15H12.5V13.75Z" fill="#263238" fillOpacity=".35" />
    </svg>
  )
}

/** 右侧面板图标 —— 矩形右侧有实心条，VSCode panel 风格。visible=true 时实心，false 时镂空。 */
export function IconPanelRight16({ size = 16, className, visible = true }: { size?: number; className?: string; visible?: boolean }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      {visible
        ? <rect x="10" y="2" width="4" height="12" fill="currentColor" />
        : <line x1="10" y1="2" x2="10" y2="14" stroke="currentColor" strokeWidth="1" opacity="0.5" />}
    </svg>
  )
}

/** 下方面板图标 —— 矩形底部有实心条，VSCode panel 风格。visible=true 时实心，false 时镂空。 */
export function IconPanelBottom16({ size = 16, className, visible = true }: { size?: number; className?: string; visible?: boolean }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      {visible
        ? <rect x="2" y="10" width="12" height="4" fill="currentColor" />
        : <line x1="2" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1" opacity="0.5" />}
    </svg>
  )
}

/** 统一的小图标外壳：16x16 线性图标，currentColor 描边。 */
function Glyph({ size = 16, className, children }: { size?: number; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {children}
    </svg>
  )
}

export function IconChevronRightOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconChevronDownOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconChevronUpOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M3 10l5-5 5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconLinkOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M6.5 9.5l3-3M5 7l-1.2 1.2a2.8 2.8 0 004 4L9 11M11 9l1.2-1.2a2.8 2.8 0 00-4-4L7 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></Glyph>
}
export function IconGlobeOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" /><ellipse cx="8" cy="8" rx="2.6" ry="6" stroke="currentColor" strokeWidth="1.1" /><path d="M2.2 8h11.6" stroke="currentColor" strokeWidth="1.1" /></Glyph>
}
export function IconGoalOutline16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="8" r="0.9" fill="currentColor" /></Glyph>
}
export function IconRefreshOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M13 8a5 5 0 11-1.6-3.7M13 2.5V6h-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconFolderClose16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.3 1.5H13A1.5 1.5 0 0114.5 6v5A1.5 1.5 0 0113 12.5H3A1.5 1.5 0 011.5 11V4.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></Glyph>
}
export function IconFolderOpen16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M2 5h4l1.2 1.5H12A1.5 1.5 0 0113.5 8v4A1.5 1.5 0 0112 13.5H3A1.5 1.5 0 011.5 12V5M1.5 12l1.8-4.5h11.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></Glyph>
}
export function IconFolderOpenOutline16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M2 5.5h4l1.2 1.5H11A2 2 0 0113 9v3.5H3.5A1.5 1.5 0 012 11V5.5ZM2 11l1.6-4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></Glyph>
}
export function IconCheckOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M3 8.5l3 3L13 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconCloseFill14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Glyph>
}
export function IconFullscreenOutline16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></Glyph>
}
export function IconPlayOutline16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M5 3.5l7.5 4.5L5 12.5V3.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></Glyph>
}
export function IconSendOutline14(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M13.5 2.5L2.5 7l4.2 1.6L8.5 13l5-10.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M6.7 8.6L9.6 5.7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></Glyph>
}
export function IconWarningOutline16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M8 2.2l6 11H2l6-11Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 6v3.2M8 11.2v.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></Glyph>
}

/** 齿轮（键盘模式） */
export function IconGear16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></Glyph>
}
/** 探针（连接可达性） */
export function IconProbe16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /></Glyph>
}
/** 共享（链环） */
export function IconShare16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M6.2 9.8l3.6-3.6M5.2 7.2l-1.1 1.1a2.9 2.9 0 004.1 4.1l1.1-1.1M10.8 8.8l1.1-1.1a2.9 2.9 0 00-4.1-4.1L6.7 4.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></Glyph>
}
export function IconMinimize16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><path d="M3 12.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Glyph>
}
export function IconMaximize16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><rect x="3" y="3" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" /></Glyph>
}
export function IconRestore16(p: { size?: number; className?: string }): React.JSX.Element {
  return <Glyph {...p}><rect x="2.5" y="4.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 4.5V2.5h8v8h-2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></Glyph>
}
