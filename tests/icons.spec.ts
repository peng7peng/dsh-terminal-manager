import { describe, expect, it } from 'vitest'
import * as icons from '../client/icons.tsx'

/** 0.2.1 的 primitives 不再导出通用图标；客户端本地图标必须全部是真实组件。 */
const REQUIRED = [
  'IconTerminal16', 'IconBroadcast16', 'IconSave16', 'IconPanelRight16', 'IconPanelBottom16',
  'IconChevronRightOutline14', 'IconChevronDownOutline14', 'IconChevronUpOutline14',
  'IconLinkOutline14', 'IconGlobeOutline14', 'IconGoalOutline16', 'IconRefreshOutline14',
  'IconFolderClose16', 'IconFolderOpen16', 'IconFolderOpenOutline16',
  'IconCheckOutline14', 'IconCloseFill14', 'IconFullscreenOutline16',
  'IconPlayOutline16', 'IconSendOutline14', 'IconWarningOutline16',
  'IconGear16', 'IconProbe16', 'IconShare16', 'IconMinimize16', 'IconMaximize16', 'IconRestore16',
  'IconFile16', 'IconFileExternal16', 'IconEye16', 'IconEyeOff16', 'IconPin16', 'IconEditor16', 'IconClock16', 'IconLock16',
] as const

describe('client 本地图标', () => {
  it('全部导出为组件（不再依赖 primitives 的图标）', () => {
    for (const name of REQUIRED) expect(typeof icons[name], name).toBe('function')
  })
})
