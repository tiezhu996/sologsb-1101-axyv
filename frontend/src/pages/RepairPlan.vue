<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Calendar, Delete, Edit, MagicStick, Plus, Sort, Timer } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import { useRepairStore } from '@/stores/repairStore'
import { useScheduleStore } from '@/stores/scheduleStore'
import { ScheduleConstraintError } from '@/stores/scheduleStore'
import type { RepairGroup } from '@/types/repair'
import { REPAIR_STATES, REPAIR_STEP_NAMES, type RepairState, type RepairStep, type RepairStepName } from '@/types/repair'
import type { ScheduleAllocation } from '@/types/schedule'
import { HALF_DAYS, HALF_DAY_LABEL, type HalfDay, type MaterialBatch } from '@/types/resource'
import { datePickerToKey, formatSlot, todayKey } from '@/utils/date'
import { formatArea } from '@/utils/severity'

const hallStore = useHallStore()
const decayStore = useDecayStore()
const repairStore = useRepairStore()
const scheduleStore = useScheduleStore()

const hallFilter = ref<string>('')
const stateFilter = ref<RepairState | ''>('')
const draggingId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

/** 工序材料与责任人的编辑草稿：工序 id → 字段值，失焦或回车时写回 IndexedDB */
const stepDrafts = reactive<Record<string, { material: string; operator: string }>>({})

function syncDrafts(list: RepairStep[]): void {
  const alive = new Set(list.map((step) => step.id))
  Object.keys(stepDrafts).forEach((id) => {
    if (!alive.has(id)) delete stepDrafts[id]
  })
  list.forEach((step) => {
    if (!stepDrafts[step.id]) {
      stepDrafts[step.id] = { material: step.material, operator: step.operator }
    }
  })
}

watch(() => repairStore.steps, syncDrafts, { immediate: true, deep: false })

function commitDraft(step: RepairStep, field: 'material' | 'operator'): void {
  const draft = stepDrafts[step.id]
  if (!draft) return
  const value = draft[field].trim()
  if (value === step[field]) return
  void repairStore.updateStep(step.id, { [field]: value } as Partial<RepairStep>)
}

const stepDialogVisible = ref(false)
const editingStepId = ref<string | null>(null)
const stepForm = reactive<{
  decayId: string
  name: RepairStepName
  material: string
  operator: string
  state: RepairState
}>({
  decayId: '',
  name: '除尘',
  material: '',
  operator: '',
  state: '未开始'
})

const scratchDialogVisible = ref(false)
const scratchHallId = ref<string>('')
const scratchTemplate = ref<RepairStepName[]>(['除尘', '回贴', '灌浆', '补绘', '封护'])

// --------------------------------------------------------------- 排班弹窗

type BatchMode = 'auto' | 'manual' | 'none'

const scheduleDialogVisible = ref(false)
const scheduling = ref(false)
const scheduleTarget = ref<RepairStep | null>(null)
/** 排班草稿：保存失败（事务回滚 / 写入异常）时弹窗与草稿都保留，可直接重试 */
const scheduleForm = reactive<{
  crewId: string
  startDate: string | Date
  preferredSlot: HalfDay | null
  batchMode: BatchMode
  batchId: string
  qty: number
}>({
  crewId: '',
  startDate: todayKey(),
  preferredSlot: 'AM',
  batchMode: 'auto',
  batchId: '',
  qty: 1
})

const groupScheduleVisible = ref(false)
const groupScheduling = ref(false)
const groupScheduleTarget = ref<RepairGroup | null>(null)
const groupForm = reactive<{ crewId: string; startDate: string | Date; preferredSlot: HalfDay | null }>({
  crewId: '',
  startDate: todayKey(),
  preferredSlot: 'AM'
})
/** 整组排班每道工序的材料用量草稿（null = 不占材料） */
const groupQtyDrafts = reactive<Record<string, number | null>>({})

const crewOptions = computed(() =>
  scheduleStore.crews
    .filter((crew) => !crew.archived)
    .map((crew) => ({ label: `${crew.name}（${crew.trade || '未分工种'}）`, value: crew.id }))
)

const matchingBatches = computed<MaterialBatch[]>(() => {
  const step = scheduleTarget.value
  if (!step || !step.material.trim()) return []
  return scheduleStore.batchesForMaterial(step.material)
})

