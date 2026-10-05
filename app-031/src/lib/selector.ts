// 选板与花费反算（接活前定板种、买几张）
//
// 关键纪律（需求强约束）：
// 1. 这里只做「枚举板种子集 → 调同一个排样内核 nestJob → 按钱/张数挑方案」，
//    余隙、四周修边、纹理朝向、guillotine 贯通合法性全部走 packing.ts / packing-core.ts，
//    不允许另写一套只给选板用的孤立装箱算法。
// 2. 选出来的板种与张数就是 job.result.materialLines（板件明细页、排样结果页、
//    材料统计页、领料单四处消费同一份数据）。
// 3. 失败分型：纹理卡死 grain / 板幅不够 size / 预算不够 budget；
//    零零件或预算为零 → 不出结论（inconclusive），要讲清卡在哪一步。
import type {
  Board,
  Job,
  NestResult,
  Part,
  SelectBlockKind,
  SelectionDiff,
  SelectionState,
  SelectInputSnapshot,
  SelectStrategy
} from '../types'
import { nestJob } from './packing'
import { blockKind, boardMatchesPart, canPlaceOnBoard, normalizeBoard } from './packing-core'

// 板种子集枚举上限：板种很多（>8）时不再 2^n 全枚举，改为贪心候选，避免组合爆炸
const MAX_SUBSETS = 256

interface Feasible {
  boardIds: Set<string>
  result: NestResult
}

export interface SelectOutcome {
  /** 出结论（含预算不够时的最省对照结果）才会有 result */
  result?: NestResult
  selection: SelectionState
  snapshot: SelectInputSnapshot
}

function makeSnapshot(job: Job): SelectInputSnapshot {
  return {
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    budgetCents: job.budgetCents,
    strategy: job.strategy,
    boards: job.boards.map((b) => ({
      id: b.id,
      name: b.name,
      wMm: b.wMm,
      hMm: b.hMm,
      thicknessMm: b.thicknessMm,
      priceCents: b.priceCents
    })),
    parts: job.parts.map((p) => ({
      id: p.id,
      lenMm: p.lenMm,
      widMm: p.widMm,
      qty: p.qty,
      grain: p.grain,
      boardId: p.boardId,
      thicknessMm: p.thicknessMm
    })),
    useOffcutIds: [...job.useOffcutIds],
    batchByCabinet: job.batchByCabinet
  }
}

/** 先挑最省：总价低者胜；平手比张数，再平手比板种数（少点采购点数）。 */
function rankCheapest(r: NestResult): number[] {
  return [r.totalCostCents, r.boardsUsed, r.materialLines.length]
}
/** 先挑最大板幅：张数少者胜（少买几张、堆场简单）；平手比总价，再比板种数。 */
function rankLargest(r: NestResult): number[] {
  return [r.boardsUsed, r.totalCostCents, r.materialLines.length]
}
function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv
  }
  return false
}

/** 展开零件实例（与 packing.ts 的 qty 展开口径一致）。 */
function expandParts(parts: Part[]): Part[] {
  const out: Part[] = []
  for (const p of parts) {
    for (let k = 0; k < Math.max(0, p.qty); k++) out.push(p)
  }
  return out
}

/**
 * 枚举手头能用的板种：
 * - 被零件指定的板（boardId / 指定厚度）必须在候选里（缺失即无法满足）
 * - 勾选的余料板一律带入（零成本，排得上就省）
 * - 其余常规板按价格升序（枚举预算紧张时优先试便宜板）
 */
function candidateBoards(
  job: Job,
  effectiveBoards: Board[]
): { all: Board[]; optional: Board[]; requiredIds: Set<string> } {
  const norm = effectiveBoards.map(normalizeBoard)
  const defs = new Map(norm.map((b) => [b.id, b] as const))
  const requiredIds = new Set<string>()
  for (const p of job.parts) {
    if (p.boardId && defs.has(p.boardId)) requiredIds.add(p.boardId)
  }
  const used = new Set<string>(requiredIds)
  // 勾选余料强制参与
  for (const b of norm) {
    if (b.kind === 'offcut') {
      requiredIds.add(b.id)
      used.add(b.id)
    }
  }
  const optional = norm
    .filter((b) => !used.has(b.id) && b.kind !== 'offcut')
    .sort((a, b) => a.priceCents - b.priceCents || b.wMm * b.hMm - a.wMm * a.hMm)
  return { all: norm, optional, requiredIds }
}

