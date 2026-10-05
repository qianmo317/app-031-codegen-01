<script setup lang="ts">
// 三页（板件明细/排样结果/材料统计）共用的选板结论横幅：
// 取数只有 job.result.selection / materialLines 一份，杜绝一处新一处旧。
import { computed } from 'vue'
import { useStore, requisitionsForJob } from '../lib/store'
import { money } from '../lib/format'
import type { Job, MaterialLine, SelectionDiff } from '../types'

const props = defineProps<{ job: Job; compact?: boolean }>()
const { state } = useStore()
const sel = computed(() => props.job.result?.selection)
const lines = computed<MaterialLine[]>(() => props.job.result?.materialLines ?? [])
const diff = computed<SelectionDiff | undefined>(() => sel.value?.lastDiff)

const voidedReqs = computed(() =>
  requisitionsForJob(props.job.id).filter((r) => r.voided && r.revision < (sel.value?.revision ?? 0))
)
const validReq = computed(() => requisitionsForJob(props.job.id).find((r) => !r.voided))

const strategyText = (s: string): string => (s === 'cheapest' ? '先挑最省' : '先挑最大板幅')
const altText = computed(() =>
  sel.value?.alternate
    ? sel.value.alternate.strategy === 'largest'
      ? `对照「先挑最大板幅」：${sel.value.alternate.totalSheets} 张 / ${money(sel.value.alternate.totalCostCents)}（${sel.value.alternate.boardKindCount} 种板）`
      : `对照「先挑最省」：${money(sel.value.alternate.totalCostCents)} / ${sel.value.alternate.totalSheets} 张（${sel.value.alternate.boardKindCount} 种板）`
    : ''
)

function emitAction(): void {
  // 由父页面决定跳转/重算
}
void emitAction
void state
</script>

<template>
  <div v-if="sel" class="sel-banner" :class="sel.status">
    <!-- 出结论 -->
    <template v-if="sel.status === 'conclusion'">
      <div class="row wrap head">
        <span class="ok-mark">✅ 选板结论 · 第 {{ sel.revision }} 版</span>
        <span class="tag">取舍：{{ strategyText(sel.strategy) }}</span>
        <span class="tag">预算 {{ money(sel.budgetCents) }}</span>
        <span class="tag good">总价 {{ money(sel.totalCostCents ?? 0) }}（{{ sel.totalSheets }} 张 / {{ sel.boardKindCount }} 种板）</span>
        <span v-if="validReq" class="tag good">领料单已签发（第 {{ validReq.revision }} 版）</span>
        <div class="spacer" />
      </div>
      <div class="lines">
        <span v-for="l in lines" :key="l.boardId" class="line-chip">
          {{ l.boardName }} ×{{ l.sheets }}
          <em>摊 {{ money(l.priceCents) }}/张 · 小计 {{ money(l.subtotalCents) }}</em>
        </span>
      </div>
      <p v-if="altText" class="small muted">取舍对照：{{ altText }}。
        <b v-if="sel.strategy === 'cheapest'">先挑最省会把同样的件摊到更多种板上，采购与点数更费事、堆场更碎；换「先挑最大板幅」让出的是板种数，代价可能是总价。</b>
        <b v-else>先挑最大板幅容易少买几张却把预算顶穿；换「先挑最省」让出的是总价，代价是板种数可能变多。</b>
      </p>
    </template>

    <!-- 预算不够：给最省方案与差额，不给正式结论 -->
    <template v-else-if="sel.status === 'budget'">
      <div class="row wrap head">
        <span class="bad-mark">⛔ 预算不够（零件都排得下，钱不够）· 未出具选板结论</span>
        <span class="tag">取舍：{{ strategyText(sel.strategy) }}</span>
        <span class="tag">预算 {{ money(sel.budgetCents) }}</span>
        <span class="tag bad">最省 {{ money(sel.cheapestCostCents ?? 0) }}</span>
        <span class="tag bad">还差 {{ money(sel.budgetShortCents ?? 0) }}
          <template v-if="sel.budgetShortSheets">（约 {{ sel.budgetShortSheets }} 张最便宜板的钱）</template>
        </span>
      </div>
      <p class="small">下面的摆法按「不卡预算的最省方案」摆出，仅供核对件数；加预算或删减零件后再出正式结论。</p>
    </template>

    <!-- 板幅不够 / 纹理卡死 -->
    <template v-else-if="sel.status === 'blocked'">
      <div class="row wrap head">
        <span class="bad-mark">⛔ {{ sel.blockKind === 'grain' ? '纹理要求卡死' : '板幅不够' }} · 未出具选板结论</span>
        <span class="tag">取舍：{{ strategyText(sel.strategy) }}</span>
      </div>
      <p class="small">{{ sel.message }}</p>
      <ul v-if="sel.blockedItems?.length" class="blocked-list">
        <li v-for="b in sel.blockedItems" :key="b.partId" :class="b.kind">
          <b>{{ b.code }}（{{ b.name }}）×{{ b.qty }}</b>
          <span class="tag" :class="b.kind">{{ b.kind === 'grain' ? '纹理卡死' : '板幅不够' }}</span>
          <span class="muted small">{{ b.reason }}</span>
        </li>
      </ul>
    </template>

    <!-- 不给结论：零零件 / 预算 0 -->
    <template v-else-if="sel.status === 'inconclusive'">
      <div class="row wrap head">
        <span class="warn-mark">⚠️ 暂不出结论</span>
        <span class="tag" :class="sel.blockKind">{{
          sel.blockKind === 'empty' ? '没有板件' : sel.blockKind === 'zero-budget' ? '预算为 0' : '前置条件缺失'
        }}</span>
      </div>
      <p class="small">{{ sel.message }}</p>
    </template>

    <!-- 已作废的旧领料单 -->
    <div v-for="r in voidedReqs.slice(0, 2)" :key="r.id" class="void-line">
      🗑 本机存档中第 {{ r.revision }} 版领料单（{{ new Date(r.issuedAt).toLocaleString('zh-CN') }}）已作废：{{ r.voidReason }}
    </div>

    <!-- 变化清单：逐行板种/张数、逐件换板、逐张摆法、成本行 -->
    <details v-if="diff && (diff.boardLines.length || diff.movedParts.length || diff.paramChanges.length)" class="diff-box">
      <summary>本次重算变化清单（较第 {{ Math.max(1, sel.revision - 1) }} 版）</summary>
      <div v-if="diff.paramChanges.length" class="diff-sec">
        <b>输入变化：</b>
        <span v-for="(c, i) in diff.paramChanges" :key="i" class="tag">{{ c }}</span>
      </div>
      <div v-if="diff.boardLines.length" class="diff-sec">
        <b>板种/张数变了的行：</b>
        <table class="mini">
          <tr v-for="(b, i) in diff.boardLines" :key="i">
            <td>{{ b.boardName }}</td>
            <td>{{ b.before === null ? '无' : b.before + ' 张' }} → <b>{{ b.after === null ? '删除' : b.after + ' 张' }}</b></td>
            <td v-if="b.priceChanged" class="muted">板价也变了</td>
          </tr>
        </table>
      </div>
      <div v-if="diff.movedParts.length" class="diff-sec">
        <b>换了板的零件（{{ diff.movedParts.length }} 件）：</b>
        <span v-for="(m, i) in diff.movedParts.slice(0, 30)" :key="i" class="move-chip">
          {{ m.code }}：{{ m.fromBoard }} → {{ m.toBoard }}
        </span>
        <span v-if="diff.movedParts.length > 30" class="muted small">…等 {{ diff.movedParts.length }} 件</span>
      </div>
      <div class="diff-sec">
        <b>每张板的摆法：</b>
        <span class="muted small">{{ diff.sheetsChanged.filter((x) => x.changed).length }}/{{ diff.sheetsChanged.length }} 张已重算</span>
      </div>
      <div v-if="diff.costRows.length" class="diff-sec">
        <b>领料单据 / 成本表变化行：</b>
        <table class="mini">
          <tr v-for="(r2, i) in diff.costRows" :key="i">
            <td>{{ r2.boardName }}</td>
            <td>{{ r2.beforeSubtotalCents === null ? '无' : money(r2.beforeSubtotalCents) }}
              → <b>{{ r2.afterSubtotalCents === null ? '删除' : money(r2.afterSubtotalCents) }}</b></td>
          </tr>
        </table>
        <span>成本合计变化 <b :class="diff.costDeltaCents > 0 ? 'up' : 'down'">
          {{ diff.costDeltaCents >= 0 ? '+' : '' }}{{ money(diff.costDeltaCents) }}
        </b></span>
      </div>
      <p class="small muted">
        板种数 {{ diff.boardKindCountBefore }} → {{ diff.boardKindCountAfter }}；
        结论{{ diff.revisionBump ? '已升版（旧版领料单作废重来）' : '实质未变（沿用版次）' }}。
      </p>
    </details>
  </div>
