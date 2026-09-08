import { PortLogError } from './errors.ts'

/** 复用宿主的跨平台原生选择器。 */
export interface DirectoryPickerService {
  capability(): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> }
}

export function createDirectoryPicker(getService: () => DirectoryPickerService | undefined) {
  let busy = false
  return async (signal: AbortSignal): Promise<string | null> => {
    const capability = getService()?.capability()
    if (capability?.kind !== 'native' || !capability.pick) {
      throw new PortLogError('IO_ERROR', '当前 DSH 未启用系统目录选择器')
    }
    if (busy) throw new PortLogError('IO_ERROR', '目录选择窗口已打开，请先完成选择或取消')
    signal.throwIfAborted()
    busy = true
    try {
      return await capability.pick(signal)
    } catch {
      throw new PortLogError('IO_ERROR', '无法打开系统目录选择器，请重试')
    } finally {
      busy = false
    }
  }
}
