<script setup lang="ts">
// 重算变化清单：哪几张板的板种/张数变了、哪几件换了板、领料单据与成本表哪几行变了
import { computed } from 'vue'
import type { PlanChange } from '../types'
import { money } from '../lib/format'

const props = defineProps<{ change: PlanChange | null }>()

const visible = computed(() => {
  const c = props.change
  if (!c) return null
  return {
    boardRows: c.boardRows,
    movedParts: c.movedParts,
    sheetChanges: c.sheetBoardChanges,
    costRows: c.costTableRows,
    voided: c.orderEffects.filter((e) => e.status === 'void'),
    kept: c.orderEffects.filter((e) => e.status === 'keep'),
    paramChanges: c.paramChanges
  }
})
const hasAny = computed(() => {
  const v = visible.value
  if (!v) return false
  return (
    v.boardRows.length > 0 ||
    v.movedParts.length > 0 ||
    v.sheetChanges.length > 0 ||
    v.costRows.length > 0 ||
    v.voided.length > 0
  )
})
const kindLabel: Record<string, string> = {
  added: '新增板种行',
  removed: '整行取消',
  sheets: '张数变动',
  same: ''
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
void money
</script>

<template>
  <section v-if="change && visible" class="chgpanel" :class="{ empty: !hasAny }">
    <h4>
      {{ hasAny ? '本次重算的逐项变化' : '参数已重算：选板结论与摆法均无变化' }}
      <span class="tag mono">指纹 {{ change.beforeFingerprint || '—' }} → {{ change.afterFingerprint }}</span>
    </h4>

    <div v-if="visible.paramChanges.length > 0" class="line">
      <span class="k">参数：</span>
      <span v-for="(p, i) in visible.paramChanges" :key="i" class="tag warn">{{ p }}</span>
    </div>

    <div v-if="visible.boardRows.length > 0">
      <div class="k">① 领料单据/选板结论里变动的板种行：</div>
      <table class="grid mini">
        <thead>
          <tr><th>板材</th><th>变动</th><th>张数</th><th>小计</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in visible.boardRows" :key="r.boardId">
            <td>{{ r.boardName }}</td>
            <td><span class="tag" :class="r.kind === 'removed' ? 'bad' : r.kind === 'added' ? 'good' : 'warn'">{{ kindLabel[r.kind] }}</span></td>
            <td>{{ r.beforeSheets }} → <b>{{ r.afterSheets }}</b></td>
            <td>¥{{ (r.beforeSubtotalCents / 100).toFixed(2) }} → <b>¥{{ (r.afterSubtotalCents / 100).toFixed(2) }}</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="visible.sheetChanges.length > 0">
      <div class="k">② 每张板的板种/张数变化（第 N 张）：</div>
      <div class="chips">
        <span v-for="s in visible.sheetChanges" :key="s.sheetIndex" class="chip">
          第 {{ s.sheetIndex + 1 }} 张：{{ s.before }} → <b>{{ s.after }}</b>
        </span>
      </div>
    </div>

    <div v-if="visible.movedParts.length > 0">
      <div class="k">③ 换了板的板件：</div>
      <div class="chips">
        <span v-for="m in visible.movedParts" :key="m.partId" class="chip">
          {{ m.code }}（{{ m.name }}）×{{ m.qty }}：{{ m.fromBoard }} → <b>{{ m.toBoard }}</b>
        </span>
      </div>
    </div>

    <div v-if="visible.costRows.length > 0">
      <div class="k">④ 材料统计/成本表变动行：</div>
      <table class="grid mini">
        <tbody>
          <tr v-for="(r, i) in visible.costRows" :key="i">
            <td>{{ r.label }}</td>
            <td class="num">{{ r.before }}</td>
            <td class="num">→ <b>{{ r.after }}</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="visible.voided.length > 0" class="voidbox">
      <div class="k">⑤ 已导出的领料单据：</div>
      <div v-for="e in visible.voided" :key="e.issuedOrderId">
        🚫 {{ fmtTime(e.issuedAt) }} 导出的领料单已<b>作废</b>：{{ e.reason }}。请按本次结论重新导出。
      </div>
    </div>
    <div v-else-if="visible.kept.length > 0" class="small muted">
      已导出的 {{ visible.kept.length }} 张领料单指纹一致，继续有效。
    </div>
  </section>
</template>

<style scoped>
.chgpanel {
  border: 1px solid #bfe3cc;
  background: #f6fcf8;
  border-radius: var(--radius);
  padding: 10px 14px;
  margin: 10px 0 14px;
  font-size: 12.5px;
}
.chgpanel.empty {
  border-color: var(--c-line);
  background: #fafcf9;
}
.chgpanel h4 {
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10.5px;
}
.line {
  margin-bottom: 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.k {
  font-weight: 600;
  margin: 8px 0 4px;
  color: #22302a;
}
table.mini {
  font-size: 12px;
}
table.mini th,
table.mini td {
  padding: 3px 7px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  border: 1px solid var(--c-line);
  background: #fff;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11.5px;
}
.voidbox {
  margin-top: 8px;
  border-top: 1px dashed #b6c8bd;
  padding-top: 6px;
  color: var(--c-bad);
}
</style>
