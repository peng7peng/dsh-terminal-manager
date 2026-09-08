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
