// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  IssuedOrder,
  Job,
  NestResult,
  Part,
  PlanChange,
  RegisteredOffcut,
  SheetResult
} from '../types'
import { nestJob } from './packing'
import { selectBoards, buildSnapshot, diffSnapshots, type PlanSnapshot } from './boardSelect'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { uid } from './format'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'
const ORDERS_KEY = 'fco.orders.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  orders: IssuedOrder[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  orders: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
  localStorage.setItem(ORDERS_KEY, JSON.stringify(state.orders))
}

function migrateJob(j: Job): Job {
  if (j.budgetCents === undefined) j.budgetCents = -1
  if (!j.boardStrategy) j.boardStrategy = 'cheapest'
  if (j.useOffcutIds === undefined) j.useOffcutIds = []
  return j
}

function init(): void {
  if (state.loaded) return
  state.jobs = load<Job[]>(JOBS_KEY, []).map(migrateJob)
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.orders = load<IssuedOrder[]>(ORDERS_KEY, [])
  state.loaded = true
}

export function defaultBoards(): Board[] {
  return boardsData.stockBoards.slice(0, 3).map((b) => ({
    id: uid('b'),
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock'
  }))
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    useOffcutIds: [],
    batchByCabinet: false,
    budgetCents: -1,
    boardStrategy: 'cheapest'
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

/**
 * 排样 + 选板反算，三处页面（板件明细/排样结果/材料统计）与领料单唯一同源入口。
 * 选板和最终摆法来自同一次 selectBoards() 内的 pack 输出，绝不重排出第二套摆法。
 */
export interface RunNestOutcome {
  result: NestResult
  change: PlanChange | null
}

export function runNest(job: Job): NestResult {
  return runNestWithChange(job).result
}

export function runNestWithChange(job: Job): RunNestOutcome {
  migrateJob(job)
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }

  // 重算前抓上一版快照（用于逐条列出变化）
  const before: PlanSnapshot | null = job.result
    ? buildSnapshot(job.result, {
        kerfMm: job.kerfMm,
        trimMm: job.trimMm,
        budgetCents: job.budgetCents,
        strategy: job.boardStrategy
      })
    : null

  const selection = selectBoards({
    boards: effective.boards,
    parts: job.parts,
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    batchByCabinet: job.batchByCabinet,
    budgetCents: job.budgetCents,
    strategy: job.boardStrategy
  })

  // 采纳摆法：可行/预算不够 → 策略或最省方案；板幅纹理卡死/预算为零/零件为空 → 试排参考
  const chosenPack = selection.chosenPack
  const result =
    chosenPack && chosenPack.sheets.length > 0
      ? nestJob(effective, { pack: chosenPack, boardSelect: selection.report })
      : nestJob(effective, { boardSelect: selection.report })

  // 余料状态：先把「本单上轮占用、本轮仍勾选参与」的余料归还，再按新方案重新占用。
  // 试排（不可行/预算为零/零件为空）不占用任何余料。
  for (const oc of state.offcuts) {
    if (oc.usedByJobId === job.id && job.useOffcutIds.includes(oc.id)) {
      oc.available = true
      oc.usedByJobId = undefined
    }
  }
  if (selection.report.status === 'feasible') {
    const usedOffcutBoardIds = new Set(
      result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
    )
    for (const oc of state.offcuts) {
      if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
        oc.available = false
        oc.usedByJobId = job.id
      }
    }
  }

  job.result = result

  // 逐项变化清单（板种张数 / 换板 / 每张板板种 / 成本表行 / 参数）
  const after = buildSnapshot(result, {
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    budgetCents: job.budgetCents,
    strategy: job.boardStrategy
  })

  // 记录本次采纳时的参数与签名（明细页据此提示「改了锯路/修边/板价 → 结论过期」）
  job.lastRun = {
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    budgetCents: job.budgetCents,
    boardStrategy: job.boardStrategy,
    fingerprint: after.fingerprint,
    partsSig: partsSignature(job),
    boardsSig: boardsSignature(job)
  }

  const change = before ? diffSnapshots(before, after) : null
  if (change && before) {
    // 已存档并导出的领料单据：指纹变了一律作废重来
    change.orderEffects = state.orders
      .filter((o) => o.jobId === job.id && !o.voided)
      .map((o) => {
        const stale = o.fingerprint !== after.fingerprint
        return {
          issuedOrderId: o.id,
          issuedAt: o.issuedAt,
          status: stale ? ('void' as const) : ('keep' as const),
          reason: stale
            ? `锯路/修边/板价/选板变动使指纹 ${o.fingerprint} → ${after.fingerprint}，旧领料单作废`
            : '指纹一致，单据继续有效'
        }
      })
    for (const o of state.orders) {
      if (o.jobId !== job.id || o.voided) continue
      const eff = change.orderEffects.find((e) => e.issuedOrderId === o.id)
      if (eff?.status === 'void') {
        o.voided = true
        o.voidReason = eff.reason
      }
    }
  }
  if (change) lastChanges.set(job.id, change)

  persist()
  return { result, change }
}