function openSchedule(step: RepairStep): void {
  if (step.state === '已完成') {
    ElMessage.info('该工序已完成，施工记录保留，不能再改排')
    return
  }
  scheduleTarget.value = step
  const existing = scheduleStore.activeAllocationOf(step.id)
  scheduleForm.crewId = existing?.crewId ?? crewOptions.value[0]?.value ?? ''
  scheduleForm.startDate = existing?.date ?? todayKey()
  scheduleForm.preferredSlot = existing?.slot ?? 'AM'
  scheduleForm.qty = existing?.qty ?? 1
  if (existing?.batchId) {
    scheduleForm.batchMode = 'manual'
    scheduleForm.batchId = existing.batchId
  } else if (step.material.trim() && scheduleStore.batchesForMaterial(step.material).length > 0) {
    scheduleForm.batchMode = 'auto'
    scheduleForm.batchId = ''
  } else {
    scheduleForm.batchMode = step.material.trim() ? 'auto' : 'none'
    scheduleForm.batchId = ''
  }
  scheduleDialogVisible.value = true
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 提交排班：班组档期 + 材料容量的占位在同一个 Dexie 事务内完成。
 * 业务约束冲突（班组撞档 / 容量不足）直接提示，用户改草稿后重试；
 * 其它写入异常自动重试一次；无论哪种失败，事务回滚且草稿保留，不产生半截占用。
 */
async function submitSchedule(): Promise<void> {
  const step = scheduleTarget.value
  if (!step) return
  if (!scheduleForm.crewId) {
    ElMessage.warning('请选择施工班组')
    return
  }
  if (scheduleForm.batchMode === 'manual' && !scheduleForm.batchId) {
    ElMessage.warning('请选择材料批次，或改为自动匹配 / 不占材料')
    return
  }
  if (scheduling.value) return
  const input = {
    stepId: step.id,
    crewId: scheduleForm.crewId,
    startDate: datePickerToKey(scheduleForm.startDate),
    preferredSlot: scheduleForm.preferredSlot,
    batchId:
      scheduleForm.batchMode === 'none'
        ? null
        : scheduleForm.batchMode === 'auto'
          ? 'auto'
          : scheduleForm.batchId,
    qty: scheduleForm.qty
  }
  scheduling.value = true
  try {
    const result = await scheduleStore.scheduleStep(input)
    scheduleDialogVisible.value = false
    const batchText = result.batch ? `，占用批次「${result.batch.batchNo}」${result.allocation.qty}` : ''
    ElMessage.success(`已占位：${formatSlot(result.date, result.slot)}${batchText}`)
  } catch (err) {
    if (err instanceof ScheduleConstraintError) {
      ElMessage.error(err.message)
    } else {
      // 写入类异常（如浏览器事务中断）：短暂等待后自动重试一次，草稿依旧保留
      try {
        await wait(400)
        const result = await scheduleStore.scheduleStep(input)
        scheduleDialogVisible.value = false
        ElMessage.success(`重试成功，已占位：${formatSlot(result.date, result.slot)}`)
      } catch (retryErr) {
        ElMessage.error(
          `排班写入失败，已自动回滚未留下半截占用，可修改后重试：${
            retryErr instanceof Error ? retryErr.message : '未知错误'
          }`
        )
      }
    }
  } finally {
    scheduling.value = false
  }
}

async function cancelSchedule(step: RepairStep): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `取消「${step.name}」的排班？班组档期与材料容量会立即释放，记录保留为已作废。`,
    '取消排班',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await scheduleStore.cancelByStep(step.id)
  ElMessage.success('排班已作废并释放占用')
}

// --------------------------------------------------------------- 整组排班

function openGroupSchedule(group: RepairGroup): void {
  const pending = group.steps.filter((step) => {
    if (step.state === '已完成') return false
    return !scheduleStore.activeAllocationOf(step.id)
  })
  if (pending.length === 0) {
    ElMessage.info('该组未完成工序都已有排班；如需调整请逐道改排')
    return
  }
  groupScheduleTarget.value = group
  groupForm.crewId = crewOptions.value[0]?.value ?? ''
  groupForm.startDate = todayKey()
  groupForm.preferredSlot = 'AM'
  Object.keys(groupQtyDrafts).forEach((key) => delete groupQtyDrafts[key])
  pending.forEach((step) => {
    // 默认按工序材料名自动匹配批次，用量 1；材料为空的工序默认不占材料
    groupQtyDrafts[step.id] = step.material.trim() ? 1 : null
  })
  groupScheduleVisible.value = true
}

