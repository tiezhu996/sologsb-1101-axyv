<script setup lang="ts">
import { computed, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import { useRepairStore } from '@/stores/repairStore'
import { useScheduleStore } from '@/stores/scheduleStore'
import type { HalfDay, Schedule } from '@/types/schedule'
import { nextSlot, todayStr } from '@/utils/schedule'

const hallStore = useHallStore()
const decayStore = useDecayStore()
const repairStore = useRepairStore()
const scheduleStore = useScheduleStore()

const crewForm = reactive({ name: '', note: '' })
const batchForm = reactive({ material: '', batchNo: '', capacity: 1 })

/** 未来 7 天 × 上/下午 的半天槽位序列 */
const boardSlots = computed<Array<{ date: string; half: HalfDay }>>(() => {
  const slots: Array<{ date: string; half: HalfDay }> = []
  let cursor = { date: todayStr(), half: '上午' as HalfDay }
  for (let index = 0; index < 14; index += 1) {
    slots.push(cursor)
    cursor = nextSlot(cursor.date, cursor.half)
  }
  return slots
})

/** 班组档期表行：一行一个半天，每列一个班组 */
const crewBoardRows = computed(() =>
  boardSlots.value.map((slot) => {
    const cells: Record<string, Schedule[]> = {}
    scheduleStore.crews.forEach((crew) => {
      cells[crew.id] = scheduleStore.activeSchedules.filter(
        (item) => item.crewId === crew.id && item.date === slot.date && item.half === slot.half
      )
    })
    return { key: `${slot.date}|${slot.half}`, date: slot.date, half: slot.half, cells }
  })
)

/** 批次占用表行：一行一个半天，每列一个批次，格内为 已占/容量 */
const batchBoardRows = computed(() =>
  boardSlots.value.map((slot) => {
    const cells: Record<string, { used: number; capacity: number }> = {}
    scheduleStore.batches.forEach((batch) => {
      const used = scheduleStore.activeSchedules
        .filter((item) => item.batchId === batch.id && item.date === slot.date && item.half === slot.half)
        .reduce((sum, item) => sum + item.amount, 0)
      cells[batch.id] = { used, capacity: batch.capacity }
    })
    return { key: `${slot.date}|${slot.half}`, date: slot.date, half: slot.half, cells }
  })
)

const futureActiveCount = computed(
  () => scheduleStore.activeSchedules.filter((item) => item.date >= todayStr()).length
)

const recentVoided = computed(() => scheduleStore.voidedSchedules.slice(0, 20))

/** 工序定位文案：殿宇 · 构件 · 工序名，便于核对班组是否被排进两个殿宇 */
function stepLabel(stepId: string): string {
  const step = repairStore.steps.find((item) => item.id === stepId)
  if (!step) return '工序已删除'
  const decay = decayStore.decays.find((item) => item.id === step.decayId)
  const layer = decay ? decayStore.layers.find((item) => item.id === decay.layerId) : undefined
  const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
  const hall = element ? hallStore.hallById(element.hallId) : undefined
  return `${hall?.name ?? '未知殿宇'} · ${element?.name ?? '未知构件'} · ${step.name}`
}

function crewName(id: string): string {
  return scheduleStore.crewById(id)?.name ?? '班组已删除'
}

function batchName(id: string): string {
  const batch = scheduleStore.batchById(id)
  return batch ? `${batch.material} #${batch.batchNo}` : '批次已删除'
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function submitCrew(): Promise<void> {
  const name = crewForm.name.trim()
  if (!name) {
    ElMessage.warning('请填写班组名称')
    return
  }
  await scheduleStore.addCrew({ name, note: crewForm.note.trim() })
  crewForm.name = ''
  crewForm.note = ''
  ElMessage.success('班组已登记')
}

async function submitBatch(): Promise<void> {
  const material = batchForm.material.trim()
  const batchNo = batchForm.batchNo.trim()
  if (!material || !batchNo) {
    ElMessage.warning('请填写材料名称与批次号')
    return
  }
  await scheduleStore.addBatch({ material, batchNo, capacity: batchForm.capacity })
  batchForm.material = ''
  batchForm.batchNo = ''
  batchForm.capacity = 1
  ElMessage.success('材料批次已登记')
}

async function removeCrew(id: string, name: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm(`删除班组「${name}」？`, '删除确认', { type: 'warning' }).catch(
    () => false
  )
  if (!confirmed) return
  try {
    await scheduleStore.removeCrew(id)
    ElMessage.success('班组已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '删除失败')
  }
}

async function removeBatch(id: string, label: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm(`删除材料批次「${label}」？`, '删除确认', { type: 'warning' }).catch(
    () => false
  )
  if (!confirmed) return
  try {
    await scheduleStore.removeBatch(id)
    ElMessage.success('材料批次已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '删除失败')
  }
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>排班资源</h2>
        <p>
          共 {{ scheduleStore.crews.length }} 个班组、{{ scheduleStore.batches.length }} 个材料批次；有效排班
          {{ scheduleStore.activeSchedules.length }} 条，其中未来 {{ futureActiveCount }} 条
        </p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="施工班组" :value="scheduleStore.crews.length" suffix="个" icon="UserFilled" tone="primary" />
      <StatBadge label="材料批次" :value="scheduleStore.batches.length" suffix="个" icon="Box" tone="info" />
      <StatBadge label="有效排班" :value="scheduleStore.activeSchedules.length" suffix="条" icon="Calendar" tone="success" />
      <StatBadge label="未来 7 天占用" :value="futureActiveCount" suffix="个半天" icon="AlarmClock" tone="warning" />
      <StatBadge label="已作废记录" :value="scheduleStore.voidedSchedules.length" suffix="条" icon="DocumentDelete" />
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>施工班组</h3>
        <span class="muted">同一班组每个半天只承接一道工序</span>
      </div>
      <el-table v-if="scheduleStore.crews.length > 0" :data="scheduleStore.crews" size="small">
        <el-table-column label="班组名称" prop="name" min-width="140" />
        <el-table-column label="擅长工序 / 备注" prop="note" min-width="180">
          <template #default="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
        <el-table-column label="未来占用" width="110">
          <template #default="{ row }">
            <span class="mono">
              {{ scheduleStore.activeSchedules.filter((item) => item.crewId === row.id && item.date >= todayStr()).length }}
              个半天
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCrew(row.id, row.name)" />
          </template>
        </el-table-column>
      </el-table>
      <EmptyPanel
        v-else
        compact
        title="尚未登记班组"
        description="登记施工班组后，修复工序才能按半天档期排班。"
      />
      <div class="inline-form">
        <el-input v-model="crewForm.name" placeholder="班组名称，如：李文博组" maxlength="20" class="inline-form__name" />
        <el-input v-model="crewForm.note" placeholder="擅长工序 / 备注（可选）" maxlength="30" class="inline-form__note" />
        <el-button type="primary" :icon="Plus" @click="submitCrew">登记班组</el-button>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>材料批次</h3>
        <span class="muted">容量按「每半天可供应的工序道数」计量，占用超量时排班自动顺延</span>
      </div>
      <el-table v-if="scheduleStore.batches.length > 0" :data="scheduleStore.batches" size="small">
        <el-table-column label="材料名称" prop="material" min-width="140" />
        <el-table-column label="批次号" prop="batchNo" min-width="120" />
        <el-table-column label="供应能力" width="130">
          <template #default="{ row }">
            <span class="mono">{{ row.capacity }} 道/半天</span>
          </template>
        </el-table-column>
        <el-table-column label="未来占用" width="110">
          <template #default="{ row }">
            <span class="mono">
              {{ scheduleStore.activeSchedules.filter((item) => item.batchId === row.id && item.date >= todayStr()).length }}
              个半天
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="danger"
              :icon="Delete"
              @click="removeBatch(row.id, `${row.material} #${row.batchNo}`)"
            />
          </template>
        </el-table-column>
      </el-table>
      <EmptyPanel
        v-else
        compact
        title="尚未登记材料批次"
        description="登记批次及其每半天供应能力后，排班才会校验材料容量。"
      />
      <div class="inline-form">
        <el-input v-model="batchForm.material" placeholder="材料名称，如：鱼鳔胶" maxlength="20" class="inline-form__name" />
        <el-input v-model="batchForm.batchNo" placeholder="批次号，如：A-01" maxlength="20" class="inline-form__batch" />
        <el-input-number v-model="batchForm.capacity" :min="1" :max="99" class="inline-form__capacity" />
        <el-button type="primary" :icon="Plus" @click="submitBatch">登记批次</el-button>
      </div>
    </div>

    <div v-if="scheduleStore.crews.length > 0" class="section-card">
      <div class="section-card__head">
        <h3>班组档期（未来 7 天）</h3>
        <span class="muted">每格即一个班组的半天档期，最多一道工序</span>
      </div>
      <el-table :data="crewBoardRows" size="small" border>
        <el-table-column label="日期" width="120">
          <template #default="{ row }">{{ row.date }}</template>
        </el-table-column>
        <el-table-column label="半天" width="70">
          <template #default="{ row }">{{ row.half }}</template>
        </el-table-column>
        <el-table-column v-for="crew in scheduleStore.crews" :key="crew.id" :label="crew.name" min-width="180">
          <template #default="{ row }">
            <template v-if="row.cells[crew.id]?.length">
              <el-tag
                v-for="item in row.cells[crew.id]"
                :key="item.id"
                size="small"
                type="success"
                effect="plain"
                class="board-tag"
              >
                {{ stepLabel(item.stepId) }}
              </el-tag>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div v-if="scheduleStore.batches.length > 0" class="section-card">
      <div class="section-card__head">
        <h3>批次占用（未来 7 天）</h3>
        <span class="muted">格内为 已占道数 / 供应能力</span>
      </div>
      <el-table :data="batchBoardRows" size="small" border>
        <el-table-column label="日期" width="120">
          <template #default="{ row }">{{ row.date }}</template>
        </el-table-column>
        <el-table-column label="半天" width="70">
          <template #default="{ row }">{{ row.half }}</template>
        </el-table-column>
        <el-table-column
          v-for="batch in scheduleStore.batches"
          :key="batch.id"
          :label="`${batch.material} #${batch.batchNo}`"
          min-width="140"
        >
          <template #default="{ row }">
            <span class="mono" :class="{ 'is-full': row.cells[batch.id]?.used >= row.cells[batch.id]?.capacity }">
              {{ row.cells[batch.id]?.used ?? 0 }} / {{ row.cells[batch.id]?.capacity ?? 0 }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div v-if="recentVoided.length > 0" class="section-card">
      <div class="section-card__head">
        <h3>已作废排班</h3>
        <span class="muted">病害程度、工序顺序或构件归属变化后，未完成的旧排班自动作废并释放占用</span>
      </div>
      <el-table :data="recentVoided" size="small">
        <el-table-column label="工序" min-width="200">
          <template #default="{ row }">{{ stepLabel(row.stepId) }}</template>
        </el-table-column>
        <el-table-column label="原槽位" width="150">
          <template #default="{ row }">{{ row.date }} {{ row.half }}</template>
        </el-table-column>
        <el-table-column label="班组" width="120">
          <template #default="{ row }">{{ crewName(row.crewId) }}</template>
        </el-table-column>
        <el-table-column label="批次" min-width="140">
          <template #default="{ row }">{{ batchName(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="作废原因" width="150">
          <template #default="{ row }">
            <el-tag size="small" type="warning" effect="plain">{{ row.voidReason || '已作废' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="作废时间" width="170">
          <template #default="{ row }">
            <span class="mono">{{ formatTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.inline-form__name {
  width: 200px;
}

.inline-form__note {
  width: 240px;
}

.inline-form__batch {
  width: 160px;
}

.inline-form__capacity {
  width: 130px;
}

.board-tag {
  margin: 2px 4px 2px 0;
  white-space: normal;
  height: auto;
  line-height: 1.5;
}

.is-full {
  color: #c0392b;
  font-weight: 600;
}
</style>