function enumerateSubsets(
  required: Board[],
  optional: Board[]
): { ids: string[]; boards: Board[] }[] {
  const baseIds = required.map((b) => b.id)
  if (Math.pow(2, optional.length) <= MAX_SUBSETS) {
    const out: { ids: string[]; boards: Board[] }[] = []
    const n = optional.length
    for (let mask = 0; mask < 1 << n; mask++) {
      const picked = optional.filter((_, i) => (mask >> i) & 1)
      out.push({ ids: [...baseIds, ...picked.map((b) => b.id)], boards: [...required, ...picked] })
    }
    return out
  }
  // 板种过多：贪心候选（全量 + 逐板剔除 + 价格前缀），保证不组合爆炸
  const sets: { ids: string[]; boards: Board[] }[] = [
    { ids: [...baseIds, ...optional.map((b) => b.id)], boards: [...required, ...optional] }
  ]
  for (const b of optional) {
    const boards = [...required, ...optional.filter((x) => x.id !== b.id)]
    sets.push({ ids: boards.map((x) => x.id), boards })
  }
  for (let k = 1; k <= Math.min(optional.length, 4); k++) {
    const boards = [...required, ...optional.slice(0, k)]
    sets.push({ ids: boards.map((x) => x.id), boards })
  }
  return sets
}

/** 这个子集里每件至少有一张「对得上且几何/纹理放得下」的板；否则跳过，不浪费一次排样。 */
function subsetCanFitAll(job: Job, subset: Board[]): boolean {
  const defs = new Map(subset.map((b) => [b.id, b] as const))
  for (const p of expandParts(job.parts)) {
    const ok = subset.some(
      (b) => boardMatchesPart(b, p, defs) && canPlaceOnBoard(p, b, job.kerfMm, job.trimMm)
    )
    if (!ok) return false
  }
  return true
}

/** 在不卡预算的前提下，用另一策略对同一批可行方案重排，给出取舍对照。 */
function alternateResult(
  job: Job,
  feasible: Feasible[],
  altStrategy: SelectStrategy
): NestResult | null {
  if (feasible.length === 0) return null
  const rank = altStrategy === 'cheapest' ? rankCheapest : rankLargest
  let best = feasible[0].result
  for (const f of feasible) {
    if (better(rank(f.result), rank(best))) best = f.result
  }
  // 用另一策略在同一板种集合上再跑一次内核（摆法可能不同，张数/钱也可能变）
  const winner = feasible.find((f) => f.result === best)
  if (!winner) return null
  return nestJob(job, { restrictBoardIds: [...winner.boardIds], preference: altStrategy })
}