const groupDraftSteps = computed(() =>
  groupScheduleTarget.value
    ? groupScheduleTarget.value.steps.filter(
        (step) => step.state !== '已完成' && !scheduleStore.activeAllocationOf(step.id)
      )
    : []
)

async function submitGroupSchedule(): Promise<void> {
  const group = groupScheduleTarget.value
  if (!group) return
  if (!groupForm.crewId) {
    ElMessage.warning('请选择施工班组')
    return
  }
  if (groupScheduling.value) return
  const items = groupDraftSteps.value.map((step) => ({
    stepId: step.id,
    qty: groupQtyDrafts[step.id] ?? null
  }))
  groupScheduling.value = true
  try {
    const results = await scheduleStore.scheduleGroup({
      decayId: group.decayId,
      crewId: groupForm.crewId,
      startDate: datePickerToKey(groupForm.startDate),
      preferredSlot: groupForm.preferredSlot,
      items
    })
    groupScheduleVisible.value = false
    ElMessage.success(`已连续占位 ${results.length} 道工序，首道：${formatSlot(results[0].date, results[0].slot)}`)
  } catch (err) {
    if (err instanceof ScheduleConstraintError) {
      ElMessage.error(`${err.message}；本次整组排班已整体回滚，未留下半截占用`)
    } else {
      ElMessage.error(`整组排班写入失败，已回滚：${err instanceof Error ? err.message : '未知错误'}`)
    }
  } finally {
    groupScheduling.value = false
  }
}

// --------------------------------------------------------------- 回显

interface AllocationView {
  allocation: ScheduleAllocation
  label: string
  crewName: string
  batchText: string
  tone: 'success' | 'warning' | 'info' | 'danger'
  text: string
}

function allocationView(step: RepairStep): AllocationView | null {
  const allocation = scheduleStore.latestAllocationOf(step.id)
  if (!allocation) return null
  const crew = scheduleStore.crewById(allocation.crewId)
  const batch = allocation.batchId ? scheduleStore.batchById(allocation.batchId) : undefined
  if (allocation.state === 'done') {
    return {
      allocation,
      label: '已施工',
      tone: 'success',
      text: formatSlot(allocation.date, allocation.slot),
      crewName: crew?.name ?? '班组已删除',
      batchText: batch ? `${batch.materialName} · ${batch.batchNo} × ${allocation.qty}` : '不占材料'
    }
  }
  if (allocation.state === 'scheduled') {
    return {
      allocation,
      label: '已排班',
      tone: 'warning',
      text: formatSlot(allocation.date, allocation.slot),
      crewName: crew?.name ?? '班组已删除',
      batchText: batch ? `${batch.materialName} · ${batch.batchNo} × ${allocation.qty}` : '不占材料'
    }
  }
  return {
    allocation,
    label: '已作废',
    tone: 'info',
    text: allocation.voidReason ? `原排班已作废：${allocation.voidReason}` : '原排班已作废',
    crewName: '',
    batchText: ''
  }
}

const hallOptions = computed(() =>
  hallStore.halls.map((hall) => ({ label: `${hall.name}（${hall.era}）`, value: hall.id }))
)

const groups = computed<RepairGroup[]>(() =>
  repairStore.groups.filter((group) => {
    if (hallFilter.value && group.element?.hallId !== hallFilter.value) return false
    if (stateFilter.value && !group.steps.some((step) => step.state === stateFilter.value)) return false
    return true
  })
)

const visibleStepCount = computed(() => groups.value.reduce((sum, group) => sum + group.steps.length, 0))

const visibleDoneCount = computed(() => groups.value.reduce((sum, group) => sum + group.doneCount, 0))

const pendingDecays = computed(() =>
  repairStore.pendingDecays.filter((decay) => {
    if (!hallFilter.value) return true
    const layer = decayStore.layers.find((item) => item.id === decay.layerId)
    const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
    return element?.hallId === hallFilter.value
  })
)

