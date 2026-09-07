import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { PortLogError } from './errors.ts'

export function validateLocalAddress(value: string): string {
  const address = value.trim()
  if (isIP(address) === 0) throw new PortLogError('ADDRESS_INVALID', '监听地址必须是 IPv4 或 IPv6 地址')
  return address
}

export function validateTarget(value: string): string {
  const target = value.trim()
  if (target.length === 0 || target.length > 253) throw new PortLogError('ADDRESS_INVALID', '目标地址无效')
  if (isIP(target) !== 0) return target
  const labels = target.split('.')
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) {
    throw new PortLogError('ADDRESS_INVALID', '目标地址无效')
  }
  return target.toLowerCase()
}

export function validatePort(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new PortLogError('VALIDATION', `${field} 必须是 1–65535 的整数`)
  }
  return Number(value)
}

export function localAddresses(interfaces = networkInterfaces()): string[] {
  const values = new Set<string>(['0.0.0.0', '::'])
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) values.add(entry.address)
  }
  return [...values].sort((left, right) => {
    const fixed = (value: string): number => value === '0.0.0.0' ? 0 : value === '::' ? 1 : 2
    return fixed(left) - fixed(right) || left.localeCompare(right)
  })
}
