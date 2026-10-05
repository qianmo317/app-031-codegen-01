// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s。
// 另含选板与花费反算：同一内核、失败分型（纹理/板幅/预算）、厚度约束、二选一策略。
import type { Board, Job, Part } from '../types'
import { nestJob } from './packing'
import { selectBoards } from './selector'
import { simulate, countSawOps } from './cuts'
import { guillotineViolation, type Rect } from './geometry'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  elapsedMs: number
  checks: CheckResult[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let boardSeq = 0
let partSeq = 0

function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: `b${boardSeq++}`,
    name: over.name ?? '测试板 2440×1220',
    wMm: over.wMm ?? 2440,
    hMm: over.hMm ?? 1220,
    thicknessMm: 18,
    material: '颗粒板',
    priceCents: 13800,
    quantity: 0,
    kind: 'stock',
    ...over
  }
}

function makePart(over: Partial<Part> = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? 400,
    widMm: over.widMm ?? 300,
    qty: over.qty ?? 1,
    grain: over.grain ?? 'none',
    edgeBands: over.edgeBands ?? [],
    cabinet: over.cabinet ?? '柜A',
    exposed: over.exposed ?? false,
    boardId: over.boardId ?? '',
    thicknessMm: over.thicknessMm ?? 0
  }
}

function makeJob(parts: Part[], over: Partial<Job> = {}): Job {
  return {
    id: `j${partSeq}`,
    name: '测试任务',
    createdAt: 0,
    boards: over.boards ?? [makeBoard()],
    parts,
    kerfMm: over.kerfMm ?? 3.2,
    trimMm: over.trimMm ?? 8,
    budgetCents: over.budgetCents ?? 0,
    strategy: over.strategy ?? 'cheapest',
    useOffcutIds: [],
    batchByCabinet: false,
    selectionRevision: 0,
    ...over
  }
}

/** 检查同板任意两件之间的净距：只要相邻就必须 ≥ kerf；四周 ≥ trim。 */
function assertClearances(job: Job): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  for (const sheet of job.result!.sheets) {
    const ps = sheet.placements
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06) return '零件越过修边区（左下）'
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06) return '零件越过修边区（右）'
      if (p.y + p.widMm > sheet.hMm - trim + 0.06) return '零件越过修边区（上）'
    }
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06) return '零件重叠'
        // 同向投影有重叠时，另一轴的净距必须 ≥ kerf
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
      }
    }
  }
  return null
}

function dumpJob(job: Job, err?: string): void {
  console.error('DUMP_KERF', job.kerfMm, 'TRIM', job.trimMm, 'ERR', err ?? '')
  for (const p of job.parts) {
    console.error(
      'DUMP_PART',
      JSON.stringify({
        c: p.code,
        l: p.lenMm,
        w: p.widMm,
        q: p.qty,
        g: p.grain,
        e: p.edgeBands.join(''),
        x: p.exposed ? 1 : 0
      })
    )
  }
  const m = err?.match(/板(\d+)/)
  if (m && job.result) {
    const sheet = job.result.sheets[Number(m[1]) - 1]
    if (sheet) {
      console.error('DUMP_SHEET', sheet.wMm, sheet.hMm)
      for (const p of sheet.placements)
        console.error('DUMP_PL', p.code, p.x, p.y, p.lenMm, p.widMm, p.grain)
      for (const st of sheet.steps)
        console.error('DUMP_ST', st.order, st.kind, st.axis, st.at, st.span[0], st.span[1])
      const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
      console.error('DUMP_SIM', JSON.stringify(sim.errors))
      for (const lf of sim.leaves)
        console.error('DUMP_LEAF', Math.round(lf.x), Math.round(lf.y), Math.round(lf.w), Math.round(lf.h))
    }
  }
}

function assertSheet(job: Job): string | null {
  const r = job.result!
  for (const sheet of r.sheets) {
    // guillotine 合法性
    const rects = sheet.placements.map((p) => ({
      id: p.instanceId,
      x: p.x,
      y: p.y,
      w: p.lenMm,
      h: p.widMm
    }))
    const bounds: Rect = {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    }
    const v = guillotineViolation(rects, bounds, job.kerfMm)
    if (v) return `板${sheet.index + 1}：${v}`
    // 逐步切割模拟
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) return `板${sheet.index + 1}：${sim.errors.join('；')}`
    // 利用率复算（分子不含锯路）
    const net = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1) return 'usedArea 与零件净面积不一致'
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      return '利用率复算不一致'
  }
  // 面积守恒不等式
  const boardArea = r.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const partArea = job.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  if (boardArea + 1 < partArea) return 'Σ板面积 < Σ零件面积'
  return null
}

