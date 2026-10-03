import type { HalfDay } from '@/types/resource'

/** 把 Date / 时间戳格式化为排班用日期键 yyyy-MM-dd（本地时区） */
export function toDateKey(input: Date | number): string {
  const date = input instanceof Date ? input : new Date(input)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 今天的日期键 */
export function todayKey(): string {
  return toDateKey(Date.now())
}

/** 解析 yyyy-MM-dd 为本地零点 Date；非法输入返回今天 */
export function parseDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim())
  if (!match) return new Date()
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? new Date() : date
}

/** 在某日期键上加 days 天 */
export function addDays(key: string, days: number): string {
  const date = parseDateKey(key)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

/** 日期键比较：a < b 返回负数 */
export function compareDateKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 中文回显：2026-10-03 上午 */
export function formatSlot(date: string, slot: HalfDay): string {
  const parsed = parseDateKey(date)
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${slot === 'AM' ? '上午' : '下午'}`
}

/** el-date-picker 值（Date 或字符串）统一转日期键 */
export function datePickerToKey(value: Date | string | null | undefined): string {
  if (!value) return todayKey()
  if (value instanceof Date) return toDateKey(value)
  return toDateKey(parseDateKey(value))
}
