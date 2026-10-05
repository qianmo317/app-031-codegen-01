<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runNestWithChange,
  isResultStale,
  getLastChange,
  newPart,
  allStockTemplates
} from '../lib/store'
import { uid, parsePartText, parseEdges, money } from '../lib/format'
import { toast } from '../lib/ui'
import type { Board, EdgeSide, Part } from '../types'
import BoardSelectPanel from '../components/BoardSelectPanel.vue'
import PlanChangePanel from '../components/PlanChangePanel.vue'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importErr = ref<string[]>([])
const importReplace = ref(false)
const running = ref(false)
// 最近一次重算的变化清单（与排样结果页、材料统计页取同一份）
const changeSeq = ref(0)
const lastChange = computed(() => {
  void changeSeq.value
  return job.value ? getLastChange(job.value.id) : null
})

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
const thicknessOptions = [0, 9, 18, 25]
const edgeDefs: { key: EdgeSide; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'left', label: '左' },
  { key: 'right', label: '右' }
]

const totalPieces = computed(() => job.value?.parts.reduce((a, p) => a + (p.qty || 0), 0) ?? 0)
const totalArea = computed(
  () => (job.value?.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0) ?? 0) / 1e6
)

const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available))

/** 预算元/分双向：内部一律按分（整数）存，输入框按元（2 位小数） */
const budgetYuan = computed<number | ''>({
  get: () => {
    const b = job.value?.budgetCents
    if (b === undefined || b < 0) return ''
    return b / 100
  },
  set: (v) => {
    if (!job.value) return
    if (v === '' || v === null || Number.isNaN(v)) job.value.budgetCents = -1
    else job.value.budgetCents = Math.round(Number(v) * 100)
  }
})
const stale = computed(() => (job.value ? isResultStale(job.value) : false))

function save(): void {
  if (job.value) saveJob(job.value)
}

/** 参数/板价变更后：若已有选板结论则立即用同一内核重算，并刷新逐项变化。 */
async function rerunAfterChange(): Promise<void> {
  const j = job.value
  save()
  if (!j || !j.result || running.value) return
  running.value = true
  try {
    await new Promise((r) => setTimeout(r, 0))
    const { change } = runNestWithChange(j)
    changeSeq.value++
    if (change?.changed) toast('锯路/修边/板价变更：选板结论、每张板的钱与摆法已一起重算', 'good', 3200)
  } finally {
    running.value = false
  }
}

