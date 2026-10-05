// 选板与花费反算
//
// 唯一允许的做法：枚举「买哪几种板」的组合，每种组合都调用 packing.packBoards()
// 完整排一遍——板种/厚度匹配、竖纹横纹朝向、余隙清洁、四周修边、guillotine 贯通
// 合法性全部复用排样内核，本文件不允许出现任何只给选板用的摆放/尺寸判定。
//
// 策略二选一（BoardSelectStrategy，不可兼得）：
// - cheapest 先挑最省：枚举到的可行组合里总价最低；代价是同样的件常被摊到更多种
//   板上，领料、堆场、点数更费事（kinds 更多）。
// - largest 先挑板幅最大：优先张数最少；代价是大板单价高，容易少买几张却顶穿预算。
//
// 计量口径（精度声明）：
// - 面积：一律按平方毫米（mm²，整数）累加，展示时折平方米，四舍五入保留 2 位小数
//   （即 0.01m² = 10000mm² 位）；利用率保留 1 位小数（0.1% 位）。
// - 金额：一律按分（priceCents，整数）累加，小计=单价(分)×张数，全程不做中间
//   四舍五入；展示折元时四舍五入保留 2 位小数（1 分位）。
import type {
  Board,
  BoardSelectBlocker,
  BoardSelectGap,
  BoardSelectItem,
  BoardSelectPlan,
  BoardSelectReport,
  BoardSelectStrategy,
  NestResult,
  Part,
  PlanChange,
  SheetResult
} from '../types'
import {
  boardsAllowedForPart,
  partFitsBoard,
  packBoards,
  type PackOutput
} from './packing'

export const PRECISION_NOTE =
  '面积按平方毫米(mm²)累加，折平方米四舍五入保留 2 位小数（0.01m² 位）；' +
  '金额按分累加、不做中间舍入，折元四舍五入保留 2 位小数（1 分位）；利用率保留 1 位小数。'

export const STRATEGY_NOTE: Record<BoardSelectStrategy, string> = {
  cheapest:
    '先挑最省：可行组合中总价最低。代价是同样的件往往摊到更多种板上，领料、堆场与点数更费事。',
  largest:
    '先挑板幅最大：优先张数最少。代价是大板单价高，容易少买几张却把预算顶穿。'
}

export interface SelectInput {
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  batchByCabinet: boolean
  budgetCents: number // -1=不设限；0=预算为零（不下结论）
  strategy: BoardSelectStrategy
}

interface Candidate {
  pack: PackOutput
  cost: number
  sheets: number
  kinds: number
  subset: ReadonlySet<string>
}

export interface SelectOutcome {
  report: BoardSelectReport
  /** 采纳的排样：可行=策略最优；预算不足=最省参考；板幅/纹理卡死=全目录尽力排；零件为空=null */
  chosenPack: PackOutput | null
  cheapestPack: PackOutput | null
}

const TIME_GUARD_MS = 2000
const PACK_CAP = 620

function totalPartQty(parts: Part[]): number {
  return parts.reduce((a, p) => a + Math.max(0, p.qty), 0)
}

