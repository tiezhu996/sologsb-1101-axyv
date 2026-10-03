import type { HalfDay, Schedule } from '@/types/schedule'

/** 半天槽位：日期 + 上午/下午 */
export interface ScheduleSlot {
  date: string
  half: HalfDay
}

/** 本地日期 → YYYY-MM-DD */
export function toDateStr(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayStr(): string {
  return toDateStr(new Date())
}

/** 下一个半天：上午 → 当天下午，下午 → 次日上午 */
export function nextSlot(date: string, half: HalfDay): ScheduleSlot {
  if (half === '上午') return { date, half: '下午' }
  const day = new Date(`${date}T00:00:00`)
  day.setDate(day.getDate() + 1)
  return { date: toDateStr(day), half: '上午' }
}

export interface SlotRequest extends ScheduleSlot {
  crewId: string
  batchId: string
  amount: number
}

export interface SlotHit {
  slot: ScheduleSlot
  /** 相对请求的槽位顺延了几个半天（0 表示按原槽位占位） */
  deferredSlots: number
}

/** 顺延扫描上限：180 天 × 2 个半天，避免容量永远不够时死循环 */
const MAX_SCAN_SLOTS = 360

/**
 * 从请求的半天起逐个槽位向后扫描，返回第一个同时满足两条约束的槽位：
 * 1. 同一班组同一半天最多承接一道工序；
 * 2. 同一材料批次同一半天的已占道数 + 本次道数 ≤ 批次容量。
 * 任一不满足即排队顺延到下一个半天；两项都满足才占位。
 */
export function findSlot(active: Schedule[], batchCapacity: number, request: SlotRequest): SlotHit | null {
  const crewBusy = new Set(active.map((item) => `${item.crewId}|${item.date}|${item.half}`))
  const batchUsed = new Map<string, number>()
  active.forEach((item) => {
    const key = `${item.batchId}|${item.date}|${item.half}`
    batchUsed.set(key, (batchUsed.get(key) ?? 0) + item.amount)
  })
  let slot: ScheduleSlot = { date: request.date, half: request.half }
  for (let scanned = 0; scanned < MAX_SCAN_SLOTS; scanned += 1) {
    const crewFree = !crewBusy.has(`${request.crewId}|${slot.date}|${slot.half}`)
    const batchFree = (batchUsed.get(`${request.batchId}|${slot.date}|${slot.half}`) ?? 0) + request.amount <= batchCapacity
    if (crewFree && batchFree) return { slot, deferredSlots: scanned }
    slot = nextSlot(slot.date, slot.half)
  }
  return null
}
