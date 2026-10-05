// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  IssuedRequisition,
  Job,
  NestResult,
  Part,
  RegisteredOffcut,
  SheetResult
} from '../types'
import { nestJob } from './packing'
import { selectBoards, type SelectOutcome } from './selector'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { uid } from './format'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v2'
const LEGACY_JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'
const REQUISITIONS_KEY = 'fco.requisitions.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  requisitions: IssuedRequisition[]
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
  requisitions: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
  localStorage.setItem(REQUISITIONS_KEY, JSON.stringify(state.requisitions))
}

/** 旧存档迁移 + 新字段补齐：预算/策略/版次、result.materialLines、selection。 */
function migrateJob(j: Job): void {
  if (j.budgetCents === undefined) j.budgetCents = 0
  if (!j.strategy) j.strategy = 'cheapest'
  if (j.selectionRevision === undefined) j.selectionRevision = 0
  if (j.result) {
    if (!j.result.materialLines) {
      // 从 sheets 反建同源领料行（旧版只有 boardsByType）
      const map = new Map<string, NestResult['materialLines'][number]>()
      for (const s of j.result.sheets) {
        let line = map.get(s.boardId)
        if (!line) {
          line = {
            boardId: s.boardId,
            boardName: s.boardName,
            material: s.material,
            thicknessMm: s.thicknessMm,
            wMm: s.wMm,
            hMm: s.hMm,
            priceCents: s.priceCents,
            sheets: 0,
            subtotalCents: 0
          }
          map.set(s.boardId, line)
        }
        line.sheets++
        line.subtotalCents += s.priceCents
      }
      j.result.materialLines = [...map.values()]
    }
  }
}

function init(): void {
  if (state.loaded) return
  let jobs = load<Job[]>(JOBS_KEY, [])
  if (jobs.length === 0) {
    const legacy = load<Job[] | null>(LEGACY_JOBS_KEY, null)
    if (legacy && Array.isArray(legacy)) jobs = legacy
  }
  jobs.forEach(migrateJob)
  state.jobs = jobs
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.requisitions = load<IssuedRequisition[]>(REQUISITIONS_KEY, [])
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
    budgetCents: 0,
    strategy: 'cheapest',
    useOffcutIds: [],
    batchByCabinet: false,
    selectionRevision: 0
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
  job.selectionRevision = 0
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

export function runNest(job: Job): NestResult {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective, {})
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  job.result = result
  persist()
  return result
}

/**
 * 选板与花费反算（正式入口）：
 * - 枚举板种走同一个排样内核；结论（板种/张数/每张摆法/摊到每张板的钱）写进 job.result，
 *   板件明细页、排样结果页、材料统计页、领料单全部消费这同一份。
 * - 输入变化（锯路/修边/板价/板幅/零件/余料勾选）重算时带上一版做 diff；
 *   结论变化导致版次 +1，并把已签发的旧领料单作废。
 * - 零零件 / 预算为 0 / 排不下：不产生正式结论（见 SelectionState.status）。
 */
export function runSelection(job: Job): SelectOutcome {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const prev =
    job.result?.selection && job.result.selection.prevSnapshot
      ? { result: job.result, snapshot: job.result.selection.prevSnapshot, revision: job.selectionRevision || 0 }
      : null
  const outcome = selectBoards(effective, effective.boards, prev)

  if (outcome.result) job.result = outcome.result
  const sel = outcome.selection
  if (sel.status === 'conclusion' || sel.status === 'budget') {
    const rev = sel.revision
    if (prev && rev > prev.revision) {
      const changes = sel.lastDiff?.paramChanges ?? []
      for (const r of state.requisitions) {
        if (!r.voided && r.jobId === job.id && r.revision < rev) {
          r.voided = true
          r.voidedAt = Date.now()
          r.voidReason =
            `选板输入变化并重算（${changes.slice(0, 3).join('；')}${changes.length > 3 ? ' 等' : ''}），` +
            `旧领料行已被第 ${rev} 版选板结论替代`
        }
      }
    }
    job.selectionRevision = rev
  }
  persist()
  return outcome
}

/** 输入变化后的自动重算：已有结果（含失败诊断）时即时刷新；从未排样时不打扰录单。 */
export function autoReselect(job: Job): SelectOutcome | null {
  if (!job.result) return null
  return runSelection(job)
}

/** 签发领料单据（本机存档）：记录版次；之后选板结论一变，旧单自动作废。 */
export function issueRequisition(job: Job): IssuedRequisition | null {
  const r = job.result
  if (!r || r.selection?.status !== 'conclusion') return null
  const rec: IssuedRequisition = {
    id: uid('req'),
    jobId: job.id,
    jobName: job.name,
    revision: r.selection.revision,
    issuedAt: Date.now(),
    strategy: r.selection.strategy,
    budgetCents: r.selection.budgetCents,
    lines: JSON.parse(JSON.stringify(r.materialLines)),
    totalCostCents: r.totalCostCents,
    totalSheets: r.boardsUsed,
    voided: false
  }
  state.requisitions.push(rec)
  persist()
  return rec
}

export function requisitionsForJob(jobId: string): IssuedRequisition[] {
  init()
  return state.requisitions.filter((r) => r.jobId === jobId).sort((a, b) => b.issuedAt - a.issuedAt)
}

export function latestValidRequisition(jobId: string): IssuedRequisition | undefined {
  return requisitionsForJob(jobId).find((r) => !r.voided)
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
  // 示例预算：18mm 柜体板若干 + 9mm 背板，给一个略有余量的上限（分）
  job.budgetCents = 200000
  job.strategy = 'cheapest'
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
    obj.selectionRevision = 0
    migrateJob(obj)
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
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