/** 与上一版结论逐条比对，列出哪几行板种/张数、哪几件、哪些成本行变了。 */
export function diffResults(
  prev: { result: NestResult; snapshot: SelectInputSnapshot } | null,
  nextResult: NestResult,
  paramChanges: string[],
  revisionBump: boolean
): SelectionDiff {
  const prevLines = new Map(
    (prev?.result.materialLines ?? []).map((l) => [l.boardId, l] as const)
  )
  const nextLines = new Map(nextResult.materialLines.map((l) => [l.boardId, l] as const))
  const boardLines: SelectionDiff['boardLines'] = []
  const costRows: SelectionDiff['costRows'] = []
  const allIds = new Set([...prevLines.keys(), ...nextLines.keys()])
  let costDelta = 0
  for (const id of allIds) {
    const a = prevLines.get(id)
    const b = nextLines.get(id)
    const name = b?.boardName ?? a!.boardName
    const sheetsChanged = (a?.sheets ?? null) !== (b?.sheets ?? null)
    const priceChanged =
      !!a && !!b && (a.priceCents !== b.priceCents || a.boardName !== b.boardName)
    if (sheetsChanged || priceChanged || (!a && b) || (a && !b)) {
      boardLines.push({
        boardName: name,
        before: a ? a.sheets : null,
        after: b ? b.sheets : null,
        priceChanged
      })
    }
    const beforeSub = a ? a.subtotalCents : null
    const afterSub = b ? b.subtotalCents : null
    if (beforeSub !== afterSub) costRows.push({ boardName: name, beforeSubtotalCents: beforeSub, afterSubtotalCents: afterSub })
    costDelta += (afterSub ?? 0) - (beforeSub ?? 0)
  }
  // 换了板的零件：按实例号比对所在板名
  const prevPlacements = new Map(
    (prev?.result.sheets ?? []).flatMap((s) =>
      s.placements.map((p) => [p.instanceId, { code: p.code, name: p.name, board: s.boardName }] as const)
    )
  )
  const movedParts: SelectionDiff['movedParts'] = []
  for (const s of nextResult.sheets) {
    for (const p of s.placements) {
      const before = prevPlacements.get(p.instanceId)
      if (before && before.board !== s.boardName) {
        movedParts.push({
          instanceId: p.instanceId,
          code: p.code,
          name: p.name,
          fromBoard: before.board,
          toBoard: s.boardName
        })
      }
    }
  }
  // 每张板摆法是否重算：同序号板同名且零件实例集合一致才视为没变
  const sheetsChanged: SelectionDiff['sheetsChanged'] = nextResult.sheets.map((s) => {
    const ps = prev?.result.sheets[s.index]
    const sameName = ps?.boardName === s.boardName
    const setA = new Set(ps?.placements.map((p) => p.instanceId) ?? [])
    const setB = new Set(s.placements.map((p) => p.instanceId)
    )
    const sameSet = setA.size === setB.size && [...setB].every((x) => setA.has(x))
    return { index: s.index, boardName: s.boardName, changed: !(sameName && sameSet) }
  })
  return {
    paramChanges,
    boardLines,
    movedParts,
    sheetsChanged,
    costRows,
    costDeltaCents: costDelta,
    boardKindCountBefore: prev?.result.materialLines.length ?? 0,
    boardKindCountAfter: nextResult.materialLines.length,
    revisionBump
  }
}

