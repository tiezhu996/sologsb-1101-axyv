/* eslint-disable no-console */
/**
 * 排班引擎冒烟脚本：fake-indexeddb 内存库中验证
 *  - 班组半天唯一、材料批次容量占减与排队顺延
 *  - 写入失败回滚不留半截占用
 *  - 程度 / 顺序 / 归属变化作废旧排班并释放，已完成记录保留
 * 运行：npx tsx scripts/smoke-schedule.ts
 */
import 'fake-indexeddb/auto'
import { setActivePinia, createPinia } from 'pinia'
import { db } from '../src/utils/db'
import { scheduleBus } from '../src/utils/scheduleBus'
import { useScheduleStore, ScheduleConstraintError } from '../src/stores/scheduleStore'
import { useRepairStore } from '../src/stores/repairStore'
import { useDecayStore } from '../src/stores/decayStore'
import { useHallStore } from '../src/stores/hallStore'
import type { RepairStep } from '../src/types/repair'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

async function flushLive(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

async function seed(): Promise<{
  stepA: RepairStep
  stepB: RepairStep
  stepC: RepairStep
  crewId: string
  smallBatchId: string
  decayId: string
  layerId: string
}> {
  setActivePinia(createPinia())
  const now = Date.now()
  const hallId = 'hall1'
  const elementId = 'elem1'
  const layerId = 'layer1'
  const decayId = 'decay1'
  const crewId = 'crew1'
  const smallBatchId = 'batch_glue'

  await db.halls.put({
    id: hallId, name: '测试殿', era: '现代', structureType: '大木', roofType: '庑殿',
    createdAt: now, updatedAt: now
  })
  await db.elements.put({
    id: elementId, hallId, position: '梁枋', name: '构件甲', layerCount: 1,
    baseLayer: '一麻五灰', status: '待修', createdAt: now, updatedAt: now
  })
  await db.layers.put({
    id: layerId, elementId, level: 1, patternName: '旋子', pigment: '石青',
    thicknessMm: 1, createdAt: now, updatedAt: now
  })
  await db.decays.put({
    id: decayId, layerId, type: '起甲', severity: '重度', areaCm2: 10, causeGuess: '',
    repaired: false, repairedAt: null, createdAt: now, updatedAt: now
  })
  await db.crews.put({
    id: crewId, name: '班组甲', trade: '油工', contact: '', archived: false,
    createdAt: now, updatedAt: now
  })
  await db.materialBatches.bulkPut([
    {
      id: smallBatchId, materialName: '鱼鳔胶', batchNo: 'G-001', arriveDate: '2026-10-01',
      capacityQty: 100, note: '', createdAt: now, updatedAt: now
    },
    {
      id: 'batch_water', materialName: '去离子水', batchNo: 'W-001', arriveDate: '2026-10-01',
      capacityQty: 1000, note: '', createdAt: now, updatedAt: now
    }
  ])
  const makeStep = (seq: number, id: string, material: string): RepairStep => ({
    id, decayId, seq, name: '回贴', material, operator: '张三',
    state: '未开始', createdAt: now, updatedAt: now
  })
  const stepA = makeStep(1, 'stepA', '鱼鳔胶')
  const stepB = makeStep(2, 'stepB', '鱼鳔胶')
  const stepC = makeStep(3, 'stepC', '鱼鳔胶')
  await db.repairSteps.bulkPut([stepA, stepB, stepC])
  return { stepA, stepB, stepC, crewId, smallBatchId, decayId, layerId }
}

async function main(): Promise<void> {
  const { stepA, stepB, stepC, crewId, smallBatchId, decayId, layerId } = await seed()
  const scheduleStore = useScheduleStore()
  const repairStore = useRepairStore()
  const decayStore = useDecayStore()
  void useHallStore()
  await flushLive()

  console.log('1) 单道排班：班组半天 + 材料容量同时满足才占位')
  const r1 = await scheduleStore.scheduleStep({
    stepId: stepA.id, crewId, startDate: '2026-10-08', preferredSlot: 'AM',
    batchId: smallBatchId, qty: 40
  })
  check('A 排在 10-08 上午', r1.date === '2026-10-08' && r1.slot === 'AM', `${r1.date} ${r1.slot}`)
  await flushLive()
  check('批次已占 40 / 剩 60', scheduleStore.remainingQty(smallBatchId) === 60)

  console.log('2) 同班组同半天第二道工序必须顺延到下一个半天')
  const r2 = await scheduleStore.scheduleStep({
    stepId: stepB.id, crewId, startDate: '2026-10-08', preferredSlot: 'AM',
    batchId: smallBatchId, qty: 40
  })
  check('B 顺延到 10-08 下午', r2.date === '2026-10-08' && r2.slot === 'PM', `${r2.date} ${r2.slot}`)
  await flushLive()
  check('批次累计已占 80 / 剩 20', scheduleStore.remainingQty(smallBatchId) === 20)

  console.log('3) 材料容量不够：指定批次无剩余半天概念，跨到新班组日仍容量不足 → 报错')
  let err: unknown = null
  try {
    await scheduleStore.scheduleStep({
      stepId: stepC.id, crewId, startDate: '2026-10-09', preferredSlot: 'AM',
      batchId: smallBatchId, qty: 30
    })
  } catch (e) {
    err = e
  }
  check('C 容量不足报约束错误且未写入', err instanceof ScheduleConstraintError)
  const cAlloc = await db.scheduleAllocations.where('stepId').equals(stepC.id).toArray()
  check('C 没有任何占位记录（无半截占用）', cAlloc.length === 0, `got ${cAlloc.length}`)
  check('班组 10-09 上午仍空闲', !scheduleStore.isCrewBusy(crewId, '2026-10-09', 'AM'))
  check('批次剩余仍为 20', scheduleStore.remainingQty(smallBatchId) === 20)

  console.log('4) 自动匹配：同材料无可用容量时报错；换用有容量材料可顺延')
  // 给 stepC 换成去离子水材料，自动匹配应成功并顺延到 10-09 上午
  await db.repairSteps.update(stepC.id, { material: '去离子水' })
  await flushLive()
  const r4 = await scheduleStore.scheduleStep({
    stepId: stepC.id, crewId, startDate: '2026-10-09', preferredSlot: 'AM',
    batchId: 'auto', qty: 50
  })
  check('C 自动匹配水批次并占位 10-09 上午', r4.date === '2026-10-09' && r4.batch?.id === 'batch_water')

  console.log('5) 改排：旧占位在同一事务释放（半天与容量），再占新位')
  const r5 = await scheduleStore.scheduleStep({
    stepId: stepA.id, crewId, startDate: '2026-10-10', preferredSlot: 'PM',
    batchId: smallBatchId, qty: 10
  })
  check('A 改排到 10-10 下午', r5.date === '2026-10-10' && r5.slot === 'PM')
  const aAllocs = await db.scheduleAllocations.where('stepId').equals(stepA.id).toArray()
  const aVoided = aAllocs.filter((x) => x.state === 'voided')
  const aActive = aAllocs.filter((x) => x.state === 'scheduled')
  check('A 旧占位已作废', aVoided.length === 1 && aActive.length === 1)
  // B 占 40 + A 新占 10 = 50
  check('胶批次现占用 50 / 剩 50', scheduleStore.remainingQty(smallBatchId) === 50)
  check('10-08 上午已随改排释放', !scheduleStore.isCrewBusy(crewId, '2026-10-08', 'AM'))

  console.log('6) 程度变化：未完成排班作废并释放；已完成（done）记录保留')
  // 先把 B 完成
  await repairStore.setStepState(stepB.id, '已完成')
  await flushLive()
  const bDone = (await db.scheduleAllocations.where('stepId').equals(stepB.id).toArray()).filter(
    (x) => x.state === 'done'
  )
  check('B 占位转为已施工', bDone.length === 1)
  // 病害程度 重度→中度，事件触发作废 A（scheduled）但 B（done）保留
  await decayStore.updateDecay(decayId, { severity: '中度' as never })
  await flushLive()
  const aLatest = scheduleStore.latestAllocationOf(stepA.id)
  const bLatest = scheduleStore.latestAllocationOf(stepB.id)
  check('A 未完成排班已作废并释放胶容量', aLatest?.state === 'voided' && aLatest.voidReason === '病害程度变化')
  check('B 已完成施工记录照旧保留', bLatest?.state === 'done')
  // 胶批次只剩 B 的 40 占用
  check('胶批次剩 60（A 的 10 已释放）', scheduleStore.remainingQty(smallBatchId) === 60)

  console.log('7) 工序顺序变化：拖拽后未完成排班作废')
  // 重新给 A 排班，然后对该病害 reorder（B、C 顺序变化）
  await scheduleStore.scheduleStep({
    stepId: stepA.id, crewId, startDate: '2026-10-12', preferredSlot: 'AM',
    batchId: smallBatchId, qty: 5
  })
  await repairStore.reorder(decayId, [stepB.id, stepA.id, stepC.id])
  await flushLive()
  const aAfterReorder = scheduleStore.latestAllocationOf(stepA.id)
  const cAfterReorder = scheduleStore.latestAllocationOf(stepC.id)
  check('A 排班因顺序变化作废', aAfterReorder?.state === 'voided' && aAfterReorder.voidReason === '工序顺序变化')
  check('C 排班同样作废', cAfterReorder?.state === 'voided')
  check('B 施工记录仍保留', scheduleStore.latestAllocationOf(stepB.id)?.state === 'done')

  console.log('8) 构件归属变化：层位改挂构件后未完成排班作废')
  // 新增构件乙，把层位改挂过去
  const now = Date.now()
  await db.elements.put({
    id: 'elem2', hallId: 'hall1', position: '室内', name: '构件乙', layerCount: 0,
    baseLayer: '单披灰', status: '待修', createdAt: now, updatedAt: now
  })
  const hallStore2 = useHallStore()
  await flushLive()
  // 先给 C 排班（有有效占位）
  await scheduleStore.scheduleStep({
    stepId: stepC.id, crewId, startDate: '2026-10-13', preferredSlot: 'AM',
    batchId: 'batch_water', qty: 10
  })
  await hallStore2.updateLayer(layerId, { elementId: 'elem2' })
  await flushLive()
  check(
    'C 排班因构件归属变化作废',
    scheduleStore.latestAllocationOf(stepC.id)?.state === 'voided' &&
      scheduleStore.latestAllocationOf(stepC.id)?.voidReason === '构件归属变化'
  )
  check('B 施工记录在归属变化后仍保留', scheduleStore.latestAllocationOf(stepB.id)?.state === 'done')

  console.log('9) 整组排班：同一事务内全部或全无，排队顺延半天')
  // 清空排班再来：把 A、C 的作废记录保留，只对新一组步骤验证顺延
  // 用同班组从 10-20 上午开始整组排（A 用胶批次 60，B 已完成跳过）
  // 先取消 B 的完成态以便纯顺延验证：直接重置 stepB 为未开始会导致 done 记录保留，
  // 因此改用新病害/新步骤做顺延验证
  await db.decays.put({
    id: 'decay2', layerId, type: '空鼓', severity: '轻度', areaCm2: 5, causeGuess: '',
    repaired: false, repairedAt: null, createdAt: now, updatedAt: now
  })
  const g1: RepairStep = {
    id: 'g1', decayId: 'decay2', seq: 1, name: '除尘', material: '去离子水', operator: '',
    state: '未开始', createdAt: now, updatedAt: now
  }
  const g2: RepairStep = {
    id: 'g2', decayId: 'decay2', seq: 2, name: '补绘', material: '', operator: '',
    state: '未开始', createdAt: now, updatedAt: now
  }
  await db.repairSteps.bulkPut([g1, g2])
  await flushLive()
  const groupResults = await scheduleStore.scheduleGroup({
    decayId: 'decay2', crewId, startDate: '2026-10-20', preferredSlot: 'AM',
    items: [
      { stepId: 'g1', qty: 5 },
      { stepId: 'g2', qty: null }
    ]
  })
  check('整组 2 道连续占位', groupResults.length === 2)
  check('g1 在 10-20 上午', groupResults[0].date === '2026-10-20' && groupResults[0].slot === 'AM')
  check('g2 顺延 10-20 下午', groupResults[1].date === '2026-10-20' && groupResults[1].slot === 'PM')
  check('g2 不占材料', groupResults[1].batch === null && groupResults[1].allocation.qty === 0)

  console.log('10) 整组排班中途容量不足 → 整体回滚，不留半截占用')
  await db.decays.put({
    id: 'decay3', layerId, type: '粉化', severity: '轻度', areaCm2: 5, causeGuess: '',
    repaired: false, repairedAt: null, createdAt: now, updatedAt: now
  })
  // 胶批次容量 100，当前 B(done) 占 40；两道各需 40：第一道可排，第二道必失败
  const h1: RepairStep = {
    id: 'h1', decayId: 'decay3', seq: 1, name: '回贴', material: '鱼鳔胶', operator: '',
    state: '未开始', createdAt: now, updatedAt: now
  }
  const h2: RepairStep = {
    id: 'h2', decayId: 'decay3', seq: 2, name: '回贴', material: '鱼鳔胶', operator: '',
    state: '未开始', createdAt: now, updatedAt: now
  }
  await db.repairSteps.bulkPut([h1, h2])
  await flushLive()
  let groupErr: unknown = null
  try {
    await scheduleStore.scheduleGroup({
      decayId: 'decay3', crewId, startDate: '2026-11-01', preferredSlot: 'AM',
      items: [
        { stepId: 'h1', qty: 40 },
        { stepId: 'h2', qty: 40 }
      ]
    })
  } catch (e) {
    groupErr = e
  }
  check('整组因容量不足整体失败', groupErr instanceof ScheduleConstraintError)
  const hAllocs = await db.scheduleAllocations
    .where('stepId')
    .anyOf(['h1', 'h2'])
    .toArray()
  check('h1/h2 均无占位（无半截占用）', hAllocs.length === 0, `got ${hAllocs.length}`)
  check('班组 11-01 仍空闲', !scheduleStore.isCrewBusy(crewId, '2026-11-01', 'AM'))

  console.log('11) 事件总线：未被任何 store 依赖时也可直接按病害作废')
  // decayStore 在 pinia 中已存在，severity 变化触发事件
  const beforeVoid = (await db.scheduleAllocations.where('stepId').equals('g1').toArray()).length
  await decayStore.updateDecay('decay2', { severity: '重度' as never })
  await flushLive()
  const g1State = scheduleStore.latestAllocationOf('g1')?.state
  check('g1 排班随程度变化作废', beforeVoid > 0 && g1State === 'voided')
  void scheduleBus

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