watch(
  () => repairStore.activeDecayId,
  async (id) => {
    if (!id) return
    if (!hallFilter.value) {
      const layer = decayStore.layers.find((item) => item.id === repairStore.decayById(id)?.layerId)
      const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
      if (element) hallFilter.value = element.hallId
    }
    await nextTick()
    const anchor = document.getElementById(`group_${id}`)
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
)

function groupTitle(group: RepairGroup): string {
  const element = group.element
  const hall = repairStore.hallOfGroup(group)
  return `${hall?.name ?? '未知殿宇'} · ${element?.name ?? '构件已删除'} · ${group.decay?.type ?? '病害已删除'}`
}

function groupSubtitle(group: RepairGroup): string {
  const layer = group.layer
  const decay = group.decay
  if (!layer) return '层位已删除'
  const level = `第 ${layer.level} 层 ${layer.patternName}/${layer.pigment}`
  if (!decay) return level
  return `${level} · 病害 ${decay.type} · ${formatArea(decay.areaCm2)}`
}

function openStepDialog(decayId: string, step?: RepairStep): void {
  stepForm.decayId = decayId
  if (step) {
    editingStepId.value = step.id
    stepForm.name = step.name
    stepForm.material = step.material
    stepForm.operator = step.operator
    stepForm.state = step.state
  } else {
    editingStepId.value = null
    stepForm.name = '除尘'
    stepForm.material = ''
    stepForm.operator = ''
    stepForm.state = '未开始'
  }
  stepDialogVisible.value = true
}

async function submitStep(): Promise<void> {
  if (!stepForm.decayId) return
  if (editingStepId.value) {
    await repairStore.updateStep(editingStepId.value, {
      name: stepForm.name,
      material: stepForm.material.trim(),
      operator: stepForm.operator.trim(),
      state: stepForm.state
    })
    ElMessage.success('工序已更新')
  } else {
    await repairStore.addStep({
      decayId: stepForm.decayId,
      name: stepForm.name,
      material: stepForm.material.trim(),
      operator: stepForm.operator.trim(),
      state: stepForm.state
    })
    ElMessage.success('已追加修复工序')
  }
  stepDialogVisible.value = false
}

async function removeStep(step: RepairStep): Promise<void> {
  const confirmed = await ElMessageBox.confirm(`删除工序「${step.name}」？相关排班占用会一并释放或清理。`, '删除确认', {
    type: 'warning'
  }).catch(() => false)
  if (!confirmed) return
  await repairStore.removeStep(step.id)
  ElMessage.success('工序已删除')
}

async function removeGroup(group: RepairGroup): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `清空「${groupTitle(group)}」的全部 ${group.steps.length} 道工序？班组档期与材料占用会随之释放。`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await repairStore.removeGroup(group.decayId)
  ElMessage.success('该病害的工序已清空')
}

async function changeState(step: RepairStep, state: RepairState): Promise<void> {
  await repairStore.setStepState(step.id, state)
  const group = repairStore.groupOf(step.decayId)
  if (state === '已完成' && group && group.doneCount === group.totalCount) {
    ElMessage.success('该病害全部工序完成，病害已回写为「已修复」，排班保留为施工记录')
  } else {
    ElMessage.success(`工序状态已改为「${state}」`)
  }
}

function onDragStart(step: RepairStep): void {
  draggingId.value = step.id
}

function onDragOver(step: RepairStep, event: DragEvent): void {
  event.preventDefault()
  dragOverId.value = step.id
}

async function onDrop(group: RepairGroup, target: RepairStep): Promise<void> {
  const sourceId = draggingId.value
  draggingId.value = null
  dragOverId.value = null
  if (!sourceId || sourceId === target.id) return
  const ordered = group.steps.map((step) => step.id).filter((id) => id !== sourceId)
  const targetIndex = ordered.indexOf(target.id)
  ordered.splice(targetIndex, 0, sourceId)
  await repairStore.reorder(group.decayId, ordered)
  ElMessage.success('工序顺序已调整，受影响的未完成排班已作废并释放占用')
}

async function openScratch(): Promise<void> {
  scratchHallId.value = hallFilter.value || hallStore.halls[0]?.id || ''
  scratchDialogVisible.value = true
}

async function submitScratch(): Promise<void> {
  if (!scratchHallId.value) {
    ElMessage.warning('请选择殿宇')
    return
  }
  if (scratchTemplate.value.length === 0) {
    ElMessage.warning('请至少选择一道工序')
    return
  }
  const count = await repairStore.scaffoldForHall(scratchHallId.value, scratchTemplate.value)
  scratchDialogVisible.value = false
  if (count === 0) {
    ElMessage.info('该殿宇下没有待编排的病害（可能已存在工序）')
  } else {
    ElMessage.success(`已为待编排病害生成 ${count} 道工序，可逐道排班或整组连续排班`)
  }
}