export function snapshotChanges(prev: SelectInputSnapshot, next: SelectInputSnapshot): string[] {
  const out: string[] = []
  if (prev.kerfMm !== next.kerfMm) out.push(`锯路 ${prev.kerfMm}mm → ${next.kerfMm}mm`)
  if (prev.trimMm !== next.trimMm) out.push(`四周修边 ${prev.trimMm}mm → ${next.trimMm}mm`)
  if (prev.budgetCents !== next.budgetCents)
    out.push(`板材预算 ¥${(prev.budgetCents / 100).toFixed(2)} → ¥${(next.budgetCents / 100).toFixed(2)}`)
  if (prev.strategy !== next.strategy)
    out.push(`选板取舍：${prev.strategy === 'cheapest' ? '先挑最省' : '先挑最大板幅'} → ${next.strategy === 'cheapest' ? '先挑最省' : '先挑最大板幅'}`)
  if (prev.batchByCabinet !== next.batchByCabinet) out.push('按柜体批次分组设置变更')
  if (JSON.stringify(prev.useOffcutIds.slice().sort()) !== JSON.stringify(next.useOffcutIds.slice().sort()))
    out.push('勾选参与的登记余料变更')
  const pb = new Map(prev.boards.map((b) => [b.id, b] as const))
  const nb = new Map(next.boards.map((b) => [b.id, b] as const))
  for (const [id, b] of nb) {
    const a = pb.get(id)
    if (!a) {
      out.push(`新增板材：${b.name}`)
      continue
    }
    if (a.priceCents !== b.priceCents)
      out.push(`板价调整：${b.name} ¥${(a.priceCents / 100).toFixed(2)} → ¥${(b.priceCents / 100).toFixed(2)}`)
    if (a.wMm !== b.wMm || a.hMm !== b.hMm)
      out.push(`板幅调整：${b.name} ${a.wMm}×${a.hMm} → ${b.wMm}×${b.hMm}`)
    if (a.thicknessMm !== b.thicknessMm) out.push(`厚度调整：${b.name}`)
    if (a.name !== b.name) out.push(`板材改名：${a.name} → ${b.name}`)
  }
  for (const [id, b] of pb) {
    if (!nb.has(id)) out.push(`删除板材：${b.name}`)
  }
  const pp = new Map(prev.parts.map((p) => [p.id, p] as const))
  const np = new Map(next.parts.map((p) => [p.id, p] as const))
  for (const [id, p] of np) {
    const a = pp.get(id)
    if (!a) {
      out.push(`新增/改号零件 ${id.slice(-4)}`)
      continue
    }
    if (
      a.lenMm !== p.lenMm ||
      a.widMm !== p.widMm ||
      a.qty !== p.qty ||
      a.grain !== p.grain ||
      a.boardId !== p.boardId ||
      a.thicknessMm !== p.thicknessMm
    )
      out.push(`零件 ${id.slice(-4)} 的尺寸/数量/纹理/指定板变更`)
  }
  for (const [id] of pp) {
    if (!np.has(id)) out.push(`删除零件 ${id.slice(-4)}`)
  }
  return out
}

/** 取最便宜的「能容纳某件」常规板单价（供「还差几张」折算）。 */
function cheapestBoardPriceCents(job: Job): number {
  const prices = job.boards.filter((b) => b.kind !== 'offcut').map((b) => b.priceCents)
  return prices.length > 0 ? Math.min(...prices) : 0
}

/**
 * 主入口：给定一批零件与板材花费上限，反算用哪几种板、各买几张。
 * effectiveBoards：已并入勾选余料的板列表（store 层负责并入）。
 */
