import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { scheduleBus } from '@/utils/scheduleBus'
import { addDays, compareDateKey } from '@/utils/date'
import type { Crew, HalfDay, MaterialBatch } from '@/types/resource'
import {
  ALLOCATION_STATES,
  SCHEDULE_HORIZON_DAYS,
  type AllocationState,
  type ScheduleAllocation
} from '@/types/schedule'

/** 排班约束类错误：属于确定性业务冲突，不应盲目重试，需用户改草稿后再保存 */
export class ScheduleConstraintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleConstraintError'
  }
}

/** 单道工序排班入参 */
export interface ScheduleStepInput {
  stepId: string
  crewId: string
  /** 最早可排日期 yyyy-MM-dd */
  startDate: string
  /** 半天偏好：null 表示上下午均可 */
  preferredSlot: HalfDay | null
  /** 指定材料批次；'auto' 按工序材料名自动匹配最早可用批次；null 不占材料 */
  batchId: string | 'auto' | null
  qty: number
}

/** 一组工序连续排队排班的入参（同一班组、按 seq 顺延） */
export interface ScheduleGroupItem {
  stepId: string
  /** null 表示该工序不占材料，仅占班组半天 */
  qty: number | null
}

export interface ScheduleGroupInput {
  decayId: string
  crewId: string
  startDate: string
  preferredSlot: HalfDay | null
  items: ScheduleGroupItem[]
}

/** 排班成功后的落点回显 */
export interface PlacementResult {
  allocation: ScheduleAllocation
  date: string
  slot: HalfDay
  batch: MaterialBatch | null
}

interface OccupancyContext {
  /** 已占班组档期：crewId|date|slot */
  crewSlots: Set<string>
  /** 批次已占用数量（含本次事务内新占位，含已完成历史占用） */
  batchUsed: Map<string, number>
}

function crewSlotKey(crewId: string, date: string, slot: HalfDay): string {
  return `${crewId}|${date}|${slot}`
}

function isActive(state: AllocationState): boolean {
  return state === 'scheduled' || state === 'done'
}

/**
 * 排班 store：班组/材料批次台账、占用计算、排班引擎与作废联动。
 * 班组档期与材料容量的唯一事实来源是 scheduleAllocations 表，
 * 所有占位写入与旧占位释放都在同一个 Dexie 事务内完成。
 */
