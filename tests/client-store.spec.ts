import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  setWorkspaceVisible,
  toggleWorkspace,
  getWorkspaceVisible,
  subscribeWorkspace,
  setChatWidth,
  getChatWidth,
  subscribeChatWidth,
  markUnread,
  markRead,
  getUnreadSet,
  subscribeUnread,
} from '../client/store.ts'

describe('client/store.ts', () => {
  describe('工作区可见性', () => {
    let cleanup: (() => void) | undefined

    afterEach(() => {
      cleanup?.()
      // 重置到初始状态
      setWorkspaceVisible(false)
    })

    it('setWorkspaceVisible(true) 后状态变为 true', () => {
      setWorkspaceVisible(false)
      expect(getWorkspaceVisible()).toBe(false)

      setWorkspaceVisible(true)
      expect(getWorkspaceVisible()).toBe(true)
    })

    it('setWorkspaceVisible 触发订阅者', () => {
      const listener = vi.fn()
      cleanup = subscribeWorkspace(listener)

      setWorkspaceVisible(false) // 初始状态
      listener.mockClear() // 清除初始设置的调用

      setWorkspaceVisible(true)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('setWorkspaceVisible 相同值不触发订阅者', () => {
      const listener = vi.fn()
      cleanup = subscribeWorkspace(listener)

      setWorkspaceVisible(true)
      listener.mockClear()

      setWorkspaceVisible(true) // 相同值
      expect(listener).not.toHaveBeenCalled()
    })

    it('toggleWorkspace 连续调两次回到原状态', () => {
      setWorkspaceVisible(false)
      const initial = getWorkspaceVisible()

      toggleWorkspace()
      const afterFirst = getWorkspaceVisible()
      expect(afterFirst).toBe(!initial)

      toggleWorkspace()
      const afterSecond = getWorkspaceVisible()
      expect(afterSecond).toBe(initial)
    })
  })

  describe('聊天宽度', () => {
    let cleanup: (() => void) | undefined

    beforeEach(() => {
      // 重置到默认值
      setChatWidth(460)
    })

    afterEach(() => {
      cleanup?.()
      setChatWidth(460)
    })

    it('setChatWidth 低于最小值被钳制到 300', () => {
      setChatWidth(100)
      expect(getChatWidth()).toBe(300)
    })

    it('setChatWidth 高于最大值被钳制到 760', () => {
      setChatWidth(9999)
      expect(getChatWidth()).toBe(760)
    })

    it('setChatWidth 正常值正常设置', () => {
      setChatWidth(500)
      expect(getChatWidth()).toBe(500)

      setChatWidth(300)
      expect(getChatWidth()).toBe(300)

      setChatWidth(760)
      expect(getChatWidth()).toBe(760)
    })

    it('setChatWidth 触发订阅者', () => {
      const listener = vi.fn()
      cleanup = subscribeChatWidth(listener)

      setChatWidth(500)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('setChatWidth 相同值不触发订阅者', () => {
      setChatWidth(500)
      const listener = vi.fn()
      cleanup = subscribeChatWidth(listener)

      setChatWidth(500) // 相同值
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('未读标记', () => {
    let cleanup: (() => void) | undefined

    afterEach(() => {
      cleanup?.()
      // 清理所有未读状态
      const unread = getUnreadSet()
      for (const sid of unread) {
        markRead(sid)
      }
    })

    it('markUnread 添加未读标记', () => {
      const sid = 'session-1'
      markUnread(sid)
      expect(getUnreadSet().has(sid)).toBe(true)
    })

    it('markRead 移除未读标记', () => {
      const sid = 'session-1'
      markUnread(sid)
      expect(getUnreadSet().has(sid)).toBe(true)

      markRead(sid)
      expect(getUnreadSet().has(sid)).toBe(false)
    })

    it('markUnread 幂等性：重复调用集合大小不变', () => {
      const sid = 'session-1'
      markUnread(sid)
      const size1 = getUnreadSet().size

      markUnread(sid)
      const size2 = getUnreadSet().size

      expect(size2).toBe(size1)
    })

    it('markRead 幂等性：对已读会话调用不报错', () => {
      const sid = 'session-1'
      // 确保是已读状态
      markRead(sid)

      // 再次调用不应该报错
      expect(() => markRead(sid)).not.toThrow()
    })

    it('markUnread 触发订阅者', () => {
      const listener = vi.fn()
      cleanup = subscribeUnread(listener)

      markUnread('session-1')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('markUnread 相同会话不重复触发订阅者', () => {
      const sid = 'session-1'
      markUnread(sid) // 先标记一次

      const listener = vi.fn()
      cleanup = subscribeUnread(listener)

      markUnread(sid) // 重复标记
      expect(listener).not.toHaveBeenCalled()
    })

    it('markRead 触发订阅者', () => {
      const sid = 'session-1'
      markUnread(sid)

      const listener = vi.fn()
      cleanup = subscribeUnread(listener)

      markRead(sid)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('多个会话的未读状态独立', () => {
      const sid1 = 'session-1'
      const sid2 = 'session-2'

      markUnread(sid1)
      markUnread(sid2)
      expect(getUnreadSet().has(sid1)).toBe(true)
      expect(getUnreadSet().has(sid2)).toBe(true)

      markRead(sid1)
      expect(getUnreadSet().has(sid1)).toBe(false)
      expect(getUnreadSet().has(sid2)).toBe(true)
    })
  })
})