export function selectBoards(
  job: Job,
  effectiveBoards: Board[],
  prev: { result: NestResult; snapshot: SelectInputSnapshot; revision: number } | null
): SelectOutcome {
  const snapshot = makeSnapshot(job)
  const strategy: SelectStrategy = job.strategy
  const budget = Math.max(0, Math.round(job.budgetCents || 0))
  const totalInstances = expandParts(job.parts).length
  const now = Date.now()

  const inconclusive = (blockKind2: SelectBlockKind, message: string): SelectOutcome => ({
    selection: {
      budgetCents: budget,
      strategy,
      revision: prev?.revision ?? 0,
      status: 'inconclusive',
      blockKind: blockKind2,
      message,
      generatedAt: now,
      prevSnapshot: snapshot
    },
    snapshot
  })

  // 一件都没有：不允许给出结论
  if (job.parts.length === 0 || totalInstances === 0) {
    return inconclusive('empty', '零件清单为空（一件都没有）：先录入要切的板件，才能选板与反算花费。')
  }
  // 预算为零：不允许给出结论，哪怕余料板不要钱（需求明确）
  if (budget <= 0) {
    return inconclusive('zero-budget', '板材花费上限为 0：未给预算无法判断「超不超」，请先填本批板材预算（元），再选板。')
  }
  if (effectiveBoards.length === 0) {
    return inconclusive('size', '板材库为空：先在板材库加入常见规格板。')
  }

  // 第一步：几何/纹理/板种厚度预检（与排样内核同一判定）
  const { all, optional } = candidateBoards(job, effectiveBoards)
  const defs = new Map(all.map((b) => [b.id, b] as const))
  const blocked: SelectionState['blockedItems'] = []
  const countById = new Map<string, number>()
  for (const p of expandParts(job.parts)) countById.set(p.id, (countById.get(p.id) ?? 0) + 1)
  for (const p of job.parts) {
    const bk = blockKind(p, all, defs, job.kerfMm, job.trimMm)
    if (bk) {
      blocked.push({
        partId: p.id,
        code: p.code,
        name: p.name,
        qty: countById.get(p.id) ?? p.qty,
        kind: bk.kind,
        reason: bk.reason
      })
    }
  }
  if (blocked.length > 0) {
    // 纹理卡死优先于板幅不够报出（只要存在纹理件就先解纹理）
    const hasGrain = blocked.some((b) => b.kind === 'grain')
    const kind: SelectBlockKind = hasGrain ? 'grain' : 'size'
    const msg = hasGrain
      ? '纹理要求卡死：存在竖纹/横纹件在所有对得上的板上都放不下（不许旋转硬塞），先解这些件。'
      : '板幅不够：存在零件超过所有对得上板种的可用幅面（已扣修边与锯路），换大板或拆件。'
    // 排一次样让排样页能摆出其余件、未排件走同一套原因
    const probe = nestJob(job, { preference: strategy })
    probe.selection = {
      budgetCents: budget,
      strategy,
      revision: prev?.revision ?? 0,
      status: 'blocked',
      blockKind: kind,
      blockedItems: blocked,
      message: msg,
      candidatesTried: 0,
      generatedAt: now,
      prevSnapshot: snapshot
    }
    return { result: probe, selection: probe.selection, snapshot }
  }

  // 第二步：枚举板种子集（被指定板/勾选余料强制带入），每个子集走同一个排样内核
  const requiredIds = requiredIdSet(job, all)
  for (const b of all) if (b.kind === 'offcut') requiredIds.add(b.id)
  const required = all.filter((b) => requiredIds.has(b.id))
  const subsets = enumerateSubsets(required, optional)
  const feasible: Feasible[] = []
  let tried = 0
  for (const sub of subsets) {
    if (!subsetCanFitAll(job, sub.boards)) continue
    tried++
    const r = nestJob(job, { restrictBoardIds: sub.ids, preference: strategy })
    if (r.unplaced.length === 0) feasible.push({ boardIds: new Set(sub.ids), result: r })
  }
  if (feasible.length === 0) {
    // 预检说放得下、装箱却没全放下：交回内核结果并标记，不编造结论
    const probe = nestJob(job, { preference: strategy })
    probe.selection = {
      budgetCents: budget,
      strategy,
      revision: prev?.revision ?? 0,
      status: 'blocked',
      blockKind: 'size',
      message: '几何预检通过但装箱仍有未排件（详见排样页），属于排样内核未铺满，请调整零件或板种。',
      candidatesTried: tried,
      generatedAt: now,
      prevSnapshot: snapshot
    }
    return { result: probe, selection: probe.selection, snapshot }
  }

  // 第三步：按选定策略挑最省/最少张数的方案
  const rank = strategy === 'cheapest' ? rankCheapest : rankLargest
  let winner = feasible[0].result
  for (const f of feasible) if (better(rank(f.result), rank(winner))) winner = f.result

  // 另一策略的取舍对照（只对照、不改结论）
  const altStrategy: SelectStrategy = strategy === 'cheapest' ? 'largest' : 'cheapest'
  const alt = alternateResult(job, feasible, altStrategy)

  const withinBudget = winner.totalCostCents <= budget
  const paramChanges = prev ? snapshotChanges(prev.snapshot, snapshot) : []
  // 先算出逐条 diff，再据此判定要不要升版：
  // 板种/张数变、板价/成本行变、任一零件换板或任一摆法重算，都算「结论变了」，旧领料单要作废
  const priorDiff = prev ? diffResults(prev, winner, paramChanges, false) : null
  const sheetsChangedCount = priorDiff?.sheetsChanged.filter((x) => x.changed).length ?? 0
  const materialChanged = !prev
    ? false
    : !!priorDiff &&
      (priorDiff.boardLines.length > 0 ||
        priorDiff.costRows.length > 0 ||
        priorDiff.movedParts.length > 0 ||
        sheetsChangedCount > 0)
  const revisionBump = !!prev && paramChanges.length > 0 && materialChanged
  const revision = prev ? (revisionBump ? prev.revision + 1 : prev.revision) : 1
  if (priorDiff) priorDiff.revisionBump = revisionBump

  if (!withinBudget) {
    // 预算不够：按最省的那种板算还差多少钱、还差几张。
    // 无论当前策略是什么，预算不够时一律采用全局最省可行解作为展示方案（告诉用户最低门槛），
    // 这样「逐张摆法/换件/成本行」的 diff 与张数都以最省方案为准。
    const cheapestFeasible =
      strategy === 'cheapest'
        ? winner
        : feasible.reduce((m, f) => (better(rankCheapest(f.result), rankCheapest(m)) ? f.result : m), feasible[0].result)
    const shortCents = cheapestFeasible.totalCostCents - budget
    const unit = cheapestBoardPriceCents(job)
    const shortSheets = unit > 0 ? Math.max(1, Math.ceil(shortCents / unit)) : 0
    const budgetDiff = prev ? diffResults(prev, cheapestFeasible, paramChanges, revisionBump) : priorDiff
    cheapestFeasible.selection = {
      budgetCents: budget,
      strategy,
      revision,
      status: 'budget',
      totalCostCents: cheapestFeasible.totalCostCents,
      totalSheets: cheapestFeasible.boardsUsed,
      boardKindCount: cheapestFeasible.materialLines.length,
      blockKind: 'budget',
      cheapestCostCents: cheapestFeasible.totalCostCents,
      budgetShortCents: shortCents,
      budgetShortSheets: shortSheets,
      message:
        `全部板件都排得下，但最省也要 ¥${(cheapestFeasible.totalCostCents / 100).toFixed(2)}，` +
        `超出预算 ¥${(shortCents / 100).toFixed(2)}；` +
        (unit > 0
          ? `按手头最便宜板 ¥${(unit / 100).toFixed(2)}/张折算，预算还差约 ${shortSheets} 张板的钱。`
          : ''),
      candidatesTried: tried,
      generatedAt: now,
      prevSnapshot: snapshot,
      lastDiff: budgetDiff ?? undefined
    }
    return { result: cheapestFeasible, selection: cheapestFeasible.selection, snapshot }
  }

  winner.selection = {
    budgetCents: budget,
    strategy,
    revision,
    status: 'conclusion',
    totalCostCents: winner.totalCostCents,
    totalSheets: winner.boardsUsed,
    boardKindCount: winner.materialLines.length,
    alternate: alt
      ? {
          strategy: altStrategy,
          totalCostCents: alt.totalCostCents,
          totalSheets: alt.boardsUsed,
          boardKindCount: alt.materialLines.length
        }
      : undefined,
    message:
      strategy === 'cheapest'
        ? `已按「先挑最省」定板：${winner.materialLines.length} 种板共 ${winner.boardsUsed} 张，花费 ¥${(
            winner.totalCostCents / 100
          ).toFixed(2)}，在预算 ¥${(budget / 100).toFixed(2)} 内。`
        : `已按「先挑最大板幅」定板：${winner.boardsUsed} 张（${winner.materialLines.length} 种板），花费 ¥${(
            winner.totalCostCents / 100
          ).toFixed(2)}，在预算 ¥${(budget / 100).toFixed(2)} 内。`,
    candidatesTried: tried,
    generatedAt: now,
    // 存的是「产生当前结论的输入快照」，供下一轮逐条比对（链路不断档）
    prevSnapshot: snapshot,
    lastDiff: priorDiff ?? undefined
  }
  return { result: winner, selection: winner.selection, snapshot }
}

function requiredIdSet(job: Job, all: Board[]): Set<string> {
  const ids = new Set<string>()
  const defs = new Map(all.map((b) => [b.id, b] as const))
  for (const p of job.parts) {
    if (p.boardId && defs.has(p.boardId)) ids.add(p.boardId)
  }
  return ids
}
