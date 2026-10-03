import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbmuralarch') errors.push('app 字段应为 gbmuralarch，文件来源不明')
  const collections: Array<
    keyof Pick<
      BackupPayload,
      'halls' | 'elements' | 'layers' | 'decays' | 'repairSteps' | 'crews' | 'materialBatches'
    >
  > = ['halls', 'elements', 'layers', 'decays', 'repairSteps', 'crews', 'materialBatches']
  for (const key of collections) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbmuralarch',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    halls: obj.halls ?? [],
    elements: obj.elements ?? [],
    layers: obj.layers ?? [],
    decays: obj.decays ?? [],
    repairSteps: obj.repairSteps ?? [],
    // v3 以前的备份没有班组 / 批次 / 排班台账，按空集合兼容导入
    crews: obj.crews ?? [],
    materialBatches: obj.materialBatches ?? [],
    scheduleAllocations: Array.isArray(obj.scheduleAllocations) ? obj.scheduleAllocations : []
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的备份对象 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [halls, elements, layers, decays, repairSteps, crews, materialBatches, scheduleAllocations] =
    await Promise.all([
      db.halls.toArray(),
      db.elements.toArray(),
      db.layers.toArray(),
      db.decays.toArray(),
      db.repairSteps.toArray(),
      db.crews.toArray(),
      db.materialBatches.toArray(),
      db.scheduleAllocations.toArray()
    ])
  return {
    app: 'gbmuralarch',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    crews,
    materialBatches,
    scheduleAllocations
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const payload = await buildBackupPayload()
  const fileName = `gbmuralarch-backup-v${payload.dbVersion}-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      halls: payload.halls.length,
      elements: payload.elements.length,
      layers: payload.layers.length,
      decays: payload.decays.length,
      repairSteps: payload.repairSteps.length,
      crews: payload.crews.length,
      materialBatches: payload.materialBatches.length,
      scheduleAllocations: payload.scheduleAllocations.length
    }
  }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.halls,
      db.elements,
      db.layers,
      db.decays,
      db.repairSteps,
      db.crews,
      db.materialBatches,
      db.scheduleAllocations
    ],
    async () => {
      await db.halls.bulkPut(payload.halls)
      await db.elements.bulkPut(payload.elements)
      await db.layers.bulkPut(payload.layers)
      await db.decays.bulkPut(payload.decays)
      await db.repairSteps.bulkPut(payload.repairSteps)
      await db.crews.bulkPut(payload.crews)
      await db.materialBatches.bulkPut(payload.materialBatches)
      await db.scheduleAllocations.bulkPut(payload.scheduleAllocations)
    }
  )
  return {
    halls: payload.halls.length,
    elements: payload.elements.length,
    layers: payload.layers.length,
    decays: payload.decays.length,
    repairSteps: payload.repairSteps.length,
    crews: payload.crews.length,
    materialBatches: payload.materialBatches.length,
    scheduleAllocations: payload.scheduleAllocations.length
  }
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()
  const crewIdMap = new Map<string, string>()
  const batchIdMap = new Map<string, string>()

  const halls = payload.halls.map((hall) => {
    const id = createId('hall')
    hallIdMap.set(hall.id, id)
    return { ...hall, id }
  })
  const elements = payload.elements.map((element) => {
    const id = createId('elem')
    elementIdMap.set(element.id, id)
    return { ...element, id, hallId: hallIdMap.get(element.hallId) ?? element.hallId }
  })
  const layers = payload.layers.map((layer) => {
    const id = createId('lay')
    layerIdMap.set(layer.id, id)
    return { ...layer, id, elementId: elementIdMap.get(layer.elementId) ?? layer.elementId }
  })
  const decays = payload.decays.map((decay) => {
    const id = createId('dec')
    decayIdMap.set(decay.id, id)
    return { ...decay, id, layerId: layerIdMap.get(decay.layerId) ?? decay.layerId }
  })
  const crews = payload.crews.map((crew) => {
    const id = createId('crew')
    crewIdMap.set(crew.id, id)
    return { ...crew, id }
  })
  const materialBatches = payload.materialBatches.map((batch) => {
    const id = createId('batch')
    batchIdMap.set(batch.id, id)
    return { ...batch, id }
  })
  const repairSteps = payload.repairSteps.map((step) => ({
    ...step,
    id: createId('step'),
    decayId: decayIdMap.get(step.decayId) ?? step.decayId
  }))
  // 旧备份（v3 前）没有排班台账；有则随班组 / 批次 / 工序一起重映射
  const oldStepIdByNew = new Map(
    payload.repairSteps.map((step, index) => [step.id, repairSteps[index].id])
  )
  const scheduleAllocations = payload.scheduleAllocations.map((allocation) => ({
    ...allocation,
    id: createId('alloc'),
    stepId: oldStepIdByNew.get(allocation.stepId) ?? createId('step'),
    decayId: decayIdMap.get(allocation.decayId) ?? allocation.decayId,
    crewId: crewIdMap.get(allocation.crewId) ?? allocation.crewId,
    batchId: allocation.batchId ? batchIdMap.get(allocation.batchId) ?? allocation.batchId : null
  }))
  return {
    ...payload,
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    crews,
    materialBatches,
    scheduleAllocations
  }
}

/** 生成演示样例数据，便于首次打开即可看到完整链路 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const hallId = createId('hall')
  const elementIds = [createId('elem'), createId('elem')]
  const layerIds = elementIds.map(() => createId('lay'))
  const decayIds = layerIds.map(() => createId('dec'))
  const crewId = createId('crew')
  const batchIdGlue = createId('batch')
  const batchIdWater = createId('batch')

  const dateA = '2026-10-08'
  const dateB = '2026-10-08'
  const stepIdClean = createId('step')
  const stepIdGlue = createId('step')

  await db.transaction(
    'rw',
    [
      db.halls,
      db.elements,
      db.layers,
      db.decays,
      db.repairSteps,
      db.crews,
      db.materialBatches,
      db.scheduleAllocations
    ],
    async () => {
      await db.halls.put({
        id: hallId,
        name: '大雄宝殿',
        era: '明嘉靖',
        structureType: '大木',
        roofType: '庑殿',
        createdAt: now,
        updatedAt: now
      })
      await db.elements.bulkPut([
        {
          id: elementIds[0],
          hallId,
          position: '檐下',
          name: '前檐明间额枋',
          layerCount: 2,
          baseLayer: '一麻五灰',
          status: '待修',
          createdAt: now,
          updatedAt: now
        },
        {
          id: elementIds[1],
          hallId,
          position: '梁枋',
          name: '七架梁',
          layerCount: 1,
          baseLayer: '单披灰',
          status: '观察',
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.layers.bulkPut([
        {
          id: layerIds[0],
          elementId: elementIds[0],
          level: 1,
          patternName: '旋子',
          pigment: '石青',
          thicknessMm: 1.8,
          createdAt: now,
          updatedAt: now
        },
        {
          id: layerIds[1],
          elementId: elementIds[1],
          level: 1,
          patternName: '苏式',
          pigment: '土黄',
          thicknessMm: 1.2,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.decays.bulkPut([
        {
          id: decayIds[0],
          layerId: layerIds[0],
          type: '起甲',
          severity: '重度',
          areaCm2: 320.5,
          causeGuess: '地仗层脱胶，受檐口渗水影响',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        },
        {
          id: decayIds[1],
          layerId: layerIds[1],
          type: '龟裂',
          severity: '中度',
          areaCm2: 158,
          causeGuess: '木构件干缩引起画面开裂',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.crews.bulkPut([
        {
          id: crewId,
          name: '油工一组',
          trade: '油工彩画',
          contact: '李文博 / 13800000001',
          archived: false,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.materialBatches.bulkPut([
        {
          id: batchIdWater,
          materialName: '软毛刷 + 去离子水',
          batchNo: 'WATER-20261001',
          arriveDate: '2026-10-01',
          capacityQty: 1000,
          note: '除尘用，按 ml 计',
          createdAt: now,
          updatedAt: now
        },
        {
          id: batchIdGlue,
          materialName: '鱼鳔胶（2% 明矾水调和）',
          batchNo: 'GLUE-20261005',
          arriveDate: '2026-10-05',
          capacityQty: 300,
          note: '回贴用，按 g 计',
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.repairSteps.bulkPut([
        {
          id: stepIdClean,
          decayId: decayIds[0],
          seq: 1,
          name: '除尘',
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成',
          createdAt: now,
          updatedAt: now
        },
        {
          id: stepIdGlue,
          decayId: decayIds[0],
          seq: 2,
          name: '回贴',
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中',
          createdAt: now,
          updatedAt: now
        }
      ])
      // 除尘已完成：占位为 done，档期与容量保留为施工记录
      await db.scheduleAllocations.put({
        id: createId('alloc'),
        stepId: stepIdClean,
        decayId: decayIds[0],
        crewId,
        date: dateA,
        slot: 'AM',
        batchId: batchIdWater,
        qty: 120,
        state: 'done',
        voidReason: null,
        voidedAt: null,
        createdAt: now,
        updatedAt: now
      })
      // 回贴待施工：占用同一天下午与鱼鳔胶批次容量
      await db.scheduleAllocations.put({
        id: createId('alloc'),
        stepId: stepIdGlue,
        decayId: decayIds[0],
        crewId,
        date: dateB,
        slot: 'PM',
        batchId: batchIdGlue,
        qty: 80,
        state: 'scheduled',
        voidReason: null,
        voidedAt: null,
        createdAt: now,
        updatedAt: now
      })
    }
  )
}