/** 从一次排样产出汇总选板计划（三处页面与领料单统一消费的那一份）。 */
export function planFromPack(pack: PackOutput, strategy: BoardSelectStrategy): BoardSelectPlan {
  const byBoard = new Map<
    string,
    { board: Board; sheets: number; subtotalCents: number; areaMm2: number; firstIndex: number }
  >()
  for (const s of pack.sheets) {
    // SheetResult 上保留了单价（余料板为 0）；板规格从开板对象取
    const cur = byBoard.get(s.boardId)
    if (cur) {
      cur.sheets++
      cur.subtotalCents += s.priceCents
      cur.areaMm2 += s.boardAreaMm2
    } else {
      // pack.sheets 的 boardId 可能来自归一化前对象，id/name/price 仍一致
      byBoard.set(s.boardId, {
        board: {
          id: s.boardId,
          name: s.boardName,
          wMm: s.wMm,
          hMm: s.hMm,
          thicknessMm: s.thicknessMm,
          material: s.material,
          priceCents: s.priceCents,
          quantity: 0,
          kind: s.priceCents === 0 ? 'offcut' : 'stock'
        },
        sheets: 1,
        subtotalCents: s.priceCents,
        areaMm2: s.boardAreaMm2,
        firstIndex: s.index
      })
    }
  }
  const items: BoardSelectItem[] = [...byBoard.values()]
    .map((x) => ({
      boardId: x.board.id,
      boardName: x.board.name,
      material: x.board.material,
      wMm: x.board.wMm,
      hMm: x.board.hMm,
      thicknessMm: x.board.thicknessMm,
      sheets: x.sheets,
      priceCents: x.board.kind === 'offcut' ? 0 : Math.round(x.subtotalCents / x.sheets),
      subtotalCents: x.subtotalCents,
      isOffcut: x.board.kind === 'offcut'
    }))
    .sort((a, b) => {
      if (a.isOffcut !== b.isOffcut) return a.isOffcut ? 1 : -1
      if (b.subtotalCents !== a.subtotalCents) return b.subtotalCents - a.subtotalCents
      return a.boardName.localeCompare(b.boardName, 'zh')
    })
  return {
    strategy,
    items,
    totalCostCents: pack.totalCostCents,
    totalAreaMm2: items.reduce((a, it) => {
      const sh = byBoard.get(it.boardId)!
      return a + sh.areaMm2
    }, 0),
    boardsUsed: pack.sheets.length,
    boardKinds: items.filter((i) => i.sheets > 0).length,
    placedCount: pack.placedCount
  }
}

/** 零件卡点诊断（与排样同一套朝向/余隙/板种口径）。 */
export function diagnosePart(
  boards: Board[],
  p: Part,
  kerf: number,
  trim: number
): 'ok' | 'spec' | 'size' | 'grain' {
  const allowed = boardsAllowedForPart(boards, p)
  if (allowed.length === 0) return 'spec'
  const fits = allowed.some((b) => partFitsBoard(p, b, kerf, trim))
  if (fits) return 'ok'
  // 竖纹/横纹件：唯一朝向在所有对得上的板上都放不进 → 纹理卡死
  if (p.grain !== 'none') {
    // 再确认：无纹理约束（允许旋转）时是否本可放下，能放下才说明纯粹卡在朝向
    const rotatable: Part = { ...p, grain: 'none' }
    const fitsIfRotated = allowed.some((b) => partFitsBoard(rotatable, b, kerf, trim))
    if (fitsIfRotated) return 'grain'
  }
  return 'size'
}

