// 核心排样：guillotine（直线贯通可锯）递归二分 2D 装箱
// - 纹理 length/width 硬约束：只允许指定朝向，rotated 恒为 false，放不下就报原因
// - 锯路 kerf：零件与零件、零件与余料之间留锯缝；修边 trim 为四周先切掉的边
// - 利用率分母为整板面积，分子为零件净面积（不含锯路）
//
// 选板反算（boardSelect.ts）与正常排样都只能调用本文件的 packBoards()：
// 板种/厚度匹配（boardsAllowedForPart）、纹理朝向（orientationsOf）、
// 余隙清洁（cleanFits：严丝合缝或余隙 ≥ 锯路）、修边扣除、guillotine 合法性
// 全部走这一条路径，禁止为选板另写一套只给选板用的孤立判定。
import type {
  Board,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult,
  UnplacedInfo,
  BoardSelectStrategy
} from '../types'
import { EPS, type Rect } from './geometry'
import { buildSteps, simulate } from './cuts'
import type { DSeg } from './cuts'

interface Inst {
  part: Part
  k: number // 第 k 件（qty 展开）
  key: string
  cabinet: string
}

interface FRect extends Rect {
  id: number
  parentRec: number | null // 由哪次放置产生（切割依赖）
  entrySeg: 'A' | 'B' | null // 进入该空档前必须完成的刀：首刀/次刀
}

interface Rec {
  id: number
  frId: number
  instKey: string
  x: number
  y: number
  pw: number
  ph: number
  dir: 'v' | 'h'
  segA?: DSeg
  segB?: DSeg
}

interface SheetState {
  board: Board
  index: number
  usable: Rect
  free: FRect[]
  recs: Rec[]
  placements: Placement[]
}

/** 开新板策略：legacy=面积最小（旧行为）；cheapest=先最省；largest=先板幅最大。 */
export type NewBoardPolicy = 'legacy' | BoardSelectStrategy

/** 统一为横向板（长边沿 x）。余料上台可以转，所以归一化安全。 */
function normalize(b: Board): Board {
  if (b.wMm >= b.hMm) return b
  return { ...b, wMm: b.hMm, hMm: b.wMm }
}

/**
 * 板件能上哪些板（唯一匹配口径）；scope 必须是本次实际参与排样的板集合
 * （选板枚举会按 allowBoardIds 过滤，匹配不能越界到全目录）：
 * - 指定 boardId：只能上该板；余料板厚度与目标板一致时也算对得上（同料余料）
 * - 指定 thicknessMm(>0)：只能上同厚度板
 * - 都没指定：所有板
 */
export function boardsAllowedForPart(scope: Board[], p: Part): Board[] {
  return scope.filter((b) => {
    if (p.boardId) {
      if (b.id === p.boardId) return true
      if (b.kind === 'offcut') {
        const target = scope.find((x) => x.id === p.boardId)
        return !!target && target.thicknessMm === b.thicknessMm
      }
      return false
    }
    if (p.thicknessMm && p.thicknessMm > 0) return b.thicknessMm === p.thicknessMm
    return true
  })
}

export interface Orient {
  pw: number
  ph: number
  rotated: boolean
}

/** 纹理朝向（唯一朝向口径）：竖纹/横纹只给一个朝向且 rotated=false；无要求可转。 */
export function orientationsOf(p: Part): Orient[] {
  if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
  if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  return [
    { pw: p.lenMm, ph: p.widMm, rotated: false },
    { pw: p.widMm, ph: p.lenMm, rotated: true }
  ]
}

/** 只允许严丝合缝（0）或余隙 ≥ 锯路；0<余隙<锯路 时下不了刀，禁止放入（唯一余隙口径）。 */
export function cleanFits(avail: number, size: number, kerf: number): boolean {
  const gap = avail - size
  return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
}

/** 板件在给定板（已扣四周修边）上是否存在合法朝向；同样走 cleanFits/orientationsOf。 */
export function partFitsBoard(p: Part, b: Board, kerf: number, trim: number): boolean {
  const uw = b.wMm - 2 * trim
  const uh = b.hMm - 2 * trim
  return orientationsOf(p).some((o) => cleanFits(uw, o.pw, kerf) && cleanFits(uh, o.ph, kerf))
}