function handleEmptyAction(): void {
  const first = pendingDecays.value[0]
  if (first) openStepDialog(first.id)
}

function batchRemaining(batchId: string): number {
  return scheduleStore.remainingQty(batchId)
}

const stepNameOptions = REPAIR_STEP_NAMES
const stateOptions = REPAIR_STATES
const halfDayOptions = HALF_DAYS
const halfDayLabel = HALF_DAY_LABEL
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>修复工序时间线</h2>
        <p>
          共 {{ repairStore.totalSteps }} 道工序，已完成 {{ repairStore.doneSteps }} 道，进行中
          {{ repairStore.runningSteps }} 道；当前筛选 {{ groups.length }} 组 / {{ visibleStepCount }} 道
        </p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="MagicStick" @click="openScratch">按殿宇批量生成工序</el-button>
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="pendingDecays.length === 0"
          @click="handleEmptyAction"
        >
          为待编排病害排工序
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge
        label="工序总数"
        :value="repairStore.totalSteps"
        suffix="道"
        icon="Files"
        tone="primary"
        :percent="repairStore.overallPercent"
      />
      <StatBadge label="已完成" :value="repairStore.doneSteps" suffix="道" icon="SuccessFilled" tone="success" />
      <StatBadge label="进行中" :value="repairStore.runningSteps" suffix="道" icon="Loading" tone="warning" />
      <StatBadge label="待编排病害" :value="pendingDecays.length" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge
        label="整体完成率"
        :value="repairStore.overallPercent"
        suffix="%"
        icon="TrendCharts"
        tone="success"
        show-percent
        :percent="repairStore.overallPercent"
      />
      <StatBadge
        label="本次筛选完成"
        :value="visibleDoneCount"
        suffix="道"
        icon="Histogram"
        :percent="visibleStepCount ? Math.round((visibleDoneCount / visibleStepCount) * 100) : 0"
      />
    </div>

    <div class="section-card toolbar">
      <span class="toolbar__label">殿宇</span>
      <el-select v-model="hallFilter" clearable placeholder="全部殿宇" class="toolbar__select">
        <el-option v-for="item in hallOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>

      <span class="toolbar__label">工序状态</span>
      <el-radio-group v-model="stateFilter" size="small">
        <el-radio-button value="">全部</el-radio-button>
        <el-radio-button v-for="item in stateOptions" :key="item" :value="item">{{ item }}</el-radio-button>
      </el-radio-group>

      <span class="toolbar__label">排序</span>
      <el-radio-group
        :model-value="repairStore.sortMode"
        size="small"
        @update:model-value="(value: string | number | boolean | undefined) => repairStore.setSortMode(value === 'severity' ? 'severity' : 'manual')"
      >
        <el-radio-button value="manual">手动顺序</el-radio-button>
        <el-radio-button value="severity">按病害程度</el-radio-button>
      </el-radio-group>

      <el-tag v-if="repairStore.totalSteps > 0" type="info" effect="plain" round>
        <el-icon><Sort /></el-icon>
        拖拽工序卡片可调整先后
      </el-tag>
    </div>

    <div v-if="pendingDecays.length > 0" class="section-card pending">
      <div class="section-card__head">
        <h3>待编排病害（{{ pendingDecays.length }}）</h3>
        <span class="muted">这些病害尚无任何修复工序</span>
      </div>
      <div class="pending__list">
        <el-tag
          v-for="decay in pendingDecays"
          :key="decay.id"
          closable
          :disable-transitions="true"
          type="warning"
          effect="plain"
          @close="openStepDialog(decay.id)"
        >
          {{ decay.type }} / {{ decay.severity }} / {{ formatArea(decay.areaCm2) }}
        </el-tag>
      </div>
      <p class="muted pending__hint">点击标签右侧「×」即可为该病害新增第一道工序。</p>
    </div>

    <div v-if="groups.length > 0" class="timeline">
      <article
        v-for="group in groups"
        :id="`group_${group.decayId}`"
        :key="group.decayId"
        class="timeline__group"
        :class="{ 'is-active': repairStore.activeDecayId === group.decayId }"
      >
        <header class="timeline__head">
          <div>
            <h3>{{ groupTitle(group) }}</h3>
            <p class="muted">{{ groupSubtitle(group) }}</p>
          </div>
          <div class="timeline__head-right">
            <SeverityTag v-if="group.decay" :severity="group.decay.severity" size="small" plain />
            <el-tag :type="group.percent === 100 ? 'success' : 'info'" effect="plain" round>
              {{ group.doneCount }}/{{ group.totalCount }}（{{ group.percent }}%）
            </el-tag>
            <el-button size="small" type="warning" plain :icon="Timer" @click="openGroupSchedule(group)">
              整组排班
            </el-button>
            <el-button size="small" type="danger" text :icon="Delete" @click="removeGroup(group)">清空</el-button>
          </div>
        </header>

        <el-progress :percentage="group.percent" :stroke-width="8" :show-text="false" class="timeline__progress" />

        <ol class="timeline__steps">
          <li
            v-for="(step, index) in group.steps"
            :key="step.id"
            class="step-card"
            :class="{
              'is-dragging': draggingId === step.id,
              'is-over': dragOverId === step.id && draggingId !== step.id,
              [`is-${step.state}`]: true
            }"
            draggable="true"
            @dragstart="onDragStart(step)"
            @dragover="onDragOver(step, $event)"
            @drop="onDrop(group, step)"
            @dragend="
              () => {
                draggingId = null
                dragOverId = null
              }
            "
          >
            <div class="step-card__seq">
              <el-icon><Sort /></el-icon>
              <span class="mono">{{ index + 1 }}</span>
            </div>
            <div class="step-card__body">
              <div class="step-card__title">
                <strong>{{ step.name }}</strong>
                <el-tag size="small" effect="plain" :type="step.state === '已完成' ? 'success' : step.state === '进行中' ? 'warning' : 'info'">
                  {{ step.state }}
                </el-tag>
              </div>
              <div class="step-card__schedule">
                <template v-if="allocationView(step)">
                  <el-tag
                    size="small"
                    :type="allocationView(step)!.tone"
                    effect="dark"
                    round
                    class="step-card__schedule-tag"
                  >
                    <el-icon><Calendar /></el-icon>
                    {{ allocationView(step)!.label }} · {{ allocationView(step)!.text }}
                  </el-tag>
                  <span v-if="allocationView(step)!.crewName" class="muted step-card__schedule-meta">
                    {{ allocationView(step)!.crewName }} · {{ allocationView(step)!.batchText }}
                  </span>
                </template>
                <span v-else class="muted step-card__schedule-unscheduled">
                  <el-icon><Calendar /></el-icon>
                  未排班
                </span>
              </div>
              <div class="step-card__fields">
                <el-input
                  v-model="stepDrafts[step.id].material"
                  size="small"
                  placeholder="材料 / 配比"
                  class="step-card__input"
                  @blur="commitDraft(step, 'material')"
                  @keyup.enter="commitDraft(step, 'material')"
                />
                <el-input
                  v-model="stepDrafts[step.id].operator"
                  size="small"
                  placeholder="责任人"
                  class="step-card__input"
                  @blur="commitDraft(step, 'operator')"
                  @keyup.enter="commitDraft(step, 'operator')"
                />
              </div>
            </div>
            <div class="step-card__actions">
              <el-select
                :model-value="step.state"
                size="small"
                class="step-card__state"
                @update:model-value="(value: RepairState) => changeState(step, value)"
              >
                <el-option v-for="item in stateOptions" :key="item" :label="item" :value="item" />
              </el-select>
              <el-button
                v-if="step.state !== '已完成'"
                size="small"
                type="warning"
                plain
                :icon="Calendar"
                @click="openSchedule(step)"
              >
                排班
              </el-button>
              <el-button size="small" text :icon="Edit" @click="openStepDialog(group.decayId, step)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeStep(step)">删除</el-button>
            </div>
          </li>
        </ol>

        <div class="timeline__add">
          <el-button size="small" :icon="Plus" @click="openStepDialog(group.decayId)">追加工序</el-button>
        </div>
      </article>
    </div>

    <div v-else class="section-card">
      <EmptyPanel
        :title="repairStore.totalSteps === 0 ? '尚未安排修复工序' : '当前筛选下没有工序'"
        :description="
          repairStore.totalSteps === 0
            ? '从待编排病害开始：为每条病害追加除尘、回贴、灌浆、补绘、封护等工序，并按施工顺序拖拽调整。'
            : '可切换殿宇或工序状态筛选条件。'
        "
        :action-text="pendingDecays.length > 0 ? '为待编排病害排工序' : ''"
        :secondary-text="repairStore.totalSteps > 0 ? '按殿宇批量生成工序' : ''"
        @action="handleEmptyAction"
        @secondary="openScratch"
      />
    </div>

    <el-dialog v-model="stepDialogVisible" :title="editingStepId ? '编辑工序' : '新增修复工序'" width="540px">
      <el-form :model="stepForm" label-width="110px">
        <el-form-item label="工序名称">
          <el-select v-model="stepForm.name" class="full-width">
            <el-option v-for="item in stepNameOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="材料 / 配比">
          <el-input v-model="stepForm.material" placeholder="如：鱼鳔胶（2% 明矾水调和）" maxlength="60" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="stepForm.operator" placeholder="如：李文博" maxlength="20" />
        </el-form-item>
        <el-form-item label="工序状态">
          <el-radio-group v-model="stepForm.state">
            <el-radio v-for="item in stateOptions" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="stepDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitStep">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="scratchDialogVisible" title="按殿宇批量生成工序" width="560px">
      <el-form label-width="110px">
        <el-form-item label="目标殿宇">
          <el-select v-model="scratchHallId" class="full-width" placeholder="选择殿宇">
            <el-option v-for="item in hallOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工序模板">
          <el-checkbox-group v-model="scratchTemplate">
            <el-checkbox v-for="item in stepNameOptions" :key="item" :value="item">
              {{ item }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <p class="muted">将为该殿宇下所有尚无工序的病害，按所选模板依次生成工序（状态均为未开始）。</p>
      <template #footer>
        <el-button @click="scratchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitScratch">生成工序</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="scheduleDialogVisible"
      :title="scheduleTarget ? `工序排班：${scheduleTarget.name}` : '工序排班'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="班组半天只接一道工序；材料容量不够或班组撞档时自动排队顺延，班组档期与材料批次两项都满足才占位。"
        class="schedule-alert"
      />
      <el-form label-width="110px">
        <el-form-item label="施工班组" required>
          <el-select v-model="scheduleForm.crewId" class="full-width" placeholder="选择班组">
            <el-option v-for="item in crewOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="crewOptions.length === 0" class="muted form-hint">
            尚无在用班组，请先到「班组与材料」页建档
          </span>
        </el-form-item>
        <el-form-item label="期望日期">
          <el-date-picker
            v-model="scheduleForm.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            class="full-width"
          />
        </el-form-item>
        <el-form-item label="半天偏好">
          <el-radio-group v-model="scheduleForm.preferredSlot">
            <el-radio :value="null">不限</el-radio>
            <el-radio v-for="item in halfDayOptions" :key="item" :value="item">{{ halfDayLabel[item] }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="材料占用">
          <el-radio-group v-model="scheduleForm.batchMode">
            <el-radio value="auto">按工序材料自动匹配最早批次</el-radio>
            <el-radio value="manual">指定批次</el-radio>
            <el-radio value="none">不占材料</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="scheduleForm.batchMode === 'manual'" label="材料批次" required>
          <el-select v-model="scheduleForm.batchId" class="full-width" placeholder="选择批次">
            <el-option
              v-for="batch in matchingBatches"
              :key="batch.id"
              :label="`${batch.batchNo}（${batch.arriveDate} 到货，剩 ${batchRemaining(batch.id)} / ${batch.capacityQty}）`"
              :value="batch.id"
            />
          </el-select>
          <span v-if="matchingBatches.length === 0" class="muted form-hint">
            没有与工序材料「{{ scheduleTarget?.material }}」同名的批次，可改自动匹配 / 不占材料，或先去建档
          </span>
        </el-form-item>
        <el-form-item v-if="scheduleForm.batchMode !== 'none'" label="本次用量">
          <el-input-number v-model="scheduleForm.qty" :min="1" :step="1" />
          <span class="muted form-hint">
            <template v-if="scheduleForm.batchMode === 'auto'">
              自动选择到货后剩余容量 ≥ 用量的最早批次
            </template>
            <template v-else-if="scheduleTarget">
              指定批次剩余 {{ scheduleForm.batchId ? batchRemaining(scheduleForm.batchId) : '—' }}
            </template>
          </span>
        </el-form-item>
      </el-form>
      <p class="muted schedule-foot">
        保存失败时本弹窗与填写内容会保留，可直接重试；事务自动回滚，不会留下半截档期或批次占用。
      </p>
      <template #footer>
        <el-button
          v-if="scheduleTarget && scheduleStore.latestAllocationOf(scheduleTarget.id)?.state === 'scheduled'"
          type="danger"
          plain
          @click="scheduleTarget && cancelSchedule(scheduleTarget)"
        >
          取消排班并释放
        </el-button>
        <el-button @click="scheduleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="scheduling" @click="submitSchedule">占位排班</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="groupScheduleVisible"
      :title="groupScheduleTarget ? `整组连续排班：${groupTitle(groupScheduleTarget)}` : '整组排班'"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="按工序顺序由同一班组连续占用半天；材料批次按各工序材料自动匹配，容量不够则该工序排队顺延。任一道排不下则整组回滚。"
        class="schedule-alert"
      />
      <el-form label-width="110px" class="group-form">
        <el-form-item label="施工班组" required>
          <el-select v-model="groupForm.crewId" class="full-width" placeholder="选择班组">
            <el-option v-for="item in crewOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="起始日期">
          <el-date-picker
            v-model="groupForm.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            class="full-width"
          />
        </el-form-item>
        <el-form-item label="起始半天">
          <el-radio-group v-model="groupForm.preferredSlot">
            <el-radio :value="null">不限</el-radio>
            <el-radio v-for="item in halfDayOptions" :key="item" :value="item">{{ halfDayLabel[item] }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <el-table :data="groupDraftSteps" size="small" max-height="260">
        <el-table-column label="序" width="50">
          <template #default="{ row }">
            <span class="mono">{{ row.seq }}</span>
          </template>
        </el-table-column>
        <el-table-column label="工序" prop="name" width="90" />
        <el-table-column label="材料（自动匹配同名批次）" prop="material" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.material">{{ row.material }}</span>
            <span v-else class="muted">未填材料</span>
          </template>
        </el-table-column>
        <el-table-column label="用量（空=不占材料）" width="190">
          <template #default="{ row }">
            <el-input-number
              v-model="groupQtyDrafts[row.id]"
              :min="1"
              :step="1"
              size="small"
              controls-position="right"
              placeholder="不占"
            />
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="groupScheduleVisible = false">取消</el-button>
        <el-button type="primary" :loading="groupScheduling" @click="submitGroupSchedule">整组占位</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title__actions {
  display: flex;
  gap: 8px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.toolbar__label {
  font-size: 13px;
  color: #6b6257;
}

.toolbar__select {
  width: 200px;
}

.pending__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pending__hint {
  margin: 10px 0 0;
  font-size: 12px;
}

.timeline {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}

.timeline__group {
  padding: 16px;
  background: #ffffff;
  border: 1px solid var(--line);
  border-left: 4px solid #b09a76;
  border-radius: 12px;
}

.timeline__group.is-active {
  border-left-color: #8a5a2b;
  box-shadow: 0 0 0 2px rgba(138, 90, 43, 0.16);
}

.timeline__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.timeline__head h3 {
  margin: 0;
  font-size: 16px;
}

.timeline__head p {
  margin: 2px 0 0;
  font-size: 12px;
}

.timeline__head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline__progress {
  margin: 10px 0 14px;
}

.timeline__steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-card {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  background: #fbf9f5;
  border: 1px dashed #ddd3c2;
  border-radius: 10px;
  cursor: grab;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.step-card.is-已完成 {
  border-color: #bfe0c9;
  background: #f4fbf6;
}

.step-card.is-进行中 {
  border-color: #f0d9ac;
  background: #fdf8ee;
}

.step-card.is-dragging {
  opacity: 0.5;
}

.step-card.is-over {
  border-color: #8a5a2b;
  box-shadow: 0 0 0 2px rgba(138, 90, 43, 0.18);
}

.step-card__seq {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 34px;
  color: #8a5a2b;
  font-weight: 700;
}

.step-card__body {
  flex: 1;
  min-width: 0;
}

.step-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.step-card__schedule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.step-card__schedule-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.step-card__schedule-meta {
  font-size: 12px;
}

.step-card__schedule-unscheduled {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.schedule-alert {
  margin-bottom: 14px;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.schedule-foot {
  margin: 4px 0 0;
  font-size: 12px;
}

.group-form {
  margin-top: 4px;
}

.step-card__fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.step-card__input {
  flex: 1 1 180px;
  min-width: 140px;
}

.step-card__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.step-card__state {
  width: 110px;
}

.timeline__add {
  margin-top: 12px;
}

.full-width {
  width: 100%;
}
</style>