/** 内存态：每个项目最近一次重算的逐项变化（三个页面顶部都可查看，不持久化） */
const lastChanges = new Map<string, PlanChange>()

export function getLastChange(jobId: string): PlanChange | null {
  return lastChanges.get(jobId) ?? null
}
export function clearLastChange(jobId: string): void {
  lastChanges.delete(jobId)
}

/** 上一版排样是否因锯路/修边/板价/板件/策略变化已经过期（明细页提示用）。 */
export function isResultStale(job: Job): boolean {
  const lr = job.lastRun
  if (!job.result || !lr) return false
  return (
    lr.kerfMm !== job.kerfMm ||
    lr.trimMm !== job.trimMm ||
    lr.budgetCents !== job.budgetCents ||
    lr.boardStrategy !== job.boardStrategy ||
    lr.partsSig !== partsSignature(job) ||
    lr.boardsSig !== boardsSignature(job)
  )
}

function partsSignature(job: Job): string {
  return job.parts
    .map(
      (p) =>
        `${p.id}:${p.lenMm}x${p.widMm}x${p.qty}:${p.grain}:${p.boardId ?? ''}:${p.thicknessMm ?? 0}:${[...p.edgeBands].sort().join('')}`
    )
    .join('|')
}

function boardsSignature(job: Job): string {
  return job.boards
    .map((b) => `${b.id}:${b.wMm}x${b.hMm}x${b.thicknessMm}@${b.priceCents}q${b.quantity}`)
    .join('|')
}

// ── 领料单据存档（本机）：只按可行选板结论登记；指纹变了由 runNestWithChange 作废 ──

export function issueOrder(job: Job): IssuedOrder | null {
  if (!job.result || !job.result.boardSelect || job.result.boardSelect.status !== 'feasible') {
    return null
  }
  const r = job.result
  const params = {
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    budgetCents: job.budgetCents,
    strategy: job.boardStrategy
  }
  const snap = buildSnapshot(r, params)
  const order: IssuedOrder = {
    id: uid('ord'),
    jobId: job.id,
    jobName: job.name,
    issuedAt: Date.now(),
    fingerprint: snap.fingerprint,
    summary: {
      boardsUsed: r.boardsUsed,
      totalCostCents: r.totalCostCents,
      byBoard: [...snap.rows.entries()].map(([id, x]) => ({
        boardId: id,
        boardName: x.boardName,
        sheets: x.sheets,
        subtotalCents: x.subtotalCents
      }))
    },
    voided: false
  }
  state.orders.unshift(order)
  persist()
  return order
}

export function ordersForJob(jobId: string): IssuedOrder[] {
  init()
  return state.orders.filter((o) => o.jobId === jobId)
}

/**
 * 三处页面（板件明细/排样结果/材料统计）与领料单据共用的取数入口。
 * 板种、张数、单价、小计一律只认 result.boardSelect.plan；
 * 选板无可行结论（预算不够/板幅纹理卡死/预算为零/零件为空）时返回 null，
 * 调用方必须展示卡点而不是回退到旧的 boardsByType（防止一新一旧）。
 */
export interface PlanRow {
  boardId: string
  boardName: string
  material: string
  wMm: number
  hMm: number
  thicknessMm: number
  sheets: number
  priceCents: number
  subtotalCents: number
  isOffcut: boolean
}

export function planRows(result?: NestResult | null): PlanRow[] {
  const plan = result?.boardSelect?.plan
  if (!plan) return []
  return plan.items.map((it) => ({ ...it }))
}

/** 每张板摊到的钱：余料板 0；常规板按其板种单价（与 plan 同源）。 */
export function sheetCostRows(result?: NestResult | null): { index: number; boardName: string; priceCents: number }[] {
  if (!result) return []
  return result.sheets.map((s) => ({ index: s.index, boardName: s.boardName, priceCents: s.priceCents }))
}

/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const bounds = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  persist()
  return null
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const bBack = boardsData.stockBoards[6]
  const back: Board = {
    id: uid('b'),
    name: bBack.name,
    wMm: bBack.wMm,
    hMm: bBack.hMm,
    thicknessMm: bBack.thicknessMm,
    material: bBack.material,
    priceCents: bBack.priceCents,
    quantity: 0,
    kind: 'stock'
  }
  job.boards.push(back)
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? '',
    thicknessMm: partial.thicknessMm ?? 0
  }
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const obj = JSON.parse(json) as Job
    if (!obj.parts || !obj.boards) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    obj.result = undefined
    state.jobs.unshift(obj)
    persist()
    return obj
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts),
    orders: computed(() => state.orders)
  }
}

export { boardsData }
