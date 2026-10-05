// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
  thicknessMm?: number // 指定厚度（mm），0/空 = 厚度不限
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  adjusted?: boolean
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

// 选板反算（同一套排样内核，不另起算法）
export type BoardSelectStrategy = 'cheapest' | 'largest'
// 选板失败时的卡点分类
export type BoardSelectBlock =
  | 'budget' // 板幅、纹理都满足，只是总价顶破预算
  | 'size' // 有板种厚度/板种对得上，但板幅容不下
  | 'grain' // 竖纹/横纹硬朝向在所有对得上的板上都排不下
  | 'spec' // 没有任何板种对得上指定板种/厚度
  | 'empty' // 零件为零或预算为零，不给结论

export interface BoardSelectItem {
  boardId: string
  boardName: string
  material: string
  wMm: number
  hMm: number
  thicknessMm: number
  sheets: number
  priceCents: number // 单价（分）
  subtotalCents: number // 小计（分）= 单价 × 张数
  isOffcut: boolean
}

export interface BoardSelectPlan {
  strategy: BoardSelectStrategy
  items: BoardSelectItem[]
  totalCostCents: number // 金额按分累加，不做中间四舍五入
  totalAreaMm2: number // 购入板材毛面积（平方毫米）
  boardsUsed: number
  boardKinds: number
  placedCount: number
}

export interface BoardSelectBlocker {
  block: Exclude<BoardSelectBlock, 'empty'>
  partId: string
  code: string
  name: string
  qty: number
  detail: string
}

export interface BoardSelectGap {
  kind: 'money' | 'sheets'
  text: string
  // kind=money：按最省板种方案还差的钱（分）
  shortCents?: number
  budgetCents?: number
  cheapestCents?: number
  // kind=sheets：板幅/纹理卡死时，最省的那个可用板种还差几张（0 库存时按需要张数）
  boardId?: string
  boardName?: string
  needSheets?: number
  haveSheets?: number
}

export interface BoardSelectReport {
  ok: boolean // false 时 plan 为 null，必须看 blockers/gap/steps
  status: 'feasible' | 'blocked' | 'inconclusive'
  plan: BoardSelectPlan | null
  /** 预算不足时的最省参考计划（只作「还差多少钱」对照，不得据此领料） */
  referencePlan?: BoardSelectPlan | null
  budgetCents: number
  strategy: BoardSelectStrategy
  totalPartQty: number
  blockers: BoardSelectBlocker[]
  gap: BoardSelectGap | null
  /** 判定路径，逐条说明卡在哪一步（零件为零/预算为零时只给步骤，不给结论） */
  steps: string[]
  evaluatedCandidates: number
  elapsedMs: number
  generatedAt: number
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  /** 选板反算结论；三处页面（板件明细/排样结果/材料统计）与领料单统一只认这一份 */
  boardSelect?: BoardSelectReport
  elapsedMs: number
  generatedAt: number
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  budgetCents: number // 板材花费上限（分），-1 = 不设限；0 = 预算为零（不下结论）
  boardStrategy: BoardSelectStrategy // 先挑最省 / 先挑板幅最大，二选一
  result?: NestResult
  /** 最近一次采纳排样时的参数与指纹（明细页据此提示「参数已变、结论过期」） */
  lastRun?: {
    kerfMm: number
    trimMm: number
    budgetCents: number
    boardStrategy: BoardSelectStrategy
    fingerprint: string
    partsSig: string
    boardsSig: string
  }
}

/** 领料单据/成本表的存档版本：已导出的单据据此判定是否需要作废。 */
export interface IssuedOrder {
  id: string
  jobId: string
  jobName: string
  issuedAt: number
  fingerprint: string
  summary: {
    boardsUsed: number
    totalCostCents: number
    byBoard: { boardId: string; boardName: string; sheets: number; subtotalCents: number }[]
  }
  voided: boolean
  voidReason?: string
}

/** 重算后逐项变化清单（板种张数 / 零件换板 / 单据与成本表行）。 */
export interface PlanChange {
  changed: boolean
  fingerprintChanged: boolean
  boardRows: {
    boardId: string
    boardName: string
    beforeSheets: number
    afterSheets: number
    beforeSubtotalCents: number
    afterSubtotalCents: number
    kind: 'added' | 'removed' | 'sheets' | 'same'
  }[]
  movedParts: {
    partId: string
    code: string
    name: string
    qty: number
    fromBoard: string
    toBoard: string
  }[]
  sheetBoardChanges: {
    sheetIndex: number
    before: string
    after: string
  }[]
  orderEffects: {
    issuedOrderId: string
    issuedAt: number
    status: 'void' | 'keep'
    reason: string
  }[]
  costTableRows: { label: string; before: string; after: string }[]
  paramChanges: string[]
  beforeFingerprint: string
  afterFingerprint: string
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}