export function selectBoards(input: SelectInput): SelectOutcome {
  const t0 = performance.now()
  const { boards, parts, kerfMm: kerf, trimMm: trim } = input
  const strategy = input.strategy
  const budget = input.budgetCents
  const steps: string[] = []
  const totalQty = totalPartQty(parts)

  const baseReport = {
    budgetCents: budget,
    strategy,
    totalPartQty: totalQty,
    evaluatedCandidates: 0,
    elapsedMs: 0,
    generatedAt: Date.now(),
    steps: [] as string[]
  }

  // —— 步骤 0：零件为零，不下结论 ——
  steps.push(`① 展开板件：${parts.length} 种 / ${totalQty} 件；锯路 ${kerf}mm、四周修边 ${trim}mm。`)
  if (totalQty === 0) {
    steps.push('② 板件一件都没有，不进行选板，也不产生领料/成本结论。')
    const report: BoardSelectReport = {
      ...baseReport,
      ok: false,
      status: 'inconclusive',
      plan: null,
      blockers: [],
      gap: null,
      steps
    }
    report.elapsedMs = Math.round(performance.now() - t0)
    return { report, chosenPack: null, cheapestPack: null }
  }

  // —— 步骤 1：预算为零，不下结论 ——
  if (budget === 0) {
    steps.push('② 板材花费上限为 ¥0.00（预算为零），按规则不给出选板结论；仅做试排查看卡点。')
  } else if (budget < 0) {
    steps.push('② 未设花费上限，只在全部排得下的组合里按策略选板。')
  } else {
    steps.push(`② 板材花费上限 ¥${(budget / 100).toFixed(2)}（${budget} 分）。`)
  }
  steps.push(`③ 选板策略：${strategy === 'cheapest' ? '先挑最省' : '先挑板幅最大'}。${STRATEGY_NOTE[strategy]}`)

  const offcuts = boards.filter((b) => b.kind === 'offcut')
  const stock = boards.filter((b) => b.kind !== 'offcut')

  // —— 步骤 2：全目录尽力排（判断到底排不排得下；任何子集都是它的限制版，不可能更可行）——
  const fullPack = packBoards({
    boards,
    parts,
    kerfMm: kerf,
    trimMm: trim,
    batchByCabinet: input.batchByCabinet,
    policy: strategy
  })
  steps.push(
    `④ 全部 ${stock.length} 种常规板${offcuts.length > 0 ? ` + ${offcuts.length} 块余料小板` : ''}走排样内核试排：` +
      `就位 ${fullPack.placedCount}/${totalQty} 件，开 ${fullPack.sheets.length} 张。`
  )

  // —— 步骤 3：排不下 → 分清 spec / size / grain ——
  if (fullPack.unplacedParts.length > 0) {
    const blockers: BoardSelectBlocker[] = []
    for (const u of fullPack.unplacedParts) {
      const kind0 = diagnosePart(boards, u.part, kerf, trim)
      const kind: BoardSelectBlocker['block'] = kind0 === 'ok' ? 'size' : kind0
      const allowed = boardsAllowedForPart(boards, u.part)
      let detail = ''
      if (kind === 'spec') {
        detail = `指定板种/厚度（板种 ${u.part.boardId || '—'}、厚度 ${u.part.thicknessMm || '不限'}）在板材库里没有对得上的板`
      } else if (kind === 'grain') {
        detail =
          u.part.grain === 'length'
            ? `竖纹件禁止旋转：${u.part.lenMm}×${u.part.widMm}mm 的唯一朝向超出所有对得上板的可用幅面（已扣修边 ${trim}mm）`
            : `横纹件禁止旋转：${u.part.lenMm}×${u.part.widMm}mm 的唯一朝向超出所有对得上板的可用幅面（已扣修边 ${trim}mm）`
      } else {
        detail = `板幅不够：对得上的 ${allowed.length} 种板扣修边后都放不下 ${u.part.lenMm}×${u.part.widMm}mm，或库存张数不足`
      }
      blockers.push({
        block: kind,
        partId: u.part.id,
        code: u.part.code,
        name: u.part.name,
        qty: u.qty,
        detail
      })
    }
    // 「还差几张」：全目录试排中出现的库存缺口，且未排下件确实能上该板
    const gap = computeSheetGap(blocksOnly(blockers, ['size']), fullPack, boards, parts, kerf, trim)
    steps.push(
      `⑤ 判定：${formatBlockKinds(blockers)}卡死，与预算无关；` +
        (gap ? gap.text : '属于板件超幅/纹理朝向问题，加钱也买不通，必须换板幅或放松纹理要求。')
    )
    const report: BoardSelectReport = {
      ...baseReport,
      ok: false,
      status: 'blocked',
      plan: null,
      blockers,
      gap,
      steps,
      evaluatedCandidates: 1
    }
    report.elapsedMs = Math.round(performance.now() - t0)
    return { report, chosenPack: fullPack, cheapestPack: null }
  }

  // 预算为零：结论已定（不下结论），不再枚举花钱组合；摆法保留全目录试排作参考
  if (budget === 0) {
    steps.push('⑤ 不枚举采购组合，全目录试排结果仅用于查看卡点，不得据此领料。')
    const report: BoardSelectReport = {
      ...baseReport,
      ok: false,
      status: 'inconclusive',
      plan: null,
      blockers: [],
      gap: null,
      steps,
      evaluatedCandidates: 1
    }
    report.elapsedMs = Math.round(performance.now() - t0)
    return { report, chosenPack: fullPack, cheapestPack: null }
  }

  // —— 步骤 4：枚举「买哪几种板」组合，每种都完整走一次排样内核 ——
  // 候选常规板：至少有一种对得上的板件用得到它（纯几何放不下的也保留，以暴露卡点）
  const pool = stock.filter((b) => parts.some((p) => boardsAllowedForPart(boards, p).includes(b)))
  // 指定了具体板种的板件：该板种为必选
  const requiredIds = new Set<string>()
  for (const p of parts) {
    if (p.boardId && stock.some((b) => b.id === p.boardId)) requiredIds.add(p.boardId)
  }

  const rankBetter = (a: Candidate, c: Candidate, by: BoardSelectStrategy): number => {
    if (by === 'cheapest') {
      if (a.cost !== c.cost) return a.cost - c.cost
      if (a.sheets !== c.sheets) return a.sheets - c.sheets
    } else {
      if (a.sheets !== c.sheets) return a.sheets - c.sheets
      if (a.cost !== c.cost) return a.cost - c.cost
    }
    if (a.kinds !== c.kinds) return a.kinds - c.kinds
    return a.subset.size - c.subset.size
  }
  const consider = (c: Candidate, best: Candidate | null, by: BoardSelectStrategy): Candidate =>
    best === null || rankBetter(c, best, by) < 0 ? c : best

  const fullCandidate: Candidate = {
    pack: fullPack,
    cost: fullPack.totalCostCents,
    sheets: fullPack.sheets.length,
    kinds: new Set(fullPack.sheets.map((s) => s.boardId)).size,
    subset: new Set(stock.map((b) => b.id))
  }
  let cheapest: Candidate = fullCandidate
  let strategyBest: Candidate = fullCandidate
  let evaluated = 1
  let capped = false
  const deadline = performance.now() + TIME_GUARD_MS

  const coversAll = (subset: ReadonlySet<string>): boolean => {
    // 作用域必须是「子集常规板 + 勾选余料板」，不能用全目录
    const scope = boards.filter((b) => subset.has(b.id))
    for (const p of parts) {
      const okBoard = scope.some(
        (b) =>
          boardsAllowedForPart(scope, p).includes(b) && partFitsBoard(p, b, kerf, trim)
      )
      if (okBoard) continue
      const okOffcut = offcuts.some(
        (b) => boardsAllowedForPart(offcuts, p).includes(b) && partFitsBoard(p, b, kerf, trim)
      )
      if (!okOffcut) return false
    }
    return true
  }

  const evaluate = (subset: Set<string>): void => {
    if (performance.now() > deadline || evaluated >= PACK_CAP) {
      capped = true
      return
    }
    // 每个组合都用「最省」口径排一遍：无论当前策略是什么，预算差额都以真实最省方案为准
    const cheapPack = packBoards({
      boards,
      parts,
      kerfMm: kerf,
      trimMm: trim,
      batchByCabinet: input.batchByCabinet,
      policy: 'cheapest',
      allowBoardIds: subset
    })
    evaluated++
    if (cheapPack.placedCount >= totalQty) {
      cheapest = consider(
        {
          pack: cheapPack,
          cost: cheapPack.totalCostCents,
          sheets: cheapPack.sheets.length,
          kinds: new Set(cheapPack.sheets.map((s) => s.boardId).filter((id) => subset.has(id))).size,
          subset
        },
        cheapest,
        'cheapest'
      )
      if (strategy === 'cheapest') {
        strategyBest = consider(
          {
            pack: cheapPack,
            cost: cheapPack.totalCostCents,
            sheets: cheapPack.sheets.length,
            kinds: new Set(cheapPack.sheets.map((s) => s.boardId).filter((id) => subset.has(id))).size,
            subset
          },
          strategyBest,
          'cheapest'
        )
      }
    }
    // 当前策略是「先板幅最大」时，同一组合再用 largest 口径排一遍（同一内核、同一组合）
    if (strategy === 'largest') {
      if (performance.now() > deadline || evaluated >= PACK_CAP) {
        capped = true
        return
      }
      const largePack = packBoards({
        boards,
        parts,
        kerfMm: kerf,
        trimMm: trim,
        batchByCabinet: input.batchByCabinet,
        policy: 'largest',
        allowBoardIds: subset
      })
      evaluated++
      if (largePack.placedCount >= totalQty) {
        strategyBest = consider(
          {
            pack: largePack,
            cost: largePack.totalCostCents,
            sheets: largePack.sheets.length,
            kinds: new Set(largePack.sheets.map((s) => s.boardId).filter((id) => subset.has(id))).size,
            subset
          },
          strategyBest,
          'largest'
        )
      }
    }
  }

  steps.push(
    `⑤ 枚举买板组合（判定全部复用排样内核：余隙/修边/贯通同一条路径），共 ${pool.length} 种候选常规板。`
  )

  if (pool.length <= 9) {
    // 穷举 2^n（必选板种固定为 1）
    const optional = pool.filter((b) => !requiredIds.has(b.id))
    const recurse = (i: number, subset: Set<string>): void => {
      if (capped) return
      if (i === optional.length) {
        if (coversAll(subset)) evaluate(subset)
        return
      }
      recurse(i + 1, subset)
      const withB = new Set(subset)
      withB.add(optional[i].id)
      recurse(i + 1, withB)
    }
    recurse(0, new Set(requiredIds))
  } else {
    // 板种过多：每步贪心加入「对当前策略最有利」的板，多起点；再补若干随机组合
    capped = true
    const greedyFrom = (seed: Set<string>): void => {
      const subset = new Set(seed)
      let guard = 0
      while (guard++ <= pool.length) {
        if (coversAll(subset)) {
          evaluate(new Set(subset))
          return
        }
        // 覆盖还没全：优先加入能新覆盖最多板件的板（作用域=子集+余料）
        const scopeNow = boards.filter(
          (b) => subset.has(b.id) || b.kind === 'offcut'
        )
        const uncovered = parts.filter(
          (p) =>
            !scopeNow.some(
              (b) =>
                boardsAllowedForPart(scopeNow, p).includes(b) && partFitsBoard(p, b, kerf, trim)
            )
        )
        let bestAdd: Board | null = null
        let bestScore = -1
        for (const b of pool) {
          if (subset.has(b.id)) continue
          const scopeTry = [...scopeNow, b]
          const covers = uncovered.filter(
            (p) => boardsAllowedForPart(scopeTry, p).includes(b) && partFitsBoard(p, b, kerf, trim)
          ).length
          if (covers === 0) continue
          const score =
            strategy === 'cheapest'
              ? covers * 100000 - b.priceCents / 100
              : covers * 100000 + (b.wMm * b.hMm) / 1e6
          if (score > bestScore) {
            bestScore = score
            bestAdd = b
          }
        }
        if (!bestAdd) return
        subset.add(bestAdd.id)
      }
    }
    greedyFrom(new Set(requiredIds))
    for (const b of pool) greedyFrom(new Set([...requiredIds, b.id]))
  }

  const feasible = cheapest.pack.placedCount >= totalQty
  steps.push(
    `⑥ 实际试排 ${evaluated} 种组合${capped ? '（触发组合数/耗时上限，保留当前最优；各组合判定仍全部走排样内核）' : '（已穷举）'}：` +
      `最省方案 ${cheapest.sheets} 张/${cheapest.kinds} 种板、¥${(cheapest.cost / 100).toFixed(2)}；` +
      `所选策略（${strategy === 'cheapest' ? '先最省' : '先板幅最大'}）方案 ` +
      `${strategyBest.sheets} 张/${strategyBest.kinds} 种板、¥${(strategyBest.cost / 100).toFixed(2)}。`
  )
  if (!feasible) {
    // 理论上不会到这（全目录已排下），防御性处理
    const report: BoardSelectReport = {
      ...baseReport,
      ok: false,
      status: 'blocked',
      plan: null,
      blockers: [],
      gap: null,
      steps,
      evaluatedCandidates: evaluated
    }
    return { report, chosenPack: fullPack, cheapestPack: null }
  }

  // —— 步骤 5：预算闸门（budget=0 已在枚举前短路） ——
  if (budget > 0 && cheapest.cost > budget) {
    const gap: BoardSelectGap = {
      kind: 'money',
      shortCents: cheapest.cost - budget,
      budgetCents: budget,
      cheapestCents: cheapest.cost,
      text:
        `预算不够：最省方案也要 ¥${(cheapest.cost / 100).toFixed(2)}，` +
        `上限 ¥${(budget / 100).toFixed(2)}，还差 ¥${((cheapest.cost - budget) / 100).toFixed(2)}` +
        `（${cheapest.cost - budget} 分）。加钱或删减板件后再选；先板幅最大的方案不会更省。`
    }
    steps.push('⑦ ' + gap.text)
    const report: BoardSelectReport = {
      ...baseReport,
      ok: false,
      status: 'blocked',
      plan: null,
      referencePlan: planFromPack(cheapest.pack, 'cheapest'),
      blockers: [{ block: 'budget', partId: '', code: '', name: '', qty: 0, detail: gap.text }],
      gap,
      steps,
      evaluatedCandidates: evaluated
    }
    report.elapsedMs = Math.round(performance.now() - t0)
    // 摆法取最省方案（参考），让师傅直接看到差多少钱对应的那套摆法
    return { report, chosenPack: cheapest.pack, cheapestPack: cheapest.pack }
  }

  // —— 步骤 6：采纳策略最优方案 ——
  const chosen = strategyBest
  const plan = planFromPack(chosen.pack, strategy)
  steps.push(
    `⑦ 采纳${strategy === 'cheapest' ? '最省' : '板幅最大（张数最少）'}方案：${plan.boardKinds} 种板、${plan.boardsUsed} 张、` +
      `¥${(plan.totalCostCents / 100).toFixed(2)}` +
      (budget > 0
        ? `（预算 ¥${(budget / 100).toFixed(2)}，余 ¥${((budget - plan.totalCostCents) / 100).toFixed(2)}）`
        : '（未设预算）') +
      `；购入毛面积 ${(plan.totalAreaMm2 / 1e6).toFixed(2)}m²（面积按 mm² 累加折 m² 保留 2 位；金额按分累加折元保留 2 位）。`
  )
  if (strategy === 'cheapest' && plan.boardKinds > 1) {
    steps.push(
      `附注：最省方案摊到了 ${plan.boardKinds} 种板，领料与堆场更费事；改走「先板幅最大」可少板种，但总价不一定更低。`
    )
  }
  const report: BoardSelectReport = {
    ...baseReport,
    ok: true,
    status: 'feasible',
    plan,
    blockers: [],
    gap: null,
    steps,
    evaluatedCandidates: evaluated
  }
  report.elapsedMs = Math.round(performance.now() - t0)
  return { report, chosenPack: chosen.pack, cheapestPack: cheapest.pack }
}