function addBoard(): void {
  if (!job.value) return
  const t = allStockTemplates()[3] // 2745×1220
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function onPickTemplate(e: Event): void {
  const sel = e.target as HTMLSelectElement
  const i = Number(sel.value)
  sel.selectedIndex = 0
  if (i >= 0) addSpecificBoard(allStockTemplates()[i])
}
function addSpecificBoard(t: ReturnType<typeof allStockTemplates>[number]): void {
  if (!job.value) return
  if (job.value.boards.some((b) => b.name === t.name)) {
    toast('该板材已在库中', 'bad')
    return
  }
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function removeBoard(id: string): void {
  if (!job.value) return
  if (job.value.boards.length <= 1) {
    toast('至少保留一种板材', 'bad')
    return
  }
  job.value.boards = job.value.boards.filter((b) => b.id !== id)
  for (const p of job.value.parts) if (p.boardId === id) p.boardId = ''
  save()
}
function toggleOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  save()
}

function addPart(): void {
  job.value?.parts.push(
    newPart({
      code: `P${(job.value.parts.length + 1).toString().padStart(2, '0')}`,
      name: '新零件'
    })
  )
  save()
}
function removePart(id: string): void {
  if (!job.value) return
  job.value.parts = job.value.parts.filter((p) => p.id !== id)
  save()
}
function duplicatePart(p: Part): void {
  const idx = job.value!.parts.findIndex((x) => x.id === p.id)
  job.value!.parts.splice(idx + 1, 0, { ...p, id: uid('p') })
  save()
}
function toggleEdge(p: Part, e: EdgeSide): void {
  const i = p.edgeBands.indexOf(e)
  if (i >= 0) p.edgeBands.splice(i, 1)
  else p.edgeBands.push(e)
  save()
}

const warnings = computed<string[]>(() => {
  const out: string[] = []
  const j = job.value
  if (!j) return out
  for (const p of j.parts) {
    // 板幅预警按该件实际对得上的板来（指定板种/厚度时不能用全库最大板）
    const allowed = j.boards.filter(
      (b) =>
        (!p.boardId || b.id === p.boardId) &&
        (!(p.thicknessMm && p.thicknessMm > 0) || b.thicknessMm === p.thicknessMm)
    )
    if (allowed.length === 0) {
      out.push(`「${p.code}」指定的板种/厚度在板材库里没有对得上的板`)
      continue
    }
    const maxW = Math.max(...allowed.map((b) => b.wMm - 2 * j.trimMm))
    const maxH = Math.max(...allowed.map((b) => b.hMm - 2 * j.trimMm))
    if (p.grain === 'length' && (p.lenMm > maxW || p.widMm > maxH))
      out.push(`「${p.code}」竖纹件 ${p.lenMm}×${p.widMm} 超过对得上板的可用幅面 ${maxW}×${maxH}`)
    if (p.grain === 'width' && (p.widMm > maxW || p.lenMm > maxH))
      out.push(`「${p.code}」横纹件 ${p.lenMm}×${p.widMm} 超过对得上板的可用幅面 ${maxW}×${maxH}`)
    if (p.grain === 'none' && Math.max(p.lenMm, p.widMm) > maxW)
      out.push(`「${p.code}」长边超过对得上板的板长 ${maxW}`)
  }
  if (j.trimMm < 5 || j.trimMm > 10) out.push('修边量通常取 5~10mm')
  return out
})

function doImport(): void {
  if (!job.value) return
  const { rows, errors } = parsePartText(importText.value)
  importErr.value = errors
  if (rows.length === 0) {
    toast('没有可导入的行', 'bad')
    return
  }
  const boardId = job.value.boards[0]?.id ?? ''
  const built = rows.map((r) =>
    newPart({
      code: r.code || `P${Math.floor(Math.random() * 9000 + 1000)}`,
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain as Part['grain'],
      edgeBands: parseEdges(r.edges),
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  save()
  toast(`已导入 ${built.length} 条`, 'good')
  importOpen.value = false
  importText.value = ''
}

async function doNest(): Promise<void> {
  const j = job.value
  if (!j) return
  if (j.parts.length === 0) {
    toast('请先添加零件', 'bad')
    return
  }
  running.value = true
  try {
    const r = runNestWithChange(j)
    changeSeq.value++
    const rep = r.result.boardSelect
    if (rep?.status === 'blocked') {
      const b0 = rep.blockers.find((x) => x.block === 'budget')
      toast(b0 ? '排样完成但预算不够，请看选板结论差额' : '有板件排不下，选板结论已标明卡点', 'bad', 4200)
    } else if (r.result.unplaced.length > 0) {
      toast(`${r.result.unplaced.length} 种零件未排下，请看排样页提示`, 'bad', 4200)
    } else if (rep?.status === 'inconclusive') {
      toast('已试排，但按规则（零件为空/预算为零）不给选板结论', 'info', 3600)
    } else {
      toast(`排样完成：${r.result.boardsUsed} 张板，${r.result.elapsedMs}ms`, 'good')
    }
    router.push(`/nest/${j.id}`)
  } finally {
    running.value = false
  }
}

const sampleTsv = `名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
门板\t2200\t450\t2\t竖纹\t上下左右\t衣柜\t是
层板\t550\t560\t4\t无\t左右\t衣柜\t否`
</script>

<template>
  <div v-if="job">
    <div class="row wrap" style="margin-bottom: 14px">
      <input v-model="job.name" @change="save" style="width: 320px; font-weight: 650; font-size: 16px" />
      <span class="tag">创建于 {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
      <div class="spacer" />
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>

    <!-- 参数与余料 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 130px">
          <span>锯路 kerf (mm)</span>
          <input v-model.number="job.kerfMm" type="number" step="0.1" min="1" max="8" @change="rerunAfterChange" />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm)</span>
          <input v-model.number="job.trimMm" type="number" step="1" min="0" max="20" @change="rerunAfterChange" />
        </label>
        <label class="field" style="width: 150px">
          <span>板材花费上限（元/批，留空=不限；填 0=零预算不下结论）</span>
          <input v-model.number="budgetYuan" type="number" step="0.01" min="0" placeholder="不限" @change="rerunAfterChange" />
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" v-model="job.batchByCabinet" @change="save" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料（同柜零件尽量连续排）</span>
        </label>
      </div>

      <!-- 选板策略：两条只能选一条，取舍写明 -->
      <div class="strategy-box">
        <span class="strategy-title">选板取舍（二选一）：</span>
        <label class="strategy-opt" :class="{ on: job.boardStrategy === 'cheapest' }">
          <input type="radio" value="cheapest" v-model="job.boardStrategy" @change="rerunAfterChange" />
          <span><b>先挑最省的板种</b>：总价最低；常把同样的件摊到更多种板，领料/堆场/点数更费事。</span>
        </label>
        <label class="strategy-opt" :class="{ on: job.boardStrategy === 'largest' }">
          <input type="radio" value="largest" v-model="job.boardStrategy" @change="rerunAfterChange" />
          <span><b>先挑板幅最大的</b>：张数最少、板种更集中；但大板贵，容易少买几张却顶穿预算。</span>
        </label>
      </div>

      <div v-if="availableOffcuts.length > 0">
        <h4 style="margin: 8px 0 6px; font-size: 13px">余料优先：勾选已登记余料作为小板材参与本单排样</h4>
        <div class="row wrap">
          <label
            v-for="o in availableOffcuts"
            :key="o.id"
            class="offcut-chip"
            :class="{ on: job.useOffcutIds.includes(o.id) }"
          >
            <input type="checkbox" :checked="job.useOffcutIds.includes(o.id)" @change="toggleOffcut(o.id)" />
            {{ o.wMm }}×{{ o.hMm}}×{{ o.thicknessMm }} {{ o.material }}（{{ o.jobName }}）
          </label>
        </div>
      </div>
    </section>

    <!-- 选板与花费反算（三处同源：结论同时驱动排样结果页、材料统计页与领料单） -->
    <BoardSelectPanel
      v-if="job.result?.boardSelect"
      :report="job.result.boardSelect"
      :show-steps="true"
    />
    <PlanChangePanel v-if="lastChange" :change="lastChange" />

    <div v-if="stale" class="stale-bar">
      ⚠ 锯路/修边/板价/板件清单相对上一版排样已改动，下列选板结论与排样结果是旧版
      （明细页不会偷偷挂新板种）——
      <button class="sm primary" :disabled="running" @click="doNest">立即同源自重算</button>
    </div>

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库</h3>
        <div class="spacer" />
        <select style="width: 260px" @change="onPickTemplate">
          <option value="-1">＋ 从常用规格添加…</option>
          <option v-for="(t, i) in allStockTemplates()" :key="i" :value="i">{{ t.name }} {{ money(t.priceCents) }}</option>
        </select>
        <button class="sm" @click="addBoard">添加自定义板</button>
      </div>
      <table class="grid board-table">
        <thead>
          <tr>
            <th>名称/材质</th><th>长(mm)</th><th>宽(mm)</th><th>厚(mm)</th>
            <th>单价</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in job.boards" :key="b.id">
            <td>
              <input v-model="b.name" @change="save" />
              <input v-model="b.material" @change="save" class="sub-input" placeholder="材质" />
            </td>
            <td style="width: 96px"><input v-model.number="b.wMm" type="number" @change="rerunAfterChange" /></td>
            <td style="width: 96px"><input v-model.number="b.hMm" type="number" @change="rerunAfterChange" /></td>
            <td style="width: 84px"><input v-model.number="b.thicknessMm" type="number" @change="rerunAfterChange" /></td>
            <td style="width: 110px"><input v-model.number="b.priceCents" type="number" @change="rerunAfterChange" /></td>
            <td style="width: 130px"><input v-model.number="b.quantity" type="number" min="0" @change="rerunAfterChange" /></td>
            <td style="width: 46px"><button class="sm ghost-danger" @click="removeBoard(b.id)">删</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 零件清单 -->
    <section class="panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">零件清单</h3>
        <span class="tag">{{ job.parts.length }} 种 / {{ totalPieces }} 件 / {{ totalArea.toFixed(2) }}m²</span>
        <div class="spacer" />
        <button class="sm" @click="importOpen = !importOpen">批量粘贴导入</button>
        <button class="sm primary" @click="addPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <p class="small muted">
          支持 Excel 直接粘贴（制表符分隔），列：名称/长/宽/数量/纹理(竖|横|无)/封边(上下左右)/柜体/见光(是)。
          无表头时按「名称,长,宽,数量,纹理,封边,柜体,见光」顺序解析。
        </p>
        <textarea v-model="importText" rows="6" :placeholder="sampleTsv"></textarea>
        <p v-for="(e, i) in importErr" :key="i" class="small" style="color: var(--c-bad)">{{ e }}</p>
        <div class="row" style="margin-top: 6px">
          <label class="row small"><input type="checkbox" v-model="importReplace" /> 替换当前清单</label>
          <div class="spacer" />
          <button class="sm" @click="importOpen = false">取消</button>
          <button class="sm primary" @click="doImport">解析并导入</button>
        </div>
      </div>

      <div v-if="warnings.length > 0" class="warn-box">
        <div v-for="(w, i) in warnings" :key="i">⚠️ {{ w }}</div>
      </div>

      <div class="table-scroll">
        <table class="grid parts-table">
          <thead>
            <tr>
              <th style="width: 80px">编号</th>
              <th style="width: 130px">名称</th>
              <th style="width: 80px">长(mm)</th>
              <th style="width: 80px">宽(mm)</th>
              <th style="width: 64px">数量</th>
              <th style="width: 92px">纹理</th>
              <th style="width: 92px">指定厚度</th>
              <th style="width: 132px">封边</th>
              <th style="width: 110px">柜体/房间</th>
              <th style="width: 70px">见光</th>
              <th style="width: 130px">指定板材</th>
              <th style="width: 78px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in job.parts" :key="p.id">
              <td><input v-model="p.code" @change="save" /></td>
              <td><input v-model="p.name" @change="save" /></td>
              <td><input v-model.number="p.lenMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.widMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.qty" type="number" min="1" @change="save" /></td>
              <td>
                <select v-model="p.grain" @change="save">
                  <option v-for="(lab, g) in grainLabel" :key="g" :value="g">{{ lab }}</option>
                </select>
              </td>
              <td>
                <select v-model.number="p.thicknessMm" @change="save">
                  <option :value="0">不限</option>
                  <option v-for="t in thicknessOptions.filter((x) => x > 0)" :key="t" :value="t">{{ t }}mm</option>
                </select>
              </td>
              <td>
                <div class="edge-group">
                  <label v-for="ed in edgeDefs" :key="ed.key" class="edge-cb" :class="{ on: p.edgeBands.includes(ed.key) }">
                    <input type="checkbox" :checked="p.edgeBands.includes(ed.key)" @change="toggleEdge(p, ed.key)" />
                    {{ ed.label }}
                  </label>
                </div>
              </td>
              <td><input v-model="p.cabinet" @change="save" /></td>
              <td style="text-align: center"><input type="checkbox" v-model="p.exposed" @change="save" /></td>
              <td>
                <select v-model="p.boardId" @change="save">
                  <option value="">自动</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </td>
              <td>
                <button class="sm" title="复制一行" @click="duplicatePart(p)">复</button>
                <button class="sm ghost-danger" title="删除" @click="removePart(p.id)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="sticky-bar no-print">
      <span>{{ job.parts.length }} 种 / {{ totalPieces }} 件 · 总面积 {{ totalArea.toFixed(2) }}m²</span>
      <div class="spacer" />
      <router-link :to="`/`">返回列表</router-link>
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.offcut-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.offcut-chip.on {
  border-color: var(--c-accent);
  background: #f0faf8;
  color: var(--c-accent);
  font-weight: 600;
}
.sub-input {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-ink-2);
}
.import-box {
  border: 1px dashed var(--c-line);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
  background: #fafcf9;
}
.warn-box {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 10px;
}
.strategy-box {
  display: flex;
  gap: 10px;
  align-items: stretch;
  flex-wrap: wrap;
  margin: 4px 0 10px;
}
.strategy-title {
  font-size: 12.5px;
  font-weight: 650;
  align-self: center;
}
.strategy-opt {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 12px;
  color: var(--c-ink-2);
  cursor: pointer;
  flex: 1 1 300px;
  max-width: 520px;
  background: #fafcf9;
}
.strategy-opt input {
  width: auto;
  margin-top: 2px;
}
.strategy-opt.on {
  border-color: var(--c-primary);
  background: #fff7ed;
  color: var(--c-ink);
}
.stale-bar {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: var(--radius);
  padding: 8px 14px;
  font-size: 12.5px;
  margin-bottom: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.table-scroll {
  overflow-x: auto;
}
.parts-table th,
.parts-table td {
  padding: 4px 6px;
}
.parts-table input,
.parts-table select {
  padding: 4px 6px;
  min-width: 0;
}
.edge-group {
  display: flex;
  gap: 2px;
}
.edge-cb {
  font-size: 11px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.edge-cb.on {
  background: #1f2a26;
  color: #fff;
  border-color: #1f2a26;
}
.edge-cb input {
  display: none;
}
.sticky-bar {
  position: sticky;
  bottom: 12px;
  margin-top: 16px;
  background: #1f2a26;
  color: #eef2ee;
  border-radius: 10px;
  padding: 10px 16px;
  display: flex;
  gap: 14px;
  align-items: center;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
}
.sticky-bar a {
  color: #9fb0a7;
}
</style>
