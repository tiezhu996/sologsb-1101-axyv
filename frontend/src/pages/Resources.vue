<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useRepairStore } from '@/stores/repairStore'
import { type Crew, type MaterialBatch } from '@/types/resource'
import { ALLOCATION_STATE_LABEL } from '@/types/schedule'
import { formatSlot } from '@/utils/date'

const scheduleStore = useScheduleStore()
const repairStore = useRepairStore()

const activeTab = ref<'crews' | 'batches' | 'allocations'>('crews')

// --------------------------------------------------------------- 班组

const crewDialogVisible = ref(false)
const editingCrewId = ref<string | null>(null)
const crewForm = reactive({ name: '', trade: '', contact: '', archived: false })

function openCrewDialog(crew?: Crew): void {
  if (crew) {
    editingCrewId.value = crew.id
    crewForm.name = crew.name
    crewForm.trade = crew.trade
    crewForm.contact = crew.contact
    crewForm.archived = crew.archived
  } else {
    editingCrewId.value = null
    crewForm.name = ''
    crewForm.trade = ''
    crewForm.contact = ''
    crewForm.archived = false
  }
  crewDialogVisible.value = true
}

async function submitCrew(): Promise<void> {
  const name = crewForm.name.trim()
  if (!name) {
    ElMessage.warning('请填写班组名称')
    return
  }
  try {
    if (editingCrewId.value) {
      await scheduleStore.updateCrew(editingCrewId.value, {
        name,
        trade: crewForm.trade.trim(),
        contact: crewForm.contact.trim(),
        archived: crewForm.archived
      })
      ElMessage.success('班组已更新')
    } else {
      await scheduleStore.createCrew({
        name,
        trade: crewForm.trade.trim(),
        contact: crewForm.contact.trim(),
        archived: crewForm.archived
      })
      ElMessage.success('班组已建档')
    }
    crewDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败，请重试')
  }
}

