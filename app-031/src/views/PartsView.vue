<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runSelection,
  autoReselect,
  newPart,
  allStockTemplates
} from '../lib/store'
import { uid, parsePartText, parseEdges, money, yuanToCents } from '../lib/format'
import { toast } from '../lib/ui'
import SelectionBanner from '../components/SelectionBanner.vue'
import type { Board, EdgeSide, Part } from '../types'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importErr = ref<string[]>([])
const importReplace = ref(false)
const running = ref(false)

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
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

// 预算输入（元）：内部以分（整数）存储；空串视为 0（未设定 → 不给结论）
const budgetYuan = computed<number | ''>({
  get: () => (job.value && job.value.budgetCents > 0 ? job.value.budgetCents / 100 : ''),
  set: (v) => {
    if (!job.value) return
    job.value.budgetCents = yuanToCents(Number(v) || 0)
    save()
    onReselectInput()
  }
})
const strategy = computed({
  get: () => job.value?.strategy ?? 'cheapest',
  set: (v: 'cheapest' | 'largest') => {
    if (!job.value) return
    job.value.strategy = v
    save()
    onReselectInput()
  }
})

/** 每件零件在选板结论里被摊到哪几种板、各几件（取数同源：job.result.sheets） */
const assignedBoardByPart = computed(() => {
  const m = new Map<string, Map<string, number>>()
  const r = job.value?.result
  if (r) {
    for (const s of r.sheets) {
      for (const p of s.placements) {
        let inner = m.get(p.partId)
        if (!inner) {
          inner = new Map()
          m.set(p.partId, inner)
        }
        inner.set(s.boardName, (inner.get(s.boardName) ?? 0) + 1)
      }
    }
  }
  return m
})
function assignedText(p: Part): string {
  const inner = assignedBoardByPart.value.get(p.id)
  if (!inner || inner.size === 0) return '—'
  const parts2 = [...inner.entries()].map(([name, n]) =>
    n >= p.qty && inner!.size === 1 ? name : `${name}×${n}`
  )
  const total = [...inner.values()].reduce((a, b) => a + b, 0)
  return total < p.qty ? `${parts2.join('、')}（余 ${p.qty - total} 件未排下）` : parts2.join('、')
}

/** 锯路/修边/板价/板幅/零件/余料勾选一改：结论、每张板的钱与摆法一起重算。 */
function onReselectInput(): void {
  const j = job.value
  if (!j || !j.result) return // 从未排样/选板时不自动跑，避免录入过程被打断
  const out = autoReselect(j)
  if (!out) return
  if (out.selection.status === 'conclusion') {
    toast(`已按新输入重算：${out.selection.totalSheets} 张 / ${money(out.selection.totalCostCents ?? 0)}`, 'good')
  } else if (out.selection.status === 'budget') {
    toast(`重算后预算不够，还差 ${money(out.selection.budgetShortCents ?? 0)}`, 'bad', 3600)
  } else if (out.selection.status === 'blocked') {
    toast(out.selection.message, 'bad', 3600)
  }
}

function save(): void {
  if (job.value) saveJob(job.value)
}