function blocksOnly(
  blockers: BoardSelectBlocker[],
  kinds: BoardSelectBlocker['block'][]
): BoardSelectBlocker[] {
  return blockers.filter((b) => kinds.includes(b.block))
}

function formatBlockKinds(blockers: BoardSelectBlocker[]): string {
  const has = (k: BoardSelectBlocker['block']): boolean => blockers.some((b) => b.block === k)
  const names: string[] = []
  if (has('spec')) names.push('指定板种/厚度无对应板')
  if (has('grain')) names.push('纹理朝向')
  if (has('size')) names.push('板幅/库存')
  return names.join('、') || '未知原因'
}

/** 板幅类卡点时，按最省的可用板种算「还差几张」（仅有限量库存时有意义）。 */
function computeSheetGap(
  sizeBlockers: BoardSelectBlocker[],
  pack: PackOutput,
  boards: Board[],
  parts: Part[],
  kerf: number,
  trim: number
): BoardSelectGap | null {
  if (sizeBlockers.length === 0) return null
  const blockedPartIds = new Set(sizeBlockers.map((b) => b.partId))
  const shortageBoards = boards
    .filter((b) => b.kind !== 'offcut' && b.quantity > 0)
    .map((b) => ({ b, need: pack.openedCount.get(b.id) ?? 0 }))
    .filter((x) => x.need >= x.b.quantity)
  const usable = shortageBoards
    .filter(({ b }) =>
      parts.some(
        (p) =>
          blockedPartIds.has(p.id) &&
          boardsAllowedForPart(boards, p).includes(b) &&
          partFitsBoard(p, b, kerf, trim)
      )
    )
    .sort((x, y) => x.b.priceCents - y.b.priceCents)
  const pick = usable[0]
  if (!pick) return null
  const need = Math.max(pick.need + sizeBlockers.length, pick.b.quantity + 1)
  return {
    kind: 'sheets',
    boardId: pick.b.id,
    boardName: pick.b.name,
    needSheets: need,
    haveSheets: pick.b.quantity,
    text:
      `按最省的可用板种「${pick.b.name}」算：现有库存 ${pick.b.quantity} 张，` +
      `至少还差 ${need - pick.b.quantity} 张（需备到 ${need} 张）才能把卡住的件排完。`
  }
}