</template>

<style scoped>
.sel-banner {
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border: 1px solid var(--c-line);
  background: #f7faf7;
}
.sel-banner.conclusion { border-color: #9ed3be; background: #f0faf6; }
.sel-banner.budget { border-color: #eecfcf; background: #fff6f5; }
.sel-banner.blocked { border-color: #eecfcf; background: #fff6f5; }
.sel-banner.inconclusive { border-color: #f0d9b5; background: #fffbeb; }
.head { gap: 8px; margin-bottom: 6px; }
.ok-mark { font-weight: 700; color: #14745a; }
.bad-mark { font-weight: 700; color: var(--c-bad); }
.warn-mark { font-weight: 700; color: #92600a; }
.lines { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.line-chip {
  font-size: 12px;
  background: #fff;
  border: 1px solid #bfe3d6;
  border-radius: 999px;
  padding: 3px 10px;
}
.line-chip em { color: var(--c-ink-2); font-style: normal; margin-left: 4px; font-size: 11px; }
.blocked-list { margin: 4px 0; padding-left: 18px; }
.blocked-list li { font-size: 12px; margin: 2px 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.blocked-list li.grain b { color: #b45309; }
.tag.bad { color: var(--c-bad); border-color: #eecfcf; }
.tag.good { color: #14745a; border-color: #9ed3be; }
.tag.grain { color: #b45309; border-color: #f0d9b5; }
.tag.size { color: var(--c-bad); border-color: #eecfcf; }
.void-line {
  margin-top: 6px;
  font-size: 12px;
  color: #92600a;
  background: #fffbeb;
  border: 1px dashed #e5cf9a;
  border-radius: 6px;
  padding: 5px 9px;
}
.diff-box { margin-top: 8px; border-top: 1px dashed var(--c-line); padding-top: 6px; font-size: 12px; }
.diff-box summary { cursor: pointer; font-weight: 600; }
.diff-sec { margin: 5px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
table.mini { border-collapse: collapse; font-size: 12px; }
table.mini td { border: 1px solid var(--c-line-soft); padding: 2px 8px; }
.move-chip { background: #fff; border: 1px solid var(--c-line-soft); border-radius: 4px; padding: 1px 7px; font-size: 11px; }
.up { color: var(--c-bad); }
.down { color: #14745a; }
.spacer { flex: 1; }
</style>
