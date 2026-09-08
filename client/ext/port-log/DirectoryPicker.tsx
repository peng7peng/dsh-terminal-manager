/** 日志目录选择：由 DSH 在本机打开系统原生文件夹对话框。 */
import { useEffect, useRef } from 'react'
import { portLogRpc } from './rpc.ts'

interface Props {
  onSelect: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export function DirectoryPicker({ onSelect, onCancel, onError }: Props): null {
  const callbacks = useRef({ onSelect, onCancel, onError })
  callbacks.current = { onSelect, onCancel, onError }

  useEffect(() => {
    const controller = new AbortController()
    // 延后一轮，避免 React StrictMode 的预演挂载打开两个系统窗口。
    const timer = setTimeout(() => {
      void portLogRpc<{ directory: string | null }>('sessionLogs.pickDirectory', {}, controller.signal).then(
        ({ directory }) => {
          if (controller.signal.aborted) return
          if (directory === null) callbacks.current.onCancel()
          else callbacks.current.onSelect(directory)
        },
        (err: unknown) => {
          if (!controller.signal.aborted) callbacks.current.onError(err instanceof Error ? err.message : '无法打开系统目录选择器')
        },
      )
    }, 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [])

  return null
}
