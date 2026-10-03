import type { HalfDay } from './resource'

/**
 * 排班占用：一道工序成功排班后生成的台账记录。
 * 班组档期（crewId + date + slot）与材料批次（batchId + qty）
 * 的占用都以本表为唯一事实来源，排班写入在同一个 Dexie 事务内完成，
 * 失败整体回滚，不会留下半截占用。
 */
export type AllocationState = 'scheduled' | 'done' | 'voided'

export interface ScheduleAllocation {
  id: string
  stepId: string
  /** 冗余 decayId，便于按病害级联查询与作废 */
  decayId: string
  crewId: string
  /** 排班日期 yyyy-MM-dd */
  date: string
  slot: HalfDay
  /** 占用的材料批次；工序无材料时为 null，仅占班组档期 */
  batchId: string | null
  /** 占用材料数量，batchId 为 null 时为 0 */
  qty: number
  state: AllocationState
  /** 作废原因：病害程度变化 / 工序顺序变化 / 构件归属变化 / 手工取消 / 级联删除 */
  voidReason: string | null
  /** 作废时间，用于界面排序与审计 */
  voidedAt: number | null
  createdAt: number
  updatedAt: number
}

export const ALLOCATION_STATES: AllocationState[] = ['scheduled', 'done', 'voided']
export const ALLOCATION_STATE_LABEL: Record<AllocationState, string> = {
  scheduled: '已排班',
  done: '已施工',
  voided: '已作废'
}

/** 排班引擎向前搜索可用档期的最大天数（约两年） */
export const SCHEDULE_HORIZON_DAYS = 730