export const useScheduleStore = defineStore('schedule', () => {
  const crewsTable = useIdbTable<Crew>((database) => database.crews)
  const batchesTable = useIdbTable<MaterialBatch>((database) => database.materialBatches)
  const allocationsTable = useIdbTable<ScheduleAllocation>((database) => database.scheduleAllocations)

  const crews = computed<Crew[]>(() => crewsTable.rows.value)
  const batches = computed<MaterialBatch[]>(() => batchesTable.rows.value)
  const allocations = computed<ScheduleAllocation[]>(() => allocationsTable.rows.value)

  const activeAllocations = computed(() => allocations.value.filter((item) => isActive(item.state)))

  /** 每个批次的已占用数量：已作废的不占，已完成的施工记录照旧保留占用 */
  const batchUsedQty = computed<Map<string, number>>(() => {
    const map = new Map<string, number>()
    activeAllocations.value.forEach((item) => {
      if (!item.batchId) return
      map.set(item.batchId, (map.get(item.batchId) ?? 0) + item.qty)
    })
    return map
  })

  /** 已被占用的班组半天集合（含已完成的历史档期） */
  const occupiedCrewSlots = computed<Set<string>>(() => {
    const set = new Set<string>()
    activeAllocations.value.forEach((item) => set.add(crewSlotKey(item.crewId, item.date, item.slot)))
    return set
  })

  /** stepId → 最新一条占用（含已完成 / 已作废，用于时间线回显状态） */
  const allocationByStep = computed<Map<string, ScheduleAllocation>>(() => {
    const map = new Map<string, ScheduleAllocation>()
    const sorted = [...allocations.value].sort((a, b) => a.createdAt - b.createdAt)
    sorted.forEach((item) => map.set(item.stepId, item))
    return map
  })

  function crewById(id: string): Crew | undefined {
    return crews.value.find((crew) => crew.id === id)
  }

  function batchById(id: string): MaterialBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  function activeAllocationOf(stepId: string): ScheduleAllocation | undefined {
    return activeAllocations.value.find((item) => item.stepId === stepId)
  }

  function latestAllocationOf(stepId: string): ScheduleAllocation | undefined {
    return allocationByStep.value.get(stepId)
  }

  function remainingQty(batchId: string): number {
    const batch = batchById(batchId)
    if (!batch) return 0
    return Math.max(0, batch.capacityQty - (batchUsedQty.value.get(batchId) ?? 0))
  }

  /** 与工序材料名匹配的批次（trim 后区分大小写），按到货日期升序 */
  function batchesForMaterial(materialName: string): MaterialBatch[] {
    const key = materialName.trim()
    return batches.value
      .filter((batch) => batch.materialName.trim() === key)
      .sort((a, b) => compareDateKey(a.arriveDate, b.arriveDate) || a.createdAt - b.createdAt)
  }

  /** 该班组在某半天是否已有工序 */
  function isCrewBusy(crewId: string, date: string, slot: HalfDay): boolean {
    return occupiedCrewSlots.value.has(crewSlotKey(crewId, date, slot))
  }

  // ---------------------------------------------------------------- 资源维护

  async function createCrew(payload: Omit<Crew, 'id' | 'createdAt' | 'updatedAt'>): Promise<Crew> {
    return crewsTable.create(payload, 'crew')
  }

  async function updateCrew(id: string, patch: Partial<Crew>): Promise<void> {
    await crewsTable.update(id, patch)
  }

  async function removeCrew(id: string): Promise<void> {
    const active = activeAllocations.value.some((item) => item.crewId === id)
    if (active) {
      throw new ScheduleConstraintError('该班组仍有排班或施工记录，请先作废相关排班或改为停用')
    }
    await crewsTable.remove(id)
  }

  async function createBatch(payload: Omit<MaterialBatch, 'id' | 'createdAt' | 'updatedAt'>): Promise<MaterialBatch> {
    return batchesTable.create(payload, 'batch')
  }

  async function updateBatch(id: string, patch: Partial<MaterialBatch>): Promise<void> {
    await batchesTable.update(id, patch)
  }

  async function removeBatch(id: string): Promise<void> {
    const active = activeAllocations.value.some((item) => item.batchId === id)
    if (active) {
      throw new ScheduleConstraintError('该批次仍被排班占用（含已完成施工记录），不能删除')
    }
    await batchesTable.remove(id)
  }

  // ---------------------------------------------------------------- 排班引擎

  /** 优先使用偏好半天，其次另一个半天 */
  function slotOrder(preferred: HalfDay | null): HalfDay[] {
    if (preferred === 'AM') return ['AM', 'PM']
    if (preferred === 'PM') return ['PM', 'AM']
    return ['AM', 'PM']
  }

  /**
   * 在事务上下文内为一道工序寻找落点。
   * 逐天、逐半天搜索：班组半天空闲，且指定/自动匹配的材料批次已到货且容量足够；
   * 当天不满足就顺延下一天（排队），直到 horizon 仍无解才报错。
   */
  async function findPlacement(
    tx: {
      materialBatches: typeof db.materialBatches
      repairSteps: typeof db.repairSteps
      crews: typeof db.crews
    },
    step: { id: string; name: string; material: string; state: string },
    input: ScheduleStepInput,
    ctx: OccupancyContext
  ): Promise<{ date: string; slot: HalfDay; batch: MaterialBatch | null; qty: number }> {
    const crew = await tx.crews.get(input.crewId)
    if (!crew) throw new ScheduleConstraintError('所选班组不存在，请重新选择')
    if (crew.archived) throw new ScheduleConstraintError(`班组「${crew.name}」已停用，不能再排新工序`)
    if (step.state === '已完成') throw new ScheduleConstraintError('工序已完成，施工记录不可改排')

    const qty = Math.max(0, Number(input.qty) || 0)
    const useMaterial = input.batchId !== null
    if (useMaterial && qty <= 0) {
      throw new ScheduleConstraintError('占用材料时用量必须大于 0')
    }

    let explicitBatch: MaterialBatch | null = null
    let autoBatches: MaterialBatch[] = []
    if (input.batchId === 'auto') {
      const materialName = step.material.trim()
      if (!materialName) {
        throw new ScheduleConstraintError('该工序尚未填写材料，无法自动匹配批次；请指定批次或改为不占材料')
      }
      autoBatches = await tx.materialBatches
        .where('materialName')
        .equals(materialName)
        .toArray()
      autoBatches.sort(
        (a, b) => compareDateKey(a.arriveDate, b.arriveDate) || a.createdAt - b.createdAt
      )
      if (autoBatches.length === 0) {
        throw new ScheduleConstraintError(`没有找到材料「${materialName}」的批次，请先在班组与材料页建档`)
      }
    } else if (input.batchId) {
      const found = await tx.materialBatches.get(input.batchId)
      if (!found) throw new ScheduleConstraintError('所选材料批次不存在，请重新选择')
      explicitBatch = found
    }

    if (explicitBatch && qty > explicitBatch.capacityQty) {
      throw new ScheduleConstraintError(
        `用量 ${qty} 超过批次「${explicitBatch.batchNo}」总容量 ${explicitBatch.capacityQty}，无法排班`
      )
    }

    const earliestArrive = explicitBatch
      ? explicitBatch.arriveDate
      : autoBatches.length > 0
        ? autoBatches[0].arriveDate
        : input.startDate
    const firstCursor =
      compareDateKey(input.startDate, earliestArrive) < 0 ? earliestArrive : input.startDate

    for (let offset = 0; offset <= SCHEDULE_HORIZON_DAYS; offset += 1) {
      const date = offset === 0 ? firstCursor : addDays(firstCursor, offset)
      for (const slot of slotOrder(input.preferredSlot)) {
        if (ctx.crewSlots.has(crewSlotKey(input.crewId, date, slot))) continue

        if (explicitBatch) {
          // 指定批次：到货日之前不能排；当天剩余容量不足则排队顺延
          if (compareDateKey(date, explicitBatch.arriveDate) < 0) continue
          const used = ctx.batchUsed.get(explicitBatch.id) ?? 0
          if (explicitBatch.capacityQty - used < qty) continue
          return { date, slot, batch: explicitBatch, qty }
        }
        if (autoBatches.length > 0) {
          const arrived = autoBatches.filter((batch) => compareDateKey(date, batch.arriveDate) >= 0)
          const fit = arrived.find((batch) => {
            const used = ctx.batchUsed.get(batch.id) ?? 0
            return batch.capacityQty - used >= qty
          })
          // 当天已到货批次容量都不够：排队顺延到后续到货批次 / 后续日期
          if (!fit) continue
          return { date, slot, batch: fit, qty }
        }
        return { date, slot, batch: null, qty: 0 }
      }
    }

    if (explicitBatch) {
      const used = ctx.batchUsed.get(explicitBatch.id) ?? 0
      throw new ScheduleConstraintError(
        `班组「${crew.name}」在可排期内没有空闲半天，或批次「${explicitBatch.batchNo}」剩余容量不足（剩 ${Math.max(
          0,
          explicitBatch.capacityQty - used
        )}，需 ${qty}），已顺延至 ${SCHEDULE_HORIZON_DAYS} 天后仍无档期`
      )
    }
    throw new ScheduleConstraintError(
      `班组「${crew.name}」未来 ${SCHEDULE_HORIZON_DAYS} 天内没有可用半天档期`
    )
  }

  /** 构建事务开始时的占用快照（已作废的排班不占任何资源） */
  async function buildOccupancy(tx: { scheduleAllocations: typeof db.scheduleAllocations }): Promise<OccupancyContext> {
    const rows = await tx.scheduleAllocations.toArray()
    const ctx: OccupancyContext = { crewSlots: new Set(), batchUsed: new Map() }
    rows.filter((row) => isActive(row.state)).forEach((row) => {
      ctx.crewSlots.add(crewSlotKey(row.crewId, row.date, row.slot))
      if (row.batchId) ctx.batchUsed.set(row.batchId, (ctx.batchUsed.get(row.batchId) ?? 0) + row.qty)
    })
    return ctx
  }

  /** 事务内作废旧占位（仅未完成的；已完成的施工记录保留） */
  function applyVoid(ctx: OccupancyContext, allocation: ScheduleAllocation): void {
    ctx.crewSlots.delete(crewSlotKey(allocation.crewId, allocation.date, allocation.slot))
    if (allocation.batchId) {
      const used = (ctx.batchUsed.get(allocation.batchId) ?? 0) - allocation.qty
      if (used <= 0) ctx.batchUsed.delete(allocation.batchId)
      else ctx.batchUsed.set(allocation.batchId, used)
    }
  }

  function applyOccupy(
    ctx: OccupancyContext,
    crewId: string,
    date: string,
    slot: HalfDay,
    batchId: string | null,
    qty: number
  ): void {
    ctx.crewSlots.add(crewSlotKey(crewId, date, slot))
    if (batchId) ctx.batchUsed.set(batchId, (ctx.batchUsed.get(batchId) ?? 0) + qty)
  }

  /**
   * 单道工序排班：作旧占位（如有）+ 新占位在同一事务内完成，失败整体回滚。
   */
  async function scheduleStep(input: ScheduleStepInput): Promise<PlacementResult> {
    let result: PlacementResult | null = null
    await db.transaction(
      'rw',
      [db.scheduleAllocations, db.materialBatches, db.repairSteps, db.crews],
      async (tx) => {
        const step = await tx.repairSteps.get(input.stepId)
        if (!step) throw new ScheduleConstraintError('工序不存在或已被删除')
        const ctx = await buildOccupancy(tx)

        // 改排：先在同一事务内释放该工序未完成的旧占位，已完成的记录不可改排
        const existing = await tx.scheduleAllocations.where('stepId').equals(input.stepId).toArray()
        const activeOld = existing.filter((row) => isActive(row.state))
        const now0 = Date.now()
        for (const old of activeOld) {
          if (old.state === 'done') throw new ScheduleConstraintError('工序已完成，施工记录不可改排')
          applyVoid(ctx, old)
          await tx.scheduleAllocations.update(old.id, {
            state: 'voided',
            voidReason: '手工改排',
            voidedAt: now0,
            updatedAt: now0
          })
        }

        const found = await findPlacement(tx, step, input, ctx)
        applyOccupy(ctx, input.crewId, found.date, found.slot, found.batch?.id ?? null, found.qty)

        const now = Date.now()
        const allocation: ScheduleAllocation = {
          id: `alloc_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          stepId: step.id,
          decayId: step.decayId,
          crewId: input.crewId,
          date: found.date,
          slot: found.slot,
          batchId: found.batch?.id ?? null,
          qty: found.qty,
          state: 'scheduled',
          voidReason: null,
          voidedAt: null,
          createdAt: now,
          updatedAt: now
        }
        await tx.scheduleAllocations.put(allocation)
        result = { allocation, date: found.date, slot: found.slot, batch: found.batch }
      }
    )
    return result as unknown as PlacementResult
  }

  /**
   * 整组连续排队排班：按 seq 顺延，全部落点在同一事务内确定，
   * 任一工序找不到档期/容量则整体失败，不会留下半截占用。
   * 已有未完成占位的工序默认跳过（不动既有排班）。
   */
  async function scheduleGroup(input: ScheduleGroupInput): Promise<PlacementResult[]> {
    const results: PlacementResult[] = []
    await db.transaction(
      'rw',
      [db.scheduleAllocations, db.materialBatches, db.repairSteps, db.crews],
      async (tx) => {
        const crew = await tx.crews.get(input.crewId)
        if (!crew) throw new ScheduleConstraintError('所选班组不存在，请重新选择')
        if (crew.archived) throw new ScheduleConstraintError(`班组「${crew.name}」已停用，不能再排新工序`)

        const steps = (await tx.repairSteps.where('decayId').equals(input.decayId).toArray())
          .filter((step) => step.state !== '已完成')
          .sort((a, b) => a.seq - b.seq)

        const selected = new Map(input.items.map((item) => [item.stepId, item.qty]))
        const targets = steps.filter((step) => selected.has(step.id))
        if (targets.length === 0) throw new ScheduleConstraintError('没有需要排班的未完成工序')

        const ctx = await buildOccupancy(tx)
        // 从起始日期的偏好半天开始，每排掉一道就顺延到下一个半天
        let cursor = input.startDate
        let carrySlot: HalfDay | null = input.preferredSlot

        for (const step of targets) {
          // 已存在未完成占位的工序跳过，避免重复占位
          const existing = await tx.scheduleAllocations.where('stepId').equals(step.id).toArray()
          if (existing.some((row) => isActive(row.state))) continue

          const qtyInput = selected.get(step.id) ?? null
          const found = await findPlacement(
            tx,
            step,
            {
              stepId: step.id,
              crewId: input.crewId,
              startDate: cursor,
              preferredSlot: carrySlot,
              batchId: qtyInput === null ? null : 'auto',
              qty: qtyInput ?? 0
            },
            ctx
          )
          applyOccupy(ctx, input.crewId, found.date, found.slot, found.batch?.id ?? null, found.qty)
          const now = Date.now()
          const allocation: ScheduleAllocation = {
            id: `alloc_${now.toString(36)}_${step.seq}_${Math.random().toString(36).slice(2, 8)}`,
            stepId: step.id,
            decayId: step.decayId,
            crewId: input.crewId,
            date: found.date,
            slot: found.slot,
            batchId: found.batch?.id ?? null,
            qty: found.qty,
            state: 'scheduled',
            voidReason: null,
            voidedAt: null,
            createdAt: now,
            updatedAt: now
          }
          await tx.scheduleAllocations.put(allocation)
          results.push({ allocation, date: found.date, slot: found.slot, batch: found.batch })

          // 上午排完顺延当天下午，下午排完顺延次日上午
          if (found.slot === 'AM') {
            cursor = found.date
            carrySlot = 'PM'
          } else {
            cursor = addDays(found.date, 1)
            carrySlot = 'AM'
          }
        }

        if (results.length === 0) {
          throw new ScheduleConstraintError('所选工序都已有排班，未产生新的占位')
        }
      }
    )
    return results
  }

  /** 手工取消排班：释放班组档期与材料容量，保留台账记录并登记原因 */
  async function cancelByStep(stepId: string, reason = '手工取消'): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', db.scheduleAllocations, async () => {
      const rows = await db.scheduleAllocations.where('stepId').equals(stepId).toArray()
      for (const row of rows) {
        if (row.state !== 'scheduled') continue
        await db.scheduleAllocations.update(row.id, {
          state: 'voided',
          voidReason: reason,
          voidedAt: now,
          updatedAt: now
        })
      }
    })
  }

  /**
   * 工序完成态联动：未完成 → 已完成时占位转为「已施工」（照旧保留资源记录）；
   * 由已完成改回进行中 / 未开始时恢复为「已排班」，继续占用档期容量。
   */
  async function syncStepState(stepId: string, state: string): Promise<void> {
    const now = Date.now()
    const next: AllocationState = state === '已完成' ? 'done' : 'scheduled'
    await db.transaction('rw', db.scheduleAllocations, async () => {
      const rows = await db.scheduleAllocations.where('stepId').equals(stepId).toArray()
      for (const row of rows) {
        if (!isActive(row.state)) continue
        if (row.state === next) continue
        await db.scheduleAllocations.update(row.id, { state: next, updatedAt: now })
      }
    })
  }

  // ---------------------------------------------------------------- 作废联动

  /**
   * 作废核心：把给定工序（或病害）下「未完成」的排班标记 voided 并释放占用；
   * 已完成（done）的施工记录永远保留。返回作废条数。
   */
  async function invalidateByStepIds(stepIds: string[], reason: string): Promise<number> {
    if (stepIds.length === 0) return 0
    const now = Date.now()
    return db.transaction('rw', db.scheduleAllocations, async () => {
      const rows = await db.scheduleAllocations.where('stepId').anyOf(stepIds).toArray()
      let count = 0
      for (const row of rows) {
        if (row.state !== 'scheduled') continue
        await db.scheduleAllocations.update(row.id, {
          state: 'voided',
          voidReason: reason,
          voidedAt: now,
          updatedAt: now
        })
        count += 1
      }
      return count
    })
  }

  async function invalidateByDecayIds(decayIds: string[], reason: string): Promise<number> {
    if (decayIds.length === 0) return 0
    const now = Date.now()
    return db.transaction('rw', [db.scheduleAllocations, db.repairSteps], async (tx) => {
      const steps = await tx.repairSteps.where('decayId').anyOf(decayIds).toArray()
      const ids = steps.map((step) => step.id)
      if (ids.length === 0) return 0
      const rows = await tx.scheduleAllocations.where('stepId').anyOf(ids).toArray()
      let count = 0
      for (const row of rows) {
        if (row.state !== 'scheduled') continue
        await tx.scheduleAllocations.update(row.id, {
          state: 'voided',
          voidReason: reason,
          voidedAt: now,
          updatedAt: now
        })
        count += 1
      }
      return count
    })
  }

  /** 构件归属变化：按层位直接查库找到病害再作废未完成排班（不依赖其它 store 已载入） */
  async function invalidateByLayerIds(layerIds: string[], reason: string): Promise<number> {
    if (layerIds.length === 0) return 0
    const decays = await db.decays.where('layerId').anyOf(layerIds).toArray()
    return invalidateByDecayIds(
      decays.map((decay) => decay.id),
      reason
    )
  }

  // 订阅跨 store 变化事件（store 只初始化一次，无需额外防重）
  scheduleBus.on('decay:severity-changed', ({ decayIds }) => {
    void invalidateByDecayIds(decayIds, '病害程度变化')
  })
  scheduleBus.on('layer:reassigned', ({ layerIds }) => {
    void invalidateByLayerIds(layerIds, '构件归属变化')
  })
  scheduleBus.on('steps:reordered', ({ decayIds }) => {
    void invalidateByDecayIds(decayIds, '工序顺序变化')
  })

  return {
    ALLOCATION_STATES,
    crews,
    batches,
    allocations,
    activeAllocations,
    batchUsedQty,
    occupiedCrewSlots,
    crewById,
    batchById,
    activeAllocationOf,
    latestAllocationOf,
    remainingQty,
    batchesForMaterial,
    isCrewBusy,
    createCrew,
    updateCrew,
    removeCrew,
    createBatch,
    updateBatch,
    removeBatch,
    scheduleStep,
    scheduleGroup,
    cancelByStep,
    syncStepState,
    invalidateByStepIds,
    invalidateByDecayIds,
    invalidateByLayerIds
  }
})
