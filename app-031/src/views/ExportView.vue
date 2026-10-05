<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, exportJobJson, issueOrder, ordersForJob } from '../lib/store'
import { printJob, type PrintSection } from '../lib/print'
import { downloadText, money } from '../lib/format'
import { toast } from '../lib/ui'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const tick = computed(() => job.value?.result?.generatedAt ?? 0)
const issuedOrders = computed(() => {
  void tick.value
  return job.value ? ordersForJob(job.value.id) : []
})

const sections = reactive<Record<PrintSection, boolean>>({
  nest: true,
  cut: true,
  order: true,
  labels: true
})
const sectionDefs: { key: PrintSection; name: string; desc: string }[] = [
  { key: 'nest', name: '排样图', desc: '每张板真实比例图 + 零件编号尺寸（可贴机器旁）' },
  { key: 'cut', name: '裁切步骤表', desc: '每一刀的方向/位置/贯通区间，按刀序排列' },
  { key: 'order', name: '下料单/领料单', desc: '板材领料、按柜零件明细、封边与五金辅料' },
  { key: 'labels', name: '零件标签', desc: 'A4 不干胶，每块零件一张，便于分拣' }
]

function selected(): PrintSection[] {
  return sectionDefs.filter((d) => sections[d.key]).map((d) => d.key)
}
function doPrint(): void {
  const list = selected()
  if (list.length === 0) {
    toast('至少勾选一项导出内容', 'bad')
    return
  }
  // 含领料单时：必须已有可行选板结论，导出动作同时在本机存档一张带指纹的单据
  if (list.includes('order')) {
    const j = job.value
    if (!j?.result?.boardSelect || j.result.boardSelect.status !== 'feasible') {
      toast('选板尚无可领料结论（预算/板幅/纹理卡点或预算为零），不能导出领料单', 'bad', 4200)
      return
    }
    const order = issueOrder(j)
    if (order) toast(`领料单已存档（指纹 ${order.fingerprint}）；改锯路/修边/板价后旧单自动作废`, 'good', 4200)
  }
  printJob(route.params.id as string, list)
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
function exportJson(): void {
  if (!job.value) return
  const safe = job.value.name.replace(/[\\/:*?"<>|]/g, '_')
  downloadText(`开料项目_${safe}_${job.value.id.slice(-4)}.json`, exportJobJson(job.value), 'application/json')
  toast('已导出项目 JSON（可在首页导回）', 'good')
}
void money
</script>

<template>
  <div v-if="job">
    <section class="panel">
      <h1 style="font-size: 19px; margin-bottom: 6px">导出与打印</h1>
      <p class="muted">
        勾选要出的内容后点打印/另存 PDF；所有版式按 A4 排好，可直接贴车间或交领料。标签为每块零件一张的不干胶。
      </p>
      <div class="sec-list">
        <label v-for="d in sectionDefs" :key="d.key" class="sec-item">
          <input type="checkbox" v-model="sections[d.key]" />
          <div>
            <b>{{ d.name }}</b>
            <span class="muted small"> — {{ d.desc }}</span>
          </div>
        </label>
      </div>
      <div class="row" style="margin-top: 14px">
        <button class="primary" @click="doPrint">🖨 打印 / 另存 PDF</button>
        <button @click="exportJson">导出项目 JSON（备份/换机）</button>
        <div class="spacer" />
        <router-link :to="`/nest/${job.id}`">← 回排样图</router-link>
      </div>
    </section>

    <section v-if="!job.result" class="panel" style="margin-top: 14px">
      <p class="muted">该项目尚未排样，打印内容将不完整。</p>
      <router-link :to="`/parts/${job.id}`"><button class="primary">去录零件并排样</button></router-link>
    </section>

    <section class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">导出内容预览（与打印一致）</h3>
      <ul class="small muted">
        <li>排样图：{{ job.result?.sheets.length ?? 0 }} 张板，同柜同色，标注编号与尺寸</li>
        <li>裁切步骤：{{ job.result?.sheets.reduce((a, s) => a + s.steps.length, 0) ?? 0 }} 条刀序（含修边）</li>
        <li>下料单：{{ job.result?.boardSelect?.plan?.boardKinds ?? 0 }} 种板材领料 + 按柜明细 + 封边五金（只取可行选板结论）</li>
        <li>标签：{{ job.result?.sheets.reduce((a, s) => a + s.placements.length, 0) ?? 0 }} 张（每块零件 1 张）</li>
      </ul>
      <p v-if="job.result?.boardSelect && job.result.boardSelect.status !== 'feasible'" class="small" style="color: var(--c-bad)">
        当前选板{{ job.result.boardSelect.status === 'inconclusive' ? '不下结论（零件为空或预算为零）' : '不可行' }}，
        领料单不会出板材行；请先到零件清单页解决：{{ job.result.boardSelect.gap?.text ?? '见选板结论卡点' }}
      </p>
    </section>

    <section class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">本机已存档的领料单据</h3>
      <p v-if="issuedOrders.length === 0" class="small muted">还没导出过领料单（勾选「下料单/领料单」打印时自动存档）。</p>
      <table v-else class="grid" style="font-size: 12.5px">
        <thead>
          <tr><th>导出时间</th><th>状态</th><th>张数</th><th>金额</th><th>指纹</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in issuedOrders" :key="o.id" :class="{ voidrow: o.voided }">
            <td>{{ fmtTime(o.issuedAt) }}</td>
            <td>
              <span :class="['tag', o.voided ? 'bad' : 'good']">{{ o.voided ? '已作废' : '有效' }}</span>
            </td>
            <td>{{ o.summary.boardsUsed }}</td>
            <td>{{ money(o.summary.totalCostCents) }}</td>
            <td class="mono">{{ o.fingerprint }}</td>
            <td class="small muted">{{ o.voided ? o.voidReason : '锯路/修边/板价/选板未变，继续有效' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="small muted" style="margin-top: 8px">
        作废规则：选错的一版一旦存档并导出，之后改锯路、修边、板价或重新选板，
        存档结论与已发领料单一律标记作废重来；「先板幅最大」让出的是板种数，「先挑最省」让出的是总价。
      </p>
    </section>
  </div>
</template>

<style scoped>
.sec-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.sec-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
}
.sec-item:hover {
  background: #fafcf9;
}
.sec-item input {
  margin-top: 3px;
}
.voidrow td {
  background: var(--c-bad-bg) !important;
  color: var(--c-bad);
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}
</style>
