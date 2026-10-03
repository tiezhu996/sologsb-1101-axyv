/** 施工班组：同一班组同一半天只能承担一道工序 */
export interface Crew {
  id: string
  name: string
  /** 工种：油工 / 彩画 / 裱糊 / 搭材 等 */
  trade: string
  /** 负责人 / 联系方式备注 */
  contact: string
  /** 是否停用：停用后不参与新排班，但历史占用保留 */
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** 半个工作日，班组档期与材料容量都以半天为最小粒度 */
export type HalfDay = 'AM' | 'PM'
export const HALF_DAYS: HalfDay[] = ['AM', 'PM']
export const HALF_DAY_LABEL: Record<HalfDay, string> = {
  AM: '上午',
  PM: '下午'
}

/**
 * 材料批次：某材料在某日到货一批，容量固定，按工序用量占减。
 * 占用不直接写在批次上，而由 scheduleAllocations 台账实时汇总，
 * 因此不会出现「批次被重复占用 / 删除工序不释放」的问题。
 */
export interface MaterialBatch {
  id: string
  /** 材料名称，与工序 material 文本匹配（trim 后区分大小写） */
  materialName: string
  /** 批次编号：如 20261003-01 */
  batchNo: string
  /** 到货日期：yyyy-MM-dd，此前不可占用 */
  arriveDate: string
  /** 到货容量（与工序用量同单位，默认 ml / g，按材料自洽即可） */
  capacityQty: number
  note: string
  createdAt: number
  updatedAt: number
}
