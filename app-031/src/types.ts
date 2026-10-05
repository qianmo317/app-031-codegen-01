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
  thicknessMm?: number // 指定厚度（mm），0/空 = 不限；只允许排上同厚度的板
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

// ── 选板与花费反算 ────────────────────────────────────────────────
// 二选一策略：先挑最省（总价优先）/ 先挑最大板幅（张数优先）
export type SelectStrategy = 'cheapest' | 'largest'
// 选板失败/不出结论的分型
export type SelectBlockKind = 'grain' | 'size' | 'budget' | 'empty' | 'zero-budget'

/** 领料/成本的唯一行结构（板件明细页、排样结果页、材料统计页、打印领料单全部消费它） */
export interface MaterialLine {
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number // 单价（分）
  sheets: number // 张数
  subtotalCents: number // 小计（分）= 单价 × 张数
}

export interface BlockedItem {
  partId: string
  code: string
  name: string
  qty: number
  kind: SelectBlockKind
  reason: string
}

/** 选板输入快照：用于判断「改一次锯路/修边/板价」到底变了什么 */
export interface SelectInputSnapshot {
  kerfMm: number
  trimMm: number
  budgetCents: number
  strategy: SelectStrategy
  boards: { id: string; name: string; wMm: number; hMm: number; thicknessMm: number; priceCents: number }[]
  parts: { id: string; lenMm: number; widMm: number; qty: number; grain: GrainDemand; boardId?: string; thicknessMm?: number }[]
  useOffcutIds: string[]
  batchByCabinet: boolean
}

/** 与上一版选板结论相比的逐条变化清单 */
export interface SelectionDiff {
  paramChanges: string[]
  /** 板种或张数变了的行（含新增/删除） */
  boardLines: { boardName: string; before: number | null; after: number | null; priceChanged?: boolean }[]
  /** 换了板的零件（实例号 + 件名） */
  movedParts: { instanceId: string; code: string; name: string; fromBoard: string; toBoard: string }[]
  /** 每张板（按新序号）的摆法是否重算 */
  sheetsChanged: { index: number; boardName: string; changed: boolean }[]
  /** 领料单据 / 成本表上变化的行 */
  costRows: { boardName: string; beforeSubtotalCents: number | null; afterSubtotalCents: number | null }[]
  costDeltaCents: number
  boardKindCountBefore: number
  boardKindCountAfter: number
  revisionBump: boolean
}

export interface SelectionState {
  budgetCents: number
  strategy: SelectStrategy
  revision: number // 结论版次：输入变化导致结论变化时 +1
  status: 'conclusion' | 'budget' | 'blocked' | 'inconclusive'
  // 出结论时
  totalCostCents?: number
  totalSheets?: number
  boardKindCount?: number
  alternate?: { strategy: SelectStrategy; totalCostCents: number; totalSheets: number; boardKindCount: number }
  // 预算不够 / 板幅不够 / 纹理卡死
  blockKind?: SelectBlockKind
  blockedItems?: BlockedItem[]
  cheapestCostCents?: number // 不卡预算时最省方案的钱
  budgetShortCents?: number // 距预算还差多少分
  budgetShortSheets?: number // 折合还差几张「最便宜的可用板」
  message: string
  candidatesTried?: number
  generatedAt: number
  lastDiff?: SelectionDiff
  prevSnapshot?: SelectInputSnapshot
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number> // 兼容旧字段；新代码一律消费 materialLines
  materialLines: MaterialLine[] // 三处同源的唯一领料/成本行
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  elapsedMs: number
  generatedAt: number
  selection?: SelectionState
}

export interface IssuedRequisition {
  id: string
  jobId: string
  jobName: string
  revision: number
  issuedAt: number
  strategy: SelectStrategy
  budgetCents: number
  lines: MaterialLine[]
  totalCostCents: number
  totalSheets: number
  voided: boolean
  voidedAt?: number
  voidReason?: string
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  budgetCents: number // 板材花费上限（分）；0 = 未设定，选板不给结论
  strategy: SelectStrategy // 选板取舍，二选一（默认先挑最省）
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  selectionRevision: number // 当前选板结论版次（与 result.selection.revision 一致）
  result?: NestResult
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