export interface PackOutput {
  sheets: SheetResult[]
  unplaced: UnplacedInfo[]
  unplacedParts: { part: Part; qty: number }[]
  placedCount: number
  totalQty: number
  totalCostCents: number
  openedCount: Map<string, number>
  /** 本次实际参与排样的板（已按 allowBoardIds 过滤、归一化前的输入集） */
  boardsUsed: Board[]
  kerfMm: number
  trimMm: number
}

export interface PackBoardsArgs {
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  batchByCabinet: boolean
  policy?: NewBoardPolicy
  allowBoardIds?: ReadonlySet<string> | null
}

export function packBoards(args: PackBoardsArgs): PackOutput {
  const kerf = args.kerfMm
  const trim = args.trimMm
  const policy: NewBoardPolicy = args.policy ?? 'legacy'
  const allow = args.allowBoardIds ?? null
  const scopeBoards = args.boards.filter((b) => !allow || allow.has(b.id))
  const boards = scopeBoards.map(normalize)

  // 各板种实际开板数（用于库存补采提示）
  const openedCount = new Map<string, number>()

  // 零件实例展开
  const insts: Inst[] = []
  for (const p of args.parts) {
    for (let k = 1; k <= Math.max(0, p.qty); k++) {
      insts.push({ part: p, k, key: `${p.id}#${k}`, cabinet: p.cabinet || '未分组' })
    }
  }
  // 排序：按柜体批次分组时柜体优先；随后大边降序、面积降序
  const sorted = [...insts].sort((a, b) => {
    if (args.batchByCabinet && a.cabinet !== b.cabinet) return a.cabinet < b.cabinet ? -1 : 1
    const am = Math.max(a.part.lenMm, a.part.widMm)
    const bm = Math.max(b.part.lenMm, b.part.widMm)
    if (bm !== am) return bm - am
    return b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
  })

  const sheets: SheetState[] = []
  let frSeq = 0
  const openSheet = (b: Board): SheetState => {
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const s: SheetState = {
      board: b,
      index: sheets.length,
      usable,
      free: [
        {
          id: frSeq++,
          x: usable.x,
          y: usable.y,
          w: usable.w,
          h: usable.h,
          parentRec: null,
          entrySeg: null
        }
      ],
      recs: [],
      placements: []
    }
    sheets.push(s)
    return s
  }

  const canOpen = (b: Board): boolean => {
    // 余料板只有一块，用完即止；常规板库存是采购参考，可超开（稍后提示补采）
    if (b.kind === 'offcut') {
      const used = openedCount.get(b.id) ?? 0
      return used < 1
    }
    return true
  }

  const pickNewBoard = (p: Part, pw: number, ph: number): Board | null => {
    // 注意：板种/厚度匹配必须以本次实际参与的 boards（已按 allowBoardIds 过滤）为准，
    // 不能拿全目录判定，否则被排除的板种也会被当成"对得上"。
    const viable = boards.filter(
      (b) =>
        canOpen(b) &&
        boardsAllowedForPart(boards, p).includes(b) &&
        cleanFits(b.wMm - 2 * trim, pw, kerf) &&
        cleanFits(b.hMm - 2 * trim, ph, kerf)
    )
    // 余料小板（免费、存量只有一块）永远最优先；
    // 其后按策略：legacy 选面积最小；cheapest 选最便宜；largest 选板幅最大
    viable.sort((a, b) => {
      if ((a.kind === 'offcut') !== (b.kind === 'offcut')) return a.kind === 'offcut' ? -1 : 1
      if (policy === 'largest') {
        const dArea = b.wMm * b.hMm - a.wMm * a.hMm
        if (dArea !== 0) return dArea
        return a.priceCents - b.priceCents
      }
      if (policy === 'cheapest') {
        if (a.priceCents !== b.priceCents) return a.priceCents - b.priceCents
        return a.wMm * a.hMm - b.wMm * b.hMm
      }
      return a.wMm * a.hMm - b.wMm * b.hMm
    })
    return viable[0] ?? null
  }

  const unplaced = new Map<string, { part: Part; qty: number }>()
  const markUnplaced = (p: Part): void => {
    const cur = unplaced.get(p.id)
    if (cur) cur.qty++
    else unplaced.set(p.id, { part: p, qty: 1 })
  }

  let seq = 0
  for (const inst of sorted) {
    const p = inst.part
    const allowed = boardsAllowedForPart(boards, p)
    let best:
      | { sheet: SheetState | null; fr: FRect | null; nb: Board | null; o: Orient; tier: number; waste: number }
      | null = null
    for (const o of orientationsOf(p)) {
      // tier 0：已打开的、板种匹配的板里最贴合的空档
      for (const s of sheets) {
        if (!allowed.includes(s.board)) continue
        for (const fr of s.free) {
          if (cleanFits(fr.w, o.pw, kerf) && cleanFits(fr.h, o.ph, kerf)) {
            const waste = fr.w * fr.h - o.pw * o.ph
            if (!best || waste < best.waste) {
              best = { sheet: s, fr, nb: null, o, tier: 0, waste }
            }
          }
        }
      }
      // tier 1：新开余料小板 / tier 2：新开常规板
      const nb = pickNewBoard(p, o.pw, o.ph)
      if (nb) {
        const tier = nb.kind === 'offcut' ? 1 : 2
        const waste = (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - o.pw * o.ph
        if (!best || tier < best.tier || (tier === best.tier && waste < best.waste)) {
          best = { sheet: null, fr: null, nb, o, tier, waste }
        }
      }
    }
    if (!best) {
      markUnplaced(p)
      continue
    }
    let s: SheetState
    let fr: FRect
    if (best.sheet && best.fr) {
      s = best.sheet
      fr = best.fr
    } else {
      // 正式新板
      const nb = best.nb ?? pickNewBoard(p, best.o.pw, best.o.ph)
      if (!nb) {
        markUnplaced(p)
        continue
      }
      s = openSheet(nb)
      openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
      fr = s.free[0]
    }
    const o = best.o
    // 占用该空档并按 guillotine 递归二分拆出余隙
    s.free = s.free.filter((f) => f.id !== fr.id)
    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: inst.key,
      x: fr.x,
      y: fr.y,
      pw: o.pw,
      ph: o.ph,
      dir: fr.w >= fr.h ? 'v' : 'h'
    }
    const addFree = (r: Rect, parentRec: number, entrySeg: 'A' | 'B'): void => {
      if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg })
    }
    const parentDeps = segDepsOf(fr, s)
    const gx = fr.w - o.pw // 右侧余隙（≈0 或 ≥kerf）
    const gy = fr.h - o.ph // 上方余隙（≈0 或 ≥kerf）
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    if (rec.dir === 'v') {
      // 先竖切贯通全高（segA），再在含零件的左条内横切（segB）
      if (cutX) {
        rec.segA = {
          axis: 'v',
          at: fr.x + o.pw + kerf / 2,
          lo: fr.y,
          hi: fr.y + fr.h,
          deps: parentDeps
        }
      }
      if (cutY) {
        rec.segB = {
          axis: 'h',
          at: fr.y + o.ph + kerf / 2,
          lo: fr.x,
          hi: cutX ? fr.x + o.pw : fr.x + fr.w,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      // 左条上方空档需要 segB；右侧整条空档只需要 segA
      if (cutY) {
        addFree(
          { x: fr.x, y: fr.y + o.ph + kerf, w: cutX ? o.pw : fr.w, h: gy - kerf },
          rec.id,
          'B'
        )
      }
      if (cutX) {
        addFree({ x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
      }
    } else {
      // 先横切贯通全宽（segA），再在含零件的下条内竖切（segB）
      if (cutY) {
        rec.segA = {
          axis: 'h',
          at: fr.y + o.ph + kerf / 2,
          lo: fr.x,
          hi: fr.x + fr.w,
          deps: parentDeps
        }
      }
      if (cutX) {
        rec.segB = {
          axis: 'v',
          at: fr.x + o.pw + kerf / 2,
          lo: fr.y,
          hi: cutY ? fr.y + o.ph : fr.y + fr.h,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      // 上方整条空档只需要 segA；下条右侧空档需要 segB
      if (cutY) {
        addFree({ x: fr.x, y: fr.y + o.ph + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
      }
      if (cutX) {
        addFree(
          { x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: cutY ? o.ph : fr.h },
          rec.id,
          'B'
        )
      }
    }
    s.recs.push(rec)
    seq++
    s.placements.push({
      partId: p.id,
      instanceId: inst.key,
      boardIndex: s.index,
      x: fr.x,
      y: fr.y,
      lenMm: o.pw,
      widMm: o.ph,
      origLen: p.lenMm,
      origWid: p.widMm,
      rotated: o.rotated,
      seq,
      code: p.code,
      name: p.name,
      cabinet: inst.cabinet,
      exposed: p.exposed,
      grain: p.grain,
      edgeBands: p.edgeBands
    })
  }

  // 组装 SheetResult
  const results: SheetResult[] = sheets.map((s) => buildSheet(s, kerf, trim))
  const totalQty = insts.length
  const placedCount = results.reduce((a, s) => a + s.placements.length, 0)
  const totalCostCents = results.reduce((a, s) => a + s.priceCents, 0)
  const unplacedParts = [...unplaced.values()]
  const unplacedList: UnplacedInfo[] = unplacedParts.map((u) => ({
    partId: u.part.id,
    code: u.part.code,
    name: u.part.name,
    qty: u.qty,
    reason:
      u.part.grain === 'none'
        ? '板材尺寸或库存不足，无法排下'
        : u.part.grain === 'length'
          ? '因纹理要求为竖纹（不可旋转），现有板材排不下'
          : '因纹理要求为横纹（不可旋转），现有板材排不下'
  }))

  return {
    sheets: results,
    unplaced: unplacedList,
    unplacedParts,
    placedCount,
    totalQty,
    totalCostCents,
    openedCount,
    boardsUsed: scopeBoards,
    kerfMm: kerf,
    trimMm: trim
  }
}

export interface NestJobOpts {
  policy?: NewBoardPolicy
  allowBoardIds?: ReadonlySet<string> | null
  /** 已由选板阶段算好的 pack 输出（同一次计算，禁止再排一套不同的摆法）。 */
  pack?: PackOutput
  boardSelect?: NestResult['boardSelect']
}

export function nestJob(job: Job, opts: NestJobOpts = {}): NestResult {
  const t0 = performance.now()
  const out =
    opts.pack ??
    packBoards({
      boards: job.boards,
      parts: job.parts,
      kerfMm: job.kerfMm,
      trimMm: job.trimMm,
      batchByCabinet: job.batchByCabinet,
      policy: opts.policy,
      allowBoardIds: opts.allowBoardIds
    })
  const scopeBoards = out.boardsUsed
  const results = out.sheets

  // 统计
  const boardsByType: Record<string, number> = {}
  for (const s of results) {
    boardsByType[s.boardName] = (boardsByType[s.boardName] ?? 0) + 1
  }
  let exposedM = 0
  let normalM = 0
  for (const s of results) {
    for (const pl of s.placements) {
      const m =
        (pl.origLen *
          ((pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)) +
          pl.origWid *
            ((pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (pl.exposed) exposedM += m
      else normalM += m
    }
  }

  const baselineBoards = shelfBaseline(
    { parts: job.parts, kerfMm: out.kerfMm, trimMm: out.trimMm },
    scopeBoards,
    results.length
  )
  const optimizedBoards = results.length
  const savedBoards = Math.max(0, baselineBoards - optimizedBoards)
  const stockShortage = scopeBoards
    .filter((b) => b.kind !== 'offcut' && b.quantity > 0)
    .map((b) => ({
      boardId: b.id,
      boardName: b.name,
      need: out.openedCount.get(b.id) ?? 0,
      have: b.quantity
    }))
    .filter((x) => x.need > x.have)

  const stockUsed = results.filter((s) => s.priceCents > 0)
  const avgPrice =
    stockUsed.length > 0
      ? stockUsed.reduce((a, s) => a + s.priceCents, 0) / stockUsed.length
      : job.boards.reduce((a, b) => a + b.priceCents, 0) / Math.max(1, job.boards.length)

  return {
    sheets: results,
    boardsUsed: optimizedBoards,
    boardsByType,
    edgeBandM: {
      exposed: Math.round(exposedM * 100) / 100,
      normal: Math.round(normalM * 100) / 100
    },
    unplaced: out.unplaced,
    baselineBoards,
    savedBoards,
    savedCents: Math.round(savedBoards * avgPrice),
    totalCostCents: out.totalCostCents,
    stockShortage,
    boardSelect: opts.boardSelect,
    elapsedMs: Math.round(performance.now() - t0),
    generatedAt: Date.now()
  }
}

/** 沿父放置的切割线建立依赖：进入空档前要求对应首刀/次刀已完成。 */
function segDepsOf(fr: FRect, s: SheetState): DSeg[] {
  if (fr.parentRec === null || !fr.entrySeg) return []
  const rec = s.recs.find((r) => r.id === fr.parentRec)
  if (!rec) return []
  const seg = fr.entrySeg === 'A' ? rec.segA ?? rec.segB : rec.segB ?? rec.segA
  return seg ? [seg] : []
}

function buildSheet(s: SheetState, kerf: number, trim: number): SheetResult {
  const raw: DSeg[] = []
  for (const r of s.recs) {
    if (r.segA) raw.push(r.segA)
    if (r.segB) raw.push(r.segB)
  }
  const b = s.board
  const steps = buildSteps(b.wMm, b.hMm, kerf, trim, s.index, raw)
  const boardArea = b.wMm * b.hMm
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 剩余空档全部留档；两边 ≥300mm 才标记为可用余料，按面积降序
  const offcuts: OffcutInfo[] = s.free
    .filter((f) => f.w >= 2 && f.h >= 2)
    .map((f) => ({
      x: Math.round(f.x),
      y: Math.round(f.y),
      wMm: Math.round(f.w),
      hMm: Math.round(f.h),
      areaMm2: Math.round(f.w * f.h),
      usable: f.w >= 300 - EPS && f.h >= 300 - EPS
    }))
    .sort((a, c) => c.areaMm2 - a.areaMm2)

  const sheet: SheetResult = {
    index: s.index,
    boardId: b.id,
    boardName: b.name,
    material: b.material,
    thicknessMm: b.thicknessMm,
    wMm: b.wMm,
    hMm: b.hMm,
    priceCents: b.kind === 'offcut' ? 0 : b.priceCents,
    placements: s.placements,
    steps,
    usedAreaMm2: usedArea,
    boardAreaMm2: boardArea,
    utilization: usedArea / boardArea,
    offcuts
  }
  const sim = simulate(b.wMm, b.hMm, kerf, steps, s.placements)
  if (!sim.ok) {
    console.error(`[排样] 第 ${s.index + 1} 张板切割模拟失败`, sim.errors)
  }
  return sheet
}

/**
 * 「随手排」基线：保持清单原顺序、固定朝向（不旋转）、朴素顺板货架式摆放。
 * 用于展示「本方案比随手排省几张板」。库存耗尽时退化为与优化方案相同的张数。
 */
function shelfBaseline(
  job: { parts: Part[]; kerfMm: number; trimMm: number },
  boards: Board[],
  optimizedCount: number
): number {
  let count = 0
  const kerf = job.kerfMm
  const trim = job.trimMm
  // 用对象持有当前板状态，避免闭包对局部变量的窄化问题
  const cur: { value: { b: Board; x: number; y: number; shelfH: number } | null } = { value: null }
  const usable = (b: Board): [number, number] => [b.wMm - 2 * trim, b.hMm - 2 * trim]
  const newSheet = (b: Board): void => {
    count++
    cur.value = { b, x: 0, y: 0, shelfH: 0 }
  }
  // 随手排不用登记余料，只在常规板之间顺
  const canOpen = (b: Board): boolean => b.kind !== 'offcut'
  for (const part of job.parts) {
    for (let k = 0; k < part.qty; k++) {
      const pw = part.grain === 'width' ? part.widMm : part.lenMm
      const ph = part.grain === 'width' ? part.lenMm : part.widMm
      const tryCur = (): boolean => {
        const c = cur.value
        if (!c || !boardsAllowedForPart(boards, part).includes(c.b)) return false
        const [uw, uh] = usable(c.b)
        if (c.x + pw <= uw + EPS && c.y + Math.max(c.shelfH, ph) <= uh + EPS) {
          if (c.x === 0 && c.shelfH === 0) c.shelfH = ph
          c.x += pw + kerf
          c.shelfH = Math.max(c.shelfH, ph)
          return true
        }
        // 当前层放不下，换行再试
        if (c.x > 0) {
          c.y += c.shelfH + kerf
          c.x = 0
          c.shelfH = 0
          if (pw <= uw + EPS && c.y + ph <= uh + EPS) {
            c.shelfH = ph
            c.x = pw + kerf
            return true
          }
        }
        return false
      }
      if (tryCur()) {
        // 已摆入当前板
      } else {
        const candidates = boards
          .filter(
            (b) =>
              canOpen(b) &&
              boardsAllowedForPart(boards, part).includes(b) &&
              b.wMm - 2 * trim + EPS >= pw &&
              b.hMm - 2 * trim + EPS >= ph
          )
          .sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)
        if (candidates.length === 0) return Math.max(optimizedCount, count)
        newSheet(candidates[0])
        cur.value!.x = pw + kerf
        cur.value!.shelfH = ph
      }
    }
  }
  return Math.max(count, optimizedCount)
}