// ───────────────────────── 方案指纹与逐项变化 ─────────────────────────

export interface PlanSnapshot {
  fingerprint: string
  kerfMm: number
  trimMm: number
  budgetCents: number
  strategy: BoardSelectStrategy
  totalCostCents: number
  rows: Map<
    string,
    { boardName: string; sheets: number; priceCents: number; subtotalCents: number }
  >
  /** partId -> 板名 -> 件数 */
  partBoards: Map<string, Map<string, number>>
  partCode: Map<string, string>
  partName: Map<string, string>
  sheetBoards: string[]
}

/** 方案指纹：锯路/修边/预算/策略 + 每张板的板种与摆法（实例序列）+ 板价。任一变动都换指纹。 */
export function snapshotFingerprint(
  sheets: SheetResult[],
  params: { kerfMm: number; trimMm: number; budgetCents: number; strategy: BoardSelectStrategy }
): string {
  const lines: string[] = [
    `k=${params.kerfMm}|t=${params.trimMm}|bud=${params.budgetCents}|s=${params.strategy}`
  ]
  for (const s of sheets) {
    const ids = s.placements.map((p) => `${p.instanceId}@${Math.round(p.x)},${Math.round(p.y)}`).sort()
    lines.push(`${s.index}:${s.boardId}@${s.priceCents}:${ids.join(',')}`)
  }
  return djb2(lines.join('||'))
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `fp_${(h >>> 0).toString(36)}_${s.length.toString(36)}`
}