async function removeCrew(crew: Crew): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除班组「${crew.name}」？存在排班或施工记录的班组不允许删除，可改为停用。`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    await scheduleStore.removeCrew(crew.id)
    ElMessage.success('班组已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

// --------------------------------------------------------------- 材料批次

const batchDialogVisible = ref(false)
const editingBatchId = ref<string | null>(null)
const batchForm = reactive({
  materialName: '',
  batchNo: '',
  arriveDate: '' as string | Date,
  capacityQty: 100,
  note: ''
})

function openBatchDialog(batch?: MaterialBatch): void {
  if (batch) {
    editingBatchId.value = batch.id
    batchForm.materialName = batch.materialName
    batchForm.batchNo = batch.batchNo
    batchForm.arriveDate = batch.arriveDate
    batchForm.capacityQty = batch.capacityQty
    batchForm.note = batch.note
  } else {
    editingBatchId.value = null
    batchForm.materialName = ''
    batchForm.batchNo = ''
    batchForm.arriveDate = new Date()
    batchForm.capacityQty = 100
    batchForm.note = ''
  }
  batchDialogVisible.value = true
}

async function submitBatch(): Promise<void> {
  const materialName = batchForm.materialName.trim()
  const batchNo = batchForm.batchNo.trim()
  if (!materialName || !batchNo) {
    ElMessage.warning('请填写材料名称与批次编号')
    return
  }
  if (!(batchForm.capacityQty > 0)) {
    ElMessage.warning('容量必须大于 0')
    return
  }
  const arriveDate =
    batchForm.arriveDate instanceof Date
      ? `${batchForm.arriveDate.getFullYear()}-${String(batchForm.arriveDate.getMonth() + 1).padStart(2, '0')}-${String(
          batchForm.arriveDate.getDate()
        ).padStart(2, '0')}`
      : String(batchForm.arriveDate ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arriveDate)) {
    ElMessage.warning('请选择到货日期')
    return
  }
  try {
    if (editingBatchId.value) {
      await scheduleStore.updateBatch(editingBatchId.value, {
        materialName,
        batchNo,
        arriveDate,
        capacityQty: batchForm.capacityQty,
        note: batchForm.note.trim()
      })
      ElMessage.success('批次已更新')
    } else {
      await scheduleStore.createBatch({
        materialName,
        batchNo,
        arriveDate,
        capacityQty: batchForm.capacityQty,
        note: batchForm.note.trim()
      })
      ElMessage.success('批次已建档')
    }
    batchDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败，请重试')
  }
}

async function removeBatch(batch: MaterialBatch): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除批次「${batch.batchNo}」？被排班或施工记录占用的批次不允许删除。`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    await scheduleStore.removeBatch(batch.id)
    ElMessage.success('批次已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

// --------------------------------------------------------------- 占用台账

interface AllocationRow {
  id: string
  date: string
  slotLabel: string
  crewName: string
  stepName: string
  operator: string
  materialText: string
  qty: number
  state: string
  stateLabel: string
  voidReason: string | null
}

const allocationRows = computed<AllocationRow[]>(() => {
  const crewMap = new Map(scheduleStore.crews.map((crew) => [crew.id, crew.name]))
  const batchMap = new Map(scheduleStore.batches.map((batch) => [batch.id, batch]))
  return [...scheduleStore.allocations]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
    .map((allocation) => {
      const step = repairStore.steps.find((item) => item.id === allocation.stepId)
      const batch = allocation.batchId ? batchMap.get(allocation.batchId) : undefined
      return {
        id: allocation.id,
        date: allocation.date,
        slotLabel: formatSlot(allocation.date, allocation.slot),
        crewName: crewMap.get(allocation.crewId) ?? '班组已删除',
        stepName: step ? `${step.name}（${step.operator || '责任人未填'}）` : '工序已删除',
        operator: step?.operator ?? '',
        materialText: batch
          ? `${batch.materialName} · ${batch.batchNo}`
          : allocation.batchId
            ? '批次已删除'
            : '不占材料',
        qty: allocation.qty,
        state: allocation.state,
        stateLabel: ALLOCATION_STATE_LABEL[allocation.state],
        voidReason: allocation.voidReason
      }
    })
})

function stateTagType(state: string): 'success' | 'warning' | 'info' | 'danger' {
  if (state === 'done') return 'success'
  if (state === 'scheduled') return 'warning'
  return 'info'
}

const activeCrewCount = computed(() => scheduleStore.crews.filter((crew) => !crew.archived).length)
const scheduledCount = computed(
  () => scheduleStore.allocations.filter((item) => item.state === 'scheduled').length
)
const voidedCount = computed(() => scheduleStore.allocations.filter((item) => item.state === 'voided').length)
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>班组与材料档期</h2>
        <p>
          维护施工班组与材料批次：同一班组同一半天只能承担一道工序，材料批次容量按用量占减；
          容量不够或班组已被占用时，排班自动排队顺延。
        </p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="在用班组" :value="activeCrewCount" suffix="个" icon="User" tone="primary" />
      <StatBadge label="材料批次" :value="scheduleStore.batches.length" suffix="批" icon="Box" tone="info" />
      <StatBadge label="待施工排班" :value="scheduledCount" suffix="条" icon="Calendar" tone="warning" />
      <StatBadge label="已作废占位" :value="voidedCount" suffix="条" icon="CircleClose" />
    </div>

    <div class="section-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="施工班组" name="crews">
          <div class="tab-head">
            <span class="muted">停用的班组不参与新排班，历史排班与施工记录保留。</span>
            <el-button type="primary" size="small" :icon="Plus" @click="openCrewDialog()">新增班组</el-button>
          </div>
          <el-table :data="scheduleStore.crews" size="small">
            <el-table-column label="班组名称" prop="name" min-width="140" />
            <el-table-column label="工种" prop="trade" min-width="120" />
            <el-table-column label="联系方式 / 负责人" prop="contact" min-width="180" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="row.archived ? 'info' : 'success'" effect="plain">
                  {{ row.archived ? '已停用' : '在用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :icon="Edit" @click="openCrewDialog(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeCrew(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="材料批次" name="batches">
          <div class="tab-head">
            <span class="muted">材料名称需与工序「材料 / 配比」文本一致才能自动匹配；剩余容量实时汇总。</span>
            <el-button type="primary" size="small" :icon="Plus" @click="openBatchDialog()">新增批次</el-button>
          </div>
          <el-table :data="scheduleStore.batches" size="small">
            <el-table-column label="材料名称" prop="materialName" min-width="180" />
            <el-table-column label="批次编号" prop="batchNo" min-width="150" />
            <el-table-column label="到货日期" prop="arriveDate" width="120" />
            <el-table-column label="总容量" width="100">
              <template #default="{ row }">
                <span class="mono">{{ row.capacityQty }}</span>
              </template>
            </el-table-column>
            <el-table-column label="已占 / 剩余" width="130">
              <template #default="{ row }">
                <span class="mono">{{ row.capacityQty - scheduleStore.remainingQty(row.id) }} / {{ scheduleStore.remainingQty(row.id) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="备注" prop="note" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :icon="Edit" @click="openBatchDialog(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="排班占用台账" name="allocations">
          <p class="muted tab-note">
            所有班组半天档期与材料容量占用以本表为唯一来源；已作废的占位释放档期与容量，已施工的历史记录永久保留。
          </p>
          <el-table :data="allocationRows" size="small" max-height="560">
            <el-table-column label="日期半天" prop="slotLabel" width="130" />
            <el-table-column label="班组" prop="crewName" min-width="120" />
            <el-table-column label="工序（责任人）" prop="stepName" min-width="180" />
            <el-table-column label="材料批次" prop="materialText" min-width="220" show-overflow-tooltip />
            <el-table-column label="用量" width="80">
              <template #default="{ row }">
                <span class="mono">{{ row.qty || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="stateTagType(row.state)" effect="plain">{{ row.stateLabel }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="作废原因" prop="voidReason" min-width="140" show-overflow-tooltip />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="crewDialogVisible" :title="editingCrewId ? '编辑班组' : '新增班组'" width="480px">
      <el-form label-width="110px">
        <el-form-item label="班组名称" required>
          <el-input v-model="crewForm.name" placeholder="如：油工一组" maxlength="30" />
        </el-form-item>
        <el-form-item label="工种">
          <el-input v-model="crewForm.trade" placeholder="如：油工彩画 / 裱糊 / 搭材" maxlength="20" />
        </el-form-item>
        <el-form-item label="联系方式">
          <el-input v-model="crewForm.contact" placeholder="负责人 / 电话" maxlength="40" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="crewForm.archived" active-text="停用" inactive-text="在用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="crewDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCrew">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDialogVisible" :title="editingBatchId ? '编辑材料批次' : '新增材料批次'" width="500px">
      <el-form label-width="110px">
        <el-form-item label="材料名称" required>
          <el-input v-model="batchForm.materialName" placeholder="与工序材料文本一致，如：鱼鳔胶（2% 明矾水调和）" maxlength="60" />
        </el-form-item>
        <el-form-item label="批次编号" required>
          <el-input v-model="batchForm.batchNo" placeholder="如：GLUE-20261005" maxlength="30" />
        </el-form-item>
        <el-form-item label="到货日期" required>
          <el-date-picker v-model="batchForm.arriveDate" type="date" value-format="YYYY-MM-DD" placeholder="选择到货日期" class="full-width" />
        </el-form-item>
        <el-form-item label="批次容量" required>
          <el-input-number v-model="batchForm.capacityQty" :min="1" :step="10" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.note" placeholder="计量单位 / 用途说明" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tab-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.tab-note {
  margin: 0 0 12px;
  font-size: 12px;
}

.full-width {
  width: 100%;
}
</style>