export function runSelfTest(): SelfTestReport {
  boardSeq = 0
  partSeq = 0
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 100 组随机任务：零反例
  const rng = mulberry32((globalThis as { FCO_SEED?: number }).FCO_SEED ?? 20260925)
  let failures = 0
  let firstFailure = ''
  let totalInstances = 0
  for (let g = 0; g < 100; g++) {
    const kerf = +(2 + rng() * 2).toFixed(2)
    const trim = 5 + Math.floor(rng() * 6)
    const partKinds = 8 + Math.floor(rng() * 33)
    const parts: Part[] = []
    for (let i = 0; i < partKinds; i++) {
      const len = 120 + Math.floor(rng() * 980)
      const wid = 80 + Math.floor(rng() * 620)
      const gr = rng()
      parts.push(
        makePart({
          code: `R${g}-${i}`,
          lenMm: len,
          widMm: wid,
          qty: 1 + Math.floor(rng() * 3),
          grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
          edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
          cabinet: ['客厅柜', '衣柜', '橱柜', '书柜'][Math.floor(rng() * 4)],
          exposed: rng() < 0.3
        })
      )
    }
    const job = makeJob(parts, { kerfMm: kerf, trimMm: trim })
    const r = nestJob(job)
    job.result = r
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    totalInstances = parts.reduce((a, p) => a + p.qty, 0)
    // 尺寸被限制为一定排得下
    if (r.unplaced.length > 0) {
      failures++
      firstFailure = `组${g + 1}：存在 ${r.unplaced.length} 件未排下`
      continue
    }
    if (placed !== totalInstances) {
      failures++
      firstFailure = `组${g + 1}：守恒失败 ${placed}/${totalInstances}`
      continue
    }
    const clearanceErr = assertClearances(job)
    if (clearanceErr) {
      failures++
      firstFailure = `组${g + 1}：${clearanceErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job)
      continue
    }
    const sheetErr = assertSheet(job)
    if (sheetErr) {
      failures++
      firstFailure = `组${g + 1}：${sheetErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job, sheetErr)
      continue
    }
    // 纹理硬约束：零旋转
    const rotated = r.sheets.flatMap((s) => s.placements).filter((p) => {
      if (p.grain === 'none') return false
      if (p.rotated) return true
      if (p.grain === 'length' && !(p.lenMm === p.origLen && p.widMm === p.origWid)) return true
      if (p.grain === 'width' && !(p.lenMm === p.origWid && p.widMm === p.origLen)) return true
      return false
    })
    if (rotated.length > 0) {
      failures++
      firstFailure = `组${g + 1}：纹理件被旋转 ${rotated.length} 次`
    }
  }
  add(
    '100 组随机 guillotine 零反例（贯通/锯路/修边/守恒/模拟）',
    failures === 0,
    failures === 0
      ? '100/100 通过；每组均验证：逐步模拟可还原全部零件'
      : firstFailure
  )

  // 2) 纹理无法满足时给原因而不是偷转（含「板幅不够」与「纹理卡死」两类）
  {
    const job = makeJob([
      makePart({ code: 'GRAIN', lenMm: 1000, widMm: 1300, qty: 1, grain: 'length' }),
      makePart({ code: 'SIZE', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const byCode = Object.fromEntries(r.unplaced.map((u) => [u.code, u]))
    const ok =
      r.unplaced.length === 2 &&
      byCode.GRAIN.reason.includes('纹理') &&
      byCode.SIZE.reason.includes('板幅') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add(
      '排不下时分清「纹理卡死/板幅不够」且不强制旋转',
      ok,
      ok
        ? `纹理件：${byCode.GRAIN?.reason} ｜ 超幅件：${byCode.SIZE?.reason}`
        : `未排下 ${r.unplaced.map((u) => u.code).join(',')}：${JSON.stringify(r.unplaced.map((u) => u.reason))}`
    )
  }

  // 3) 锯路精确净距（两件相邻 = kerf）
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 500 }),
      makePart({ code: 'B', lenMm: 500, widMm: 500 })
    ])
    const r = nestJob(job)
    const ps = r.sheets[0].placements
    ps.sort((a, b) => a.y - b.y || a.x - b.x)
    const gap = ps[1].y - (ps[0].y + 500)
    const ok = Math.abs(gap - job.kerfMm) < 0.1
    add('相邻零件净距等于锯路 3.2mm', ok, `实测净距 ${gap.toFixed(2)}mm`)
  }

  // 4) 封边米数复算 + 见光分列
  {
    const job = makeJob([
      makePart({
        code: 'E1',
        lenMm: 500,
        widMm: 300,
        qty: 2,
        edgeBands: ['top', 'left'],
        exposed: true
      }),
      makePart({ code: 'E2', lenMm: 400, widMm: 200, qty: 1, edgeBands: ['top', 'bottom', 'left', 'right'] })
    ])
    const r = nestJob(job)
    const expectExposed = 2 * (0.5 + 0.3) // 1.6
    const expectNormal = 0.4 * 2 + 0.2 * 2 // 1.2
    const ok =
      Math.abs(r.edgeBandM.exposed - expectExposed) < 0.011 &&
      Math.abs(r.edgeBandM.normal - expectNormal) < 0.011
    add(
      '封边米数逐件复算一致且见光/非见光分列',
      ok,
      `见光 ${r.edgeBandM.exposed}m（期望 ${expectExposed}）、非见光 ${r.edgeBandM.normal}m（期望 ${expectNormal}）`
    )
  }

  // 5) 30 件标准件：锯切工步 ≤20 且模拟还原全部尺寸
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ops = countSawOps(r.sheets)
    const simsOk = r.sheets.every((s) =>
      simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok
    )
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = ops <= 20 && simsOk && placed === 30 && r.sheets.length === 2
    add(
      '30 零件锯切工步 ≤20 且按步模拟尺寸全部正确',
      ok,
      `${r.sheets.length} 张板、${ops} 个锯切工步（修边按叠切计 1 次）、模拟 ${simsOk ? '通过' : '失败'}`
    )
  }

  // 6) 余料作为小板参与下一轮排样
  {
    const small: Board = {
      id: 'offcut_test',
      name: '余料板 900×700',
      wMm: 900,
      hMm: 700,
      thicknessMm: 18,
      material: '颗粒板',
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    }
    const job = makeJob([makePart({ code: 'O1', lenMm: 500, widMm: 500 })], {
      boards: [small, makeBoard()]
    })
    const r = nestJob(job)
    const ok = r.sheets[0].boardId === 'offcut_test' && r.sheets.length === 1
    add('余料登记后优先作为小板材参与排样', ok, ok ? '零件排上了 900×700 余料板' : '余料未被优先使用')
  }

  // 7) 300 零件（40 种规格）性能
  {
    const rng2 = mulberry32(77)
    const parts: Part[] = []
    let qtyLeft = 300
    for (let i = 0; i < 40; i++) {
      const qty = Math.min(i === 39 ? qtyLeft : 7 + Math.floor(rng2() * 2), qtyLeft)
      qtyLeft -= qty
      parts.push(
        makePart({
          code: `F${i}`,
          lenMm: 150 + Math.floor(rng2() * 750),
          widMm: 120 + Math.floor(rng2() * 500),
          qty
        })
      )
    }
    const job = makeJob(parts)
    const r = nestJob(job)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = r.elapsedMs < 1500 && placed === 300
    add('300 零件排样 < 1.5s', ok, `耗时 ${r.elapsedMs}ms，用板 ${r.sheets.length} 张，就位 ${placed}/300`)
  }

  // 8) 手工微调合法性校验：合法布局通过，塞缝布局拒绝
  {
    const bounds: Rect = { x: 8, y: 8, w: 2424, h: 1204 }
    const legal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: '1', x: 8, y: 8, w: 600, h: 1196 },
      { id: '2', x: 611.2, y: 8, w: 600, h: 596 },
      { id: '3', x: 611.2, y: 607.2, w: 600, h: 596.8 }
    ]
    // 经典风车形非切分布局（5 块互相顶住，找不到任何一条贯通切线）
    const illegal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: 'B', x: 8, y: 8, w: 396.8, h: 600 },
      { id: 'C', x: 408, y: 8, w: 592, h: 396.8 },
      { id: 'E', x: 408, y: 408, w: 196.8, h: 196.8 },
      { id: 'A', x: 8, y: 608, w: 596.8, h: 396.8 },
      { id: 'D', x: 608, y: 408, w: 392, h: 596.8 }
    ]
    const okLegal = guillotineViolation(legal, bounds, 3.2) === null
    const okIllegal = guillotineViolation(illegal, bounds, 3.2) !== null
    add(
      '微调后 guillotine 合法性校验准确',
      okLegal && okIllegal,
      `合法布局 ${okLegal ? '放行' : '误拒'}；塞缝布局 ${okIllegal ? '拒绝' : '误放'}`
    )
  }

  // 9) 多板种混排 + 库存张数约束
  {
    const thin = makeBoard({
      id: 'thin',
      name: '背板 2440×1220×9',
      wMm: 2440,
      hMm: 1220,
      thicknessMm: 9,
      priceCents: 9800
    })
    const thick = makeBoard({ id: 'thick', name: '主板 2440×1220×18', quantity: 1 })
    const parts = [
      makePart({ code: 'T', lenMm: 1000, widMm: 600, qty: 5, boardId: 'thick' }),
      makePart({ code: 'B', lenMm: 1000, widMm: 600, qty: 2, boardId: 'thin' })
    ]
    const job = makeJob(parts, { boards: [thick, thin] })
    const r = nestJob(job)
    const thickSheets = r.sheets.filter((s) => s.thicknessMm === 18).length
    const thinSheets = r.sheets.filter((s) => s.thicknessMm === 9).length
    const shortage = r.stockShortage.find((x) => x.boardId === 'thick')
    const ok =
      thickSheets >= 2 && thinSheets === 1 && !!shortage && shortage.need >= 2 && shortage.have === 1
    add(
      '多板种混排且 18mm 库存仅 1 张时超开并提示补采',
      ok,
      `18mm 用 ${thickSheets} 张（库存 1，需补采）、9mm 用 ${thinSheets} 张`
    )
  }

  // 10) 选板与花费反算：出结论 + 同源行 + 预算不够差额
  {
    const cheap = makeBoard({ id: 'c1', name: '小板 1830×915×18', wMm: 1830, hMm: 915, priceCents: 8600 })
    const big = makeBoard({ id: 'b1', name: '大板 2440×1220×18', wMm: 2440, hMm: 1220, priceCents: 13800 })
    const parts = [makePart({ code: 'Q1', lenMm: 800, widMm: 500, qty: 6 })]
    const job = makeJob(parts, { boards: [cheap, big], budgetCents: 50000, strategy: 'cheapest' })
    const out = selectBoards(job, [...job.boards], null)
    const okConclusion =
      out.selection.status === 'conclusion' &&
      !!out.result &&
      out.result.unplaced.length === 0 &&
      out.result.materialLines.length >= 1 &&
      // 同源：sheets 张数之和 = materialLines.sheets 之和
      out.result.materialLines.reduce((a, l) => a + l.sheets, 0) === out.result.sheets.length &&
      out.result.sheets.every((s) =>
        out.result!.materialLines.some((l) => l.boardId === s.boardId && l.priceCents === s.priceCents)
      )
    add(
      '选板反算：预算内出结论，且领料行与每张板（板种/摊价）同源',
      okConclusion,
      okConclusion
        ? `${out.result!.materialLines.length} 种板 ${out.selection.totalSheets} 张 ${(
            (out.selection.totalCostCents ?? 0) / 100
          ).toFixed(2)} 元`
        : `状态 ${out.selection.status}：${out.selection.message}`
    )
    // 把预算压到不可能：应判 budget，并给出差额
    job.budgetCents = 100
    const out2 = selectBoards(job, [...job.boards], null)
    const okBudget =
      out2.selection.status === 'budget' &&
      (out2.selection.budgetShortCents ?? 0) === (out2.selection.cheapestCostCents ?? 0) - 100 &&
      (out2.selection.budgetShortSheets ?? 0) >= 1
    add(
      '选板反算：排得下但预算顶穿时判「预算不够」，按最省算差多少钱/几张',
      okBudget,
      okBudget
        ? `最省 ${out2.selection.cheapestCostCents} 分，差 ${out2.selection.budgetShortCents} 分，约 ${out2.selection.budgetShortSheets} 张`
        : `状态 ${out2.selection.status}`
    )
    // 预算为 0 / 无零件：不出结论
    job.budgetCents = 0
    const out3 = selectBoards(job, [...job.boards], null)
    job.budgetCents = 50000
    const emptyJob = makeJob([], { boards: [cheap, big], budgetCents: 50000 })
    const out4 = selectBoards(emptyJob, [...emptyJob.boards], null)
    add(
      '选板反算：预算为 0 或一件都没排时不出结论并讲清卡点',
      out3.selection.status === 'inconclusive' &&
        out3.selection.blockKind === 'zero-budget' &&
        out4.selection.status === 'inconclusive' &&
        out4.selection.blockKind === 'empty',
      `预算0→${out3.selection.blockKind}；空清单→${out4.selection.blockKind}`
    )
  }

  // 11) 失败分型：纹理卡死 vs 板幅不够
  {
    const board = makeBoard({ id: 'g1', name: '板 2440×1220×18', wMm: 2440, hMm: 1220 })
    // 2500×300 竖纹：长边沿 x 需要 2500 > 2440-16；旋转后 300×2500 仍超过 1220 → 板幅不够
    const tooLong = makePart({ code: 'TL', lenMm: 2500, widMm: 300, grain: 'length' })
    const j1 = makeJob([tooLong], { boards: [board], budgetCents: 999999 })
    const o1 = selectBoards(j1, [...j1.boards], null)
    // 1300×400 竖纹：x 需要 1300（板宽方向 1220 不够？板 2440 长够，1220 宽放 400 够 → 实际能排下）
    // 构造纹理卡死：1000×1300 竖纹 → x 放 1000、y 放 1300>1204 不行；旋转 x1300 y1000 可以
    const grainLocked = makePart({ code: 'GL', lenMm: 1000, widMm: 1300, grain: 'length' })
    const j2 = makeJob([grainLocked], { boards: [board], budgetCents: 999999 })
    const o2 = selectBoards(j2, [...j2.boards], null)
    add(
      '选板分型：板幅不够 vs 纹理卡死（不许旋转硬塞）',
      o1.selection.blockKind === 'size' && o2.selection.blockKind === 'grain',
      `2500 竖纹→${o1.selection.blockKind}；1000×1300 竖纹→${o2.selection.blockKind}`
    )
  }

  // 12) 指定厚度：件只能上同厚度板
  {
    const b18 = makeBoard({ id: 't18', name: '板 18', thicknessMm: 18, priceCents: 13800 })
    const b25 = makeBoard({ id: 't25', name: '板 25', wMm: 2440, hMm: 1220, thicknessMm: 25, priceCents: 17500 })
    const p25 = makePart({ code: 'P25', lenMm: 600, widMm: 400, qty: 2, thicknessMm: 25 })
    const job = makeJob([p25], { boards: [b18, b25], budgetCents: 999999 })
    const out = selectBoards(job, [...job.boards], null)
    const ok =
      out.selection.status === 'conclusion' &&
      out.result!.sheets.every((s) => s.thicknessMm === 25)
    add('指定厚度的件只排同厚度板', ok, ok ? `全部上 25mm` : `状态 ${out.selection.status}`)
  }

  // 13) 选板与排样同一内核：选板结果的每张板仍通过 guillotine 校验与切割模拟
  {
    const boards = [
      makeBoard({ id: 'z1', name: 'Z18a', wMm: 2440, hMm: 1220, priceCents: 13800 }),
      makeBoard({ id: 'z2', name: 'Z18b', wMm: 1830, hMm: 915, priceCents: 8600 }),
      makeBoard({ id: 'z3', name: 'Z2745', wMm: 2745, hMm: 1220, priceCents: 16800 })
    ]
    const parts: Part[] = []
    for (let i = 0; i < 24; i++) {
      parts.push(
        makePart({
          code: `Z${i}`,
          lenMm: 300 + (i % 5) * 120,
          widMm: 200 + (i % 3) * 90,
          qty: 1 + (i % 2),
          grain: i % 4 === 0 ? 'length' : 'none'
        })
      )
    }
    const job = makeJob(parts, { boards, budgetCents: 999999, strategy: 'cheapest' })
    const out = selectBoards(job, [...job.boards], null)
    job.result = out.result
    const err = out.result ? assertSheet(job) : '无结果'
    add(
      '选板枚举复用同一排样内核：结论每张板贯通合法、模拟还原',
      out.selection.status === 'conclusion' && err === null,
      err ?? `用板 ${out.result!.sheets.length} 张，全部通过 guillotine/模拟/锯路校验`
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