export function buildSnapshot(
  result: NestResult,
  params: { kerfMm: number; trimMm: number; budgetCents: number; strategy: BoardSelectStrategy }
): PlanSnapshot {
  const rows = new Map<string, { boardName: string; sheets: number; priceCents: number; subtotalCents: number }>()
  const partBoards = new Map<string, Map<string, number>>()
  const partCode = new Map<string, string>()
  const partName = new Map<string, string>()
  const sheetBoards: string[] = []
  for (const s of result.sheets) {
    sheetBoards.push(s.boardName)
    const cur = rows.get(s.boardId)
    if (cur) {
      cur.sheets++
      cur.subtotalCents += s.priceCents
    } else {
      rows.set(s.boardId, {
        boardName: s.boardName,
        sheets: 1,
        priceCents: s.priceCents,
        subtotalCents: s.priceCents
      })
    }
    for (const p of s.placements) {
      let m = partBoards.get(p.partId)
      if (!m) {
        m = new Map()
        partBoards.set(p.partId, m)
      }
      m.set(s.boardName, (m.get(s.boardName) ?? 0) + 1)
      partCode.set(p.partId, p.code)
      partName.set(p.partId, p.name)
    }
  }
  return {
    fingerprint: snapshotFingerprint(result.sheets, params),
    ...params,
    totalCostCents: result.totalCostCents,
    rows,
    partBoards,
    partCode,
    partName,
    sheetBoards
  }
}

