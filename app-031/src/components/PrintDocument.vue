<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob, planRows } from '../lib/store'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'
import { snapshotFingerprint } from '../lib/boardSelect'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

const allInstances = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.flatMap((s) => s.placements)
})

// 领料单取数：只从选板 plan 取（与板件明细页/排样结果页/材料统计页同源）
const plan = computed(() => job.value?.result?.boardSelect?.plan ?? null)
const feasible = computed(() => job.value?.result?.boardSelect?.status === 'feasible')
const orderRows = computed(() => planRows(job.value?.result))
const currentFingerprint = computed(() =>
  job.value?.result
    ? snapshotFingerprint(job.value.result.sheets, {
        kerfMm: job.value.kerfMm,
        trimMm: job.value.trimMm,
        budgetCents: job.value.budgetCents,
        strategy: job.value.boardStrategy
      })
    : ''
)

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
  boardName: string
}
function sheetNameOf(boardIndex: number): string {
  return job.value?.result?.sheets[boardIndex]?.boardName ?? ''
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const s of allInstances.value) {
    const arr = map.get(s.cabinet) ?? []
    const cur = arr.find((r) => r.code === s.code)
    if (cur) cur.qty++
    else
      arr.push({
        code: s.code,
        name: s.name,
        origLen: s.origLen,
        origWid: s.origWid,
        qty: 1,
        grain: s.grain,
        edgeCount: s.edgeBands.length,
        exposed: s.exposed,
        boardName: sheetNameOf(s.boardIndex)
      })
    map.set(s.cabinet, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'
</script>

<template>
  <div v-if="job" class="print-doc print-only">
    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张</h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td>{{ p.seq }}</td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）</h2>
        <p class="doc-meta">按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。</p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单（只按可行选板结论出；不可行时打印作废/禁用提示，不产出旧板种领料行） -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单</h2>
        <p class="doc-meta">
          项目：{{ job.name }} ｜ 打印时间：{{ now }}<br />
          策略：{{ job.boardStrategy === 'cheapest' ? '先挑最省' : '先挑板幅最大' }} ｜
          预算：{{ job.budgetCents < 0 ? '不设限' : job.budgetCents === 0 ? '¥0.00（零预算）' : money(job.budgetCents) }} ｜
          锯路 {{ job.kerfMm }}mm ｜ 修边 {{ job.trimMm }}mm ｜
          单据指纹：{{ currentFingerprint }}
        </p>

        <div v-if="!feasible" class="void-note">
          ⚠ 当前选板结论为「{{ job.result?.boardSelect?.status === 'inconclusive' ? '不下结论（零件为空或预算为零）' : '不可行' }}」：
          {{ job.result?.boardSelect?.gap?.text ?? '板幅/纹理/板种卡点未解（见板件明细页判定步骤）' }}。
          本页不出板材领料行，不得据此领料。
        </div>

        <template v-else>
        <h3>一、板材领料（取选板反算结论，三处同源）</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in orderRows" :key="r.boardId">
              <td>{{ r.boardName }}{{ r.isOffcut ? '（余料板）' : '' }}</td>
              <td>{{ r.wMm }}×{{ r.hMm }}</td>
              <td>{{ r.thicknessMm }}</td>
              <td>{{ r.sheets }}</td>
              <td>{{ money(r.priceCents) }}</td>
              <td>{{ money(r.subtotalCents) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计（分累加，折元四舍五入到分）</td>
              <td>{{ money(plan?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th><th>领用板种</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code">
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '是' : '' }}</td>
                <td>{{ g.boardName }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>三、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ job.result?.edgeBandM.exposed }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ job.result?.edgeBandM.normal }} m</td></tr>
            <tr><td>{{ boardsData.hardware.connectorName }}</td><td>{{ allInstances.length * boardsData.hardware.connectorPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.dowelName }}</td><td>{{ allInstances.length * boardsData.hardware.dowelPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.screwName }}</td><td>{{ allInstances.length * boardsData.hardware.screwPerPart }}</td></tr>
            <tr>
              <td>{{ boardsData.hardware.glueName }}</td>
              <td>{{ ((((job.result?.edgeBandM.exposed ?? 0) + (job.result?.edgeBandM.normal ?? 0)) * boardsData.hardware.glueGramPerEdgeMeter) / 1000).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
        </template>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <div class="lb-code">{{ p.code }} <span class="lb-seq">#{{ p.seq }}</span></div>
          <div class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ 封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.void-note {
  border: 2px solid #b91c1c;
  color: #b91c1c;
  padding: 10px 12px;
  margin: 8px 0;
  font-weight: 700;
  font-size: 13px;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
</style>