function addBoard(): void {
  if (!job.value) return
  const t = allStockTemplates()[3] // 2745×1220
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
  onReselectInput()
}
function onPickTemplate(e: Event): void {
  const sel2 = e.target as HTMLSelectElement
  const i = Number(sel2.value)
  sel2.selectedIndex = 0
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
  onReselectInput()
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
  onReselectInput()
}
function boardEdited(): void {
  save()
  onReselectInput()
}
function toggleOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  save()
  onReselectInput()
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
  onReselectInput()
}
function duplicatePart(p: Part): void {
  const idx = job.value!.parts.findIndex((x) => x.id === p.id)
  job.value!.parts.splice(idx + 1, 0, { ...p, id: uid('p') })
  save()
  onReselectInput()
}
function partEdited(): void {
  save()
  onReselectInput()
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
  const maxW = Math.max(...j.boards.map((b) => b.wMm - 2 * j.trimMm))
  const maxH = Math.max(...j.boards.map((b) => b.hMm - 2 * j.trimMm))
  for (const p of j.parts) {
    const long = Math.max(p.lenMm, p.widMm)
    const short = Math.min(p.lenMm, p.widMm)
    if (p.grain === 'length' && (p.lenMm > maxW || p.widMm > maxH))
      out.push(`「${p.code}」竖纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'width' && (p.widMm > maxW || p.lenMm > maxH))
      out.push(`「${p.code}」横纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'none' && long > maxW)
      out.push(`「${p.code}」长边 ${long} 超过板长 ${maxW}`)
    void short
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
  onReselectInput()
  toast(`已导入 ${built.length} 条`, 'good')
  importOpen.value = false
  importText.value = ''
}

async function doSelect(): Promise<void> {
  const j = job.value
  if (!j) return
  if (j.parts.length === 0) {
    toast('请先添加零件', 'bad')
    return
  }
  if (!(j.budgetCents > 0)) {
    toast('请先填本批板材预算（元）：预算为 0 时不出选板结论', 'bad', 3600)
    return
  }
  running.value = true
  try {
    const out = runSelection(j)
    if (out.selection.status === 'conclusion') {
      toast(`选板完成：${out.selection.totalSheets} 张 / ${money(out.selection.totalCostCents ?? 0)}`, 'good')
      router.push(`/nest/${j.id}`)
    } else if (out.selection.status === 'budget') {
      toast(`排得下但预算不够，还差 ${money(out.selection.budgetShortCents ?? 0)}`, 'bad', 4200)
    } else if (out.selection.status === 'blocked') {
      toast(out.selection.message, 'bad', 4200)
    } else {
      toast(out.selection.message, 'bad', 3600)
    }
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
      <button class="primary" :disabled="running" @click="doSelect">
        {{ running ? '选板排样中…' : '选板并反算花费 →' }}
      </button>
    </div>

    <!-- 选板结论 / 失败分型 / 变化清单（三处同源） -->
    <SelectionBanner v-if="job.result?.selection" :job="job" />

    <!-- 选板参数：预算上限 + 二选一取舍 -->
    <section class="panel select-panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 170px">
          <span>板材花费上限（元）</span>
          <input v-model.number="budgetYuan" type="number" step="0.01" min="0" placeholder="不填/0 = 不出结论" />
        </label>
        <label class="field" style="width: 250px">
          <span>选板取舍（二选一）</span>
          <select v-model="strategy">
            <option value="cheapest">先挑最省：总价最低优先（可能摊到更多种板）</option>
            <option value="largest">先挑最大板幅：张数最少优先（可能顶穿预算）</option>
          </select>
        </label>
        <span class="small muted pick-note">
          先挑最省：同样的件可能摊到更多种板上，采购与点数更费事、堆场更碎；
          先挑最大板幅：容易少买几张却把预算顶穿。两条路只走一条，结论里给另一条的对照数。
        </span>
      </div>
      <p class="small muted" style="margin: 6px 0 0">
        判定口径（与排样内核同一条路径）：面积内部按 mm² 整数累计，折 m² 保留 2 位小数；
        金额内部以「分」整数存储累加，折元四舍五入到 0.01 元；封边米数保留 2 位；利用率为 1 位百分数。
        指定板种/厚度的件只上对得上的板；竖纹/横纹件不旋转硬塞；余隙须为 0 或 ≥锯路、四周先扣修边。
      </p>
    </section>

    <!-- 参数与余料 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 130px">
          <span>锯路 kerf (mm)</span>
          <input v-model.number="job.kerfMm" type="number" step="0.1" min="1" max="8" @change="() => { save(); onReselectInput() }" />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm)</span>
          <input v-model.number="job.trimMm" type="number" step="1" min="0" max="20" @change="() => { save(); onReselectInput() }" />
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" v-model="job.batchByCabinet" @change="() => { save(); onReselectInput() }" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料（同柜零件尽量连续排）</span>
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

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库（常见规格；改板价/板幅后选板结论自动重算）</h3>
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
            <th>单价(分/张)</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in job.boards" :key="b.id">
            <td>
              <input v-model="b.name" @change="boardEdited" />
              <input v-model="b.material" @change="boardEdited" class="sub-input" placeholder="材质" />
            </td>
            <td style="width: 96px"><input v-model.number="b.wMm" type="number" @change="boardEdited" /></td>
            <td style="width: 96px"><input v-model.number="b.hMm" type="number" @change="boardEdited" /></td>
            <td style="width: 84px"><input v-model.number="b.thicknessMm" type="number" @change="boardEdited" /></td>
            <td style="width: 120px">
              <input v-model.number="b.priceCents" type="number" @change="boardEdited" />
              <span class="sub-price">{{ money(b.priceCents) }}</span>
            </td>
            <td style="width: 130px"><input v-model.number="b.quantity" type="number" min="0" @change="boardEdited" /></td>
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
              <th style="width: 72px">指定厚</th>
              <th style="width: 132px">封边</th>
              <th style="width: 110px">柜体/房间</th>
              <th style="width: 70px">见光</th>
              <th style="width: 130px">指定板材</th>
              <th style="width: 150px">选板摊派（同源）</th>
              <th style="width: 78px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in job.parts" :key="p.id">
              <td><input v-model="p.code" @change="partEdited" /></td>
              <td><input v-model="p.name" @change="partEdited" /></td>
              <td><input v-model.number="p.lenMm" type="number" min="1" @change="partEdited" /></td>
              <td><input v-model.number="p.widMm" type="number" min="1" @change="partEdited" /></td>
              <td><input v-model.number="p.qty" type="number" min="1" @change="partEdited" /></td>
              <td>
                <select v-model="p.grain" @change="partEdited">
                  <option v-for="(lab, g) in grainLabel" :key="g" :value="g">{{ lab }}</option>
                </select>
              </td>
              <td><input v-model.number="p.thicknessMm" type="number" min="0" step="1" placeholder="不限" @change="partEdited" /></td>
              <td>
                <div class="edge-group">
                  <label v-for="ed in edgeDefs" :key="ed.key" class="edge-cb" :class="{ on: p.edgeBands.includes(ed.key) }">
                    <input type="checkbox" :checked="p.edgeBands.includes(ed.key)" @change="toggleEdge(p, ed.key)" />
                    {{ ed.label }}
                  </label>
                </div>
              </td>
              <td><input v-model="p.cabinet" @change="save" /></td>
              <td style="text-align: center"><input type="checkbox" v-model="p.exposed" @change="partEdited" /></td>
              <td>
                <select v-model="p.boardId" @change="partEdited">
                  <option value="">自动</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </td>
              <td class="assigned-cell" :title="'与排样结果页、材料统计页取同一份选板结论'">
                <span :class="{ unassigned: assignedText(p) === '—' }">{{ assignedText(p) }}</span>
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
      <button class="primary" :disabled="running" @click="doSelect">
        {{ running ? '选板排样中…' : '选板并反算花费 →' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.select-panel {
  border-left: 4px solid var(--c-accent, #14745a);
}
.pick-note {
  max-width: 520px;
}
.sub-price {
  display: block;
  font-size: 10px;
  color: var(--c-ink-2);
  margin-top: 2px;
}
.assigned-cell {
  font-size: 11px;
  color: var(--c-ink-1, #1f2a26);
}
.assigned-cell .unassigned {
  color: var(--c-ink-2);
}
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