/** 前后两版选板/排样逐项对比：哪几行板种张数变、哪几件换板、哪几张板板种变、成本表哪几行变。 */
export function diffSnapshots(before: PlanSnapshot | null, after: PlanSnapshot): PlanChange {
  if (!before) {
    return {
      changed: true,
      fingerprintChanged: true,
      boardRows: [...after.rows.entries()].map(([id, r]) => ({
        boardId: id,
        boardName: r.boardName,
        beforeSheets: 0,
        afterSheets: r.sheets,
        beforeSubtotalCents: 0,
        afterSubtotalCents: r.subtotalCents,
        kind: 'added'
      })),
      movedParts: [],
      sheetBoardChanges: after.sheetBoards.map((name, i) => ({ sheetIndex: i, before: '—', after: name })),
      orderEffects: [],
      costTableRows: [],
      paramChanges: [],
      beforeFingerprint: '',
      afterFingerprint: after.fingerprint
    }
  }
  const boardRows: PlanChange['boardRows'] = []
  const ids = new Set([...before.rows.keys(), ...after.rows.keys()])
  for (const id of ids) {
    const a = before.rows.get(id)
    const c = after.rows.get(id)
    const row: PlanChange['boardRows'][number] = {
      boardId: id,
      boardName: c?.boardName ?? a!.boardName,
      beforeSheets: a?.sheets ?? 0,
      afterSheets: c?.sheets ?? 0,
      beforeSubtotalCents: a?.subtotalCents ?? 0,
      afterSubtotalCents: c?.subtotalCents ?? 0,
      kind: 'same'
    }
    if (!a) row.kind = 'added'
    else if (!c) row.kind = 'removed'
    else if (a.sheets !== c.sheets || a.subtotalCents !== c.subtotalCents) row.kind = 'sheets'
    boardRows.push(row)
  }
  boardRows.sort((x, y) => x.boardName.localeCompare(y.boardName, 'zh'))

  // 换板：按件型聚合，取前后主用板（件数最多）不同即列出
  const movedParts: PlanChange['movedParts'] = []
  const partIds = new Set([...before.partBoards.keys(), ...after.partBoards.keys()])
  const top = (m: Map<string, number> | undefined): string => {
    if (!m || m.size === 0) return '（未排上）'
    return [...m.entries()].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0][0]
  }
  for (const pid of partIds) {
    const fb = top(before.partBoards.get(pid))
    const tb = top(after.partBoards.get(pid))
    if (fb !== tb) {
      const qty =
        [...(after.partBoards.get(pid)?.values() ?? [])].reduce((a, x) => a + x, 0) ||
        [...(before.partBoards.get(pid)?.values() ?? [])].reduce((a, x) => a + x, 0)
      movedParts.push({
        partId: pid,
        code: after.partCode.get(pid) ?? before.partCode.get(pid) ?? '',
        name: after.partName.get(pid) ?? before.partName.get(pid) ?? '',
        qty,
        fromBoard: fb,
        toBoard: tb
      })
    }
  }

  const sheetBoardChanges: PlanChange['sheetBoardChanges'] = []
  const n = Math.max(before.sheetBoards.length, after.sheetBoards.length)
  for (let i = 0; i < n; i++) {
    const b = before.sheetBoards[i] ?? '（无此张）'
    const a = after.sheetBoards[i] ?? '（无此张）'
    if (b !== a) sheetBoardChanges.push({ sheetIndex: i, before: b, after: a })
  }

  const costTableRows: PlanChange['costTableRows'] = []
  for (const r of boardRows) {
    if (r.beforeSubtotalCents !== r.afterSubtotalCents) {
      costTableRows.push({
        label: `成本表行「${r.boardName}」小计`,
        before: `¥${(r.beforeSubtotalCents / 100).toFixed(2)}（${r.beforeSheets} 张）`,
        after: `¥${(r.afterSubtotalCents / 100).toFixed(2)}（${r.afterSheets} 张）`
      })
    }
  }
  if (before.totalCostCents !== after.totalCostCents) {
    costTableRows.unshift({
      label: '成本表「板材成本合计」',
      before: `¥${(before.totalCostCents / 100).toFixed(2)}`,
      after: `¥${(after.totalCostCents / 100).toFixed(2)}`
    })
  }

  const paramChanges: string[] = []
  if (before.kerfMm !== after.kerfMm) paramChanges.push(`锯路 ${before.kerfMm}mm → ${after.kerfMm}mm`)
  if (before.trimMm !== after.trimMm) paramChanges.push(`修边 ${before.trimMm}mm → ${after.trimMm}mm`)
  if (before.budgetCents !== after.budgetCents)
    paramChanges.push(
      `预算 ¥${(before.budgetCents / 100).toFixed(2)} → ¥${(after.budgetCents / 100).toFixed(2)}`
    )
  if (before.strategy !== after.strategy)
    paramChanges.push(`策略 ${before.strategy === 'cheapest' ? '先最省' : '先板幅最大'} → ${after.strategy === 'cheapest' ? '先最省' : '先板幅最大'}`)

  return {
    changed: before.fingerprint !== after.fingerprint,
    fingerprintChanged: before.fingerprint !== after.fingerprint,
    boardRows: boardRows.filter((r) => r.kind !== 'same'),
    movedParts,
    sheetBoardChanges,
    orderEffects: [],
    costTableRows,
    paramChanges,
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint
  }
}
