import { defineStore } from 'pinia'
import { computed } from 'vue'
import { createId, db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { Crew, HalfDay, MaterialBatch, Schedule } from '@/types/schedule'
import { findSlot } from '@/utils/schedule'

/** 业务规则不满足（班组/批次缺失、容量永远不够等）：自动重试无意义，直接交回界面保留草稿 */
export class ScheduleRuleError extends Error {}

/** 瞬时写入失败（如 IndexedDB 事务冲突）自动重试次数 */
const MAX_WRITE_ATTEMPTS = 3

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ScheduleRuleError) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('排班写入本地存储失败')
}

export interface ScheduleInput {
  stepId: string
  date: string
  half: HalfDay
  crewId: string
  batchId: string
  amount: number
}

export interface ScheduleResult {
  schedule: Schedule
  /** 实际槽位相对请求槽位顺延了几个半天（0 表示按原槽位占位） */
  deferredSlots: number
}

/**
 * 排班 store：维护班组、材料批次与排班记录。
 * 占用约束（同班组半天一道工序、批次按道/半天限量）全部在写入事务内复核，
 * 不依赖其它 store，便于病害 / 工序 / 殿宇各 store 单向调用作废逻辑。
 */
export const useScheduleStore = defineStore('schedule', () => {
  const crewsTable = useIdbTable<Crew>((database) => database.crews)
  const batchesTable = useIdbTable<MaterialBatch>((database) => database.materialBatches)
  const schedulesTable = useIdbTable<Schedule>((database) => database.schedules, { sortByUpdatedAt: false })

  const crews = computed<Crew[]>(() => crewsTable.rows.value)
  const batches = computed<MaterialBatch[]>(() => batchesTable.rows.value)
  const schedules = computed<Schedule[]>(() => schedulesTable.rows.value)

  /** 有效排班（已作废的仅留档，不再占用档期与容量） */
  const activeSchedules = computed<Schedule[]>(() => schedules.value.filter((item) => item.state === '有效'))

  /** 工序 id → 当前有效排班，工序卡片直接消费；没有记录即「未排班」 */
  const activeByStep = computed<Record<string, Schedule>>(() => {
    const map: Record<string, Schedule> = {}
    activeSchedules.value.forEach((item) => {
      map[item.stepId] = item
    })
    return map
  })

  const voidedSchedules = computed<Schedule[]>(() =>
    schedules.value
      .filter((item) => item.state === '已作废')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  function crewById(id: string): Crew | null {
    return crews.value.find((item) => item.id === id) ?? null
  }

  function batchById(id: string): MaterialBatch | null {
    return batches.value.find((item) => item.id === id) ?? null
  }

  async function addCrew(payload: { name: string; note: string }): Promise<Crew> {
    return crewsTable.create({ name: payload.name, note: payload.note }, 'crew')
  }

  async function addBatch(payload: { material: string; batchNo: string; capacity: number }): Promise<MaterialBatch> {
    return batchesTable.create(
      { material: payload.material, batchNo: payload.batchNo, capacity: Math.max(1, Math.floor(payload.capacity)) },
      'batch'
    )
  }

  /** 删除班组：仍有有效排班占用档期时拒绝，避免留下悬空占用 */
  async function removeCrew(id: string): Promise<void> {
    if (activeSchedules.value.some((item) => item.crewId === id)) {
      throw new ScheduleRuleError('该班组仍有有效排班，请先取消或改期后再删除')
    }
    await crewsTable.remove(id)
  }

  /** 删除批次：仍有有效排班消耗容量时拒绝 */
  async function removeBatch(id: string): Promise<void> {
    if (activeSchedules.value.some((item) => item.batchId === id)) {
      throw new ScheduleRuleError('该批次仍有有效排班占用容量，请先取消或改期后再删除')
    }
    await batchesTable.remove(id)
  }

  /**
   * 为工序排班：在单个事务内复核占用、作废旧排班、写入新排班，
   * 要么整体成功要么整体回滚，不会留下半截占用；瞬时失败自动重试。
   */
  async function scheduleStep(input: ScheduleInput): Promise<ScheduleResult> {
    return withRetry(async () => {
      let outcome: ScheduleResult | null = null
      await db.transaction('rw', [db.schedules, db.repairSteps, db.crews, db.materialBatches], async () => {
        const step = await db.repairSteps.get(input.stepId)
        if (!step) throw new ScheduleRuleError('工序不存在，可能已被删除')
        if (step.state === '已完成') throw new ScheduleRuleError('已完成的工序不再排班，施工记录保持原样')
        const crew = await db.crews.get(input.crewId)
        if (!crew) throw new ScheduleRuleError('班组不存在，请先在「排班资源」页登记')
        const batch = await db.materialBatches.get(input.batchId)
        if (!batch) throw new ScheduleRuleError('材料批次不存在，请先在「排班资源」页登记')
        const amount = Math.max(1, Math.floor(input.amount))
        if (amount > batch.capacity) {
          throw new ScheduleRuleError(
            `批次「${batch.material} #${batch.batchNo}」每半天最多供应 ${batch.capacity} 道，无法承接 ${amount} 道`
          )
        }
        const active = await db.schedules.where('state').equals('有效').toArray()
        const others = active.filter((item) => item.stepId !== input.stepId)
        const hit = findSlot(others, batch.capacity, {
          date: input.date,
          half: input.half,
          crewId: input.crewId,
          batchId: input.batchId,
          amount
        })
        if (!hit) throw new ScheduleRuleError('未来 180 天内没有可同时满足班组档期与材料容量的半天')
        const now = Date.now()
        // 改期：同事务内作废旧排班（释放原占用）再写入新排班
        const stale = active.filter((item) => item.stepId === input.stepId)
        for (const old of stale) {
          await db.schedules.update(old.id, { state: '已作废', voidReason: '重新排班', updatedAt: now })
        }
        const record: Schedule = {
          id: createId('sch'),
          stepId: input.stepId,
          date: hit.slot.date,
          half: hit.slot.half,
          crewId: input.crewId,
          batchId: input.batchId,
          amount,
          state: '有效',
          voidReason: '',
          createdAt: now,
          updatedAt: now
        }
        await db.schedules.put(record)
        outcome = { schedule: record, deferredSlots: hit.deferredSlots }
      })
      if (!outcome) throw new Error('排班写入本地存储失败')
      return outcome
    })
  }

  /** 手动取消某工序的排班：作废并释放占用 */
  async function unscheduleStep(stepId: string): Promise<void> {
    const now = Date.now()
    await db.schedules
      .where('stepId')
      .equals(stepId)
      .modify((schedule) => {
        if (schedule.state !== '有效') return
        schedule.state = '已作废'
        schedule.voidReason = '手动取消'
        schedule.updatedAt = now
      })
  }

  /**
   * 病害程度 / 工序顺序 / 构件归属变化后调用：
   * 作废这些病害下「未完成」工序的有效排班并释放占用；
   * 已完成工序的排班即施工记录，原样保留。
   */
  async function voidForDecays(decayIds: string[], reason: string): Promise<number> {
    if (decayIds.length === 0) return 0
    let count = 0
    await db.transaction('rw', [db.schedules, db.repairSteps], async () => {
      const steps = await db.repairSteps.where('decayId').anyOf(decayIds).toArray()
      const unfinishedIds = steps.filter((step) => step.state !== '已完成').map((step) => step.id)
      if (unfinishedIds.length === 0) return
      const now = Date.now()
      await db.schedules
        .where('stepId')
        .anyOf(unfinishedIds)
        .modify((schedule) => {
          if (schedule.state !== '有效') return
          schedule.state = '已作废'
          schedule.voidReason = reason
          schedule.updatedAt = now
          count += 1
        })
    })
    return count
  }

  return {
    crews,
    batches,
    schedules,
    activeSchedules,
    activeByStep,
    voidedSchedules,
    crewById,
    batchById,
    addCrew,
    addBatch,
    removeCrew,
    removeBatch,
    scheduleStep,
    unscheduleStep,
    voidForDecays
  }
})
