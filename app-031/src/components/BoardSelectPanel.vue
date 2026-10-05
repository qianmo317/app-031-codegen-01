<script setup lang="ts">
// 选板反算结论（板件明细页 / 排样结果页 / 材料统计页共用同一份 boardSelect 报告）
import { computed } from 'vue'
import type { BoardSelectReport } from '../types'
import { money } from '../lib/format'
import { PRECISION_NOTE } from '../lib/boardSelect'

const props = defineProps<{
  report: BoardSelectReport | null | undefined
  compact?: boolean
  showSteps?: boolean
}>()

const plan = computed(() => props.report?.plan ?? null)
const refPlan = computed(() => props.report?.referencePlan ?? null)
const budgetText = computed(() => {
  const b = props.report?.budgetCents
  if (b === undefined || b < 0) return '不设限'
  if (b === 0) return '¥0.00（为零，不下结论）'
  return money(b)
})
const blockMeta: Record<string, { label: string; cls: string }> = {
  budget: { label: '预算不够', cls: 'bad' },
  size: { label: '板幅/库存不够', cls: 'warn' },
  grain: { label: '纹理要求卡死', cls: 'warn' },
  spec: { label: '指定板种/厚度对不上', cls: 'bad' }
}
const partBlockers = computed(() => props.report?.blockers.filter((b) => b.partId) ?? [])
const budgetBlocker = computed(() => props.report?.blockers.find((b) => b.block === 'budget') ?? null)
</script>

<template>
  <section v-if="report" class="bspanel" :class="{ compact }">
    <!-- 可行 -->
    <div v-if="report.status === 'feasible' && plan" class="head ok">
      <div class="title">
        ✅ 选板结论：买 <b>{{ plan.boardKinds }}</b> 种板、共 <b>{{ plan.boardsUsed }}</b> 张，
        板材花费 <b class="money">{{ money(plan.totalCostCents) }}</b>
      </div>
      <div class="sub">
        策略：{{ report.strategy === 'cheapest' ? '先挑最省' : '先挑板幅最大' }} ·
        预算 {{ budgetText }} ·
        毛面积 {{ (plan.totalAreaMm2 / 1e6).toFixed(2) }}m² ·
        试排组合 {{ report.evaluatedCandidates }} 种（{{ report.elapsedMs }}ms）
      </div>
    </div>

    <!-- 卡点 -->
    <div v-else-if="report.status === 'blocked'" class="head blocked">
      <template v-if="budgetBlocker">
        <div class="title">⛔ {{ budgetBlocker.detail }}</div>
        <div class="sub">该结论只看板材花费；下面列出最省参考方案，不得据此领料。</div>
      </template>
      <template v-else>
        <div class="title">⛔ 这批件排不进现有板材，加钱也买不通，先解决下面的卡点：</div>
      </template>
    </div>

    <!-- 不下结论（零件为空 / 预算为零） -->
    <div v-else class="head inconclusive">
      <div class="title">㊁ 选板暂无结论</div>
      <div class="sub">按规则：板件一件都没排下或预算为零时不给选板结论，请看下方判定步骤卡在哪一步。</div>
    </div>

    <!-- 卡点明细（板幅/纹理/板种） -->
    <div v-if="partBlockers.length > 0" class="blockers">
      <div v-for="b in partBlockers" :key="b.partId" class="block-row">
        <span class="tag" :class="blockMeta[b.block]?.cls">{{ blockMeta[b.block]?.label ?? b.block }}</span>
        <b>{{ b.code }}（{{ b.name }}）×{{ b.qty }}</b>
        <span class="muted small">{{ b.detail }}</span>
      </div>
      <div v-if="report.gap" class="gap-line">↳ {{ report.gap.text }}</div>
    </div>

    <!-- 采纳计划 / 最省参考 -->
    <table v-if="plan || refPlan" class="grid plan-table">
      <thead>
        <tr>
          <th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="it in (plan?.items ?? refPlan?.items ?? [])" :key="it.boardId">
          <td>
            {{ it.boardName }}
            <span v-if="it.isOffcut" class="tag good">余料板</span>
          </td>
          <td>{{ it.wMm }}×{{ it.hMm }}</td>
          <td>{{ it.thicknessMm }}</td>
          <td>{{ it.sheets }}</td>
          <td>{{ money(it.priceCents) }}</td>
          <td>{{ money(it.subtotalCents) }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="5">
            <b>{{ plan ? '板材成本合计' : '最省参考方案合计（不可领料）' }}</b>
          </td>
          <td><b>{{ money(plan?.totalCostCents ?? refPlan?.totalCostCents ?? 0) }}</b></td>
        </tr>
        <tr v-if="plan && report.budgetCents > 0">
          <td colspan="5">预算余量</td>
          <td :class="(report.budgetCents - plan.totalCostCents) < 0 ? 'neg' : ''">
            {{ money(report.budgetCents - plan.totalCostCents) }}
          </td>
        </tr>
      </tfoot>
    </table>

    <!-- 判定路径 -->
    <details v-if="showSteps ?? !compact" class="steps" :open="showSteps">
      <summary>判定路径（{{ report.steps.length }} 步）与计量口径</summary>
      <ol>
        <li v-for="(s, i) in report.steps" :key="i">{{ s }}</li>
      </ol>
      <p class="small muted">{{ PRECISION_NOTE }}</p>
    </details>
    <p v-else class="small muted precision-line">{{ PRECISION_NOTE }}</p>
  </section>
</template>

<style scoped>
.bspanel {
  border: 1px solid var(--c-line);
  border-radius: var(--radius);
  background: #fff;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.head .title {
  font-size: 15px;
}
.head .sub {
  font-size: 12px;
  color: var(--c-ink-2);
  margin-top: 3px;
}
.head.ok .title {
  color: #14532d;
}
.head.ok .money {
  color: var(--c-primary);
  font-size: 17px;
}
.head.blocked .title {
  color: var(--c-bad);
}
.head.inconclusive .title {
  color: var(--c-warn);
}
.plan-table {
  margin-top: 10px;
  font-size: 12.5px;
}
.plan-table th,
.plan-table td {
  padding: 4px 8px;
}
.blockers {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.block-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 13px;
}
.gap-line {
  font-size: 12.5px;
  color: var(--c-warn);
  padding-left: 60px;
}
.neg {
  color: var(--c-bad);
}
.steps {
  margin-top: 10px;
  font-size: 12.5px;
}
.steps ol {
  margin: 6px 0 6px 20px;
  padding: 0;
}
.steps li {
  margin-bottom: 3px;
  color: #33413c;
}
.precision-line {
  margin: 8px 0 0;
}
.compact .plan-table {
  max-width: 720px;
}
</style>
