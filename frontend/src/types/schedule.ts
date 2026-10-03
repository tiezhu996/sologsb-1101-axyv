/** 半天档位：同一班组每个半天只承接一道工序 */
export type HalfDay = '上午' | '下午'

/** 排班记录状态：作废后释放占用，记录本身保留备查 */
export type ScheduleState = '有效' | '已作废'

/** 施工班组 */
export interface Crew {
  id: string
  name: string
  /** 擅长工序 / 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 材料批次：容量按「每半天可供应的工序道数」计量 */
export interface MaterialBatch {
  id: string
  /** 材料名称，如 鱼鳔胶 */
  material: string
  /** 批次编号 */
  batchNo: string
  /** 供应能力：每半天可承接的工序道数 */
  capacity: number
  createdAt: number
  updatedAt: number
}

/** 排班记录：一道工序占用某班组一个半天档期，并消耗材料批次当日供应 */
export interface Schedule {
  id: string
  stepId: string
  /** 施工日期 YYYY-MM-DD */
  date: string
  half: HalfDay
  crewId: string
  batchId: string
  /** 本次占用批次的道数 */
  amount: number
  state: ScheduleState
  /** 作废原因：病害程度变化 / 工序顺序变化 / 构件归属变化 / 重新排班 / 手动取消 */
  voidReason: string
  createdAt: number
  updatedAt: number
}

export const HALF_DAYS: HalfDay[] = ['上午', '下午']
export const SCHEDULE_STATES: ScheduleState[] = ['有效', '已作废']
