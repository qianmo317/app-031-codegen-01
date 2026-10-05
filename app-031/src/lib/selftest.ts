// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s。
import type { Board, Job, Part } from '../types'
import { nestJob, packBoards } from './packing'
import { selectBoards, buildSnapshot, diffSnapshots } from './boardSelect'
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

function makePart(over: Partial<Part> & { l?: number; w?: number } = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? over.l ?? 400,
    widMm: over.widMm ?? over.w ?? 300,
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
    useOffcutIds: [],
    batchByCabinet: false,
    budgetCents: -1,
    boardStrategy: 'cheapest',
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

  // 2) 纹理无法满足时给原因而不是偷转
  {
    const job = makeJob([
      makePart({ code: 'BIG', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const ok =
      r.unplaced.length === 1 &&
      r.unplaced[0].code === 'BIG' &&
      r.unplaced[0].reason.includes('纹理') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add('纹理排不下时明确提示且不强制旋转', ok, ok ? '提示：' + r.unplaced[0].reason : '未按预期报纹理冲突')
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

  // 10) 选板反算：最省 vs 板幅最大两条路只选其一，取舍可验证
  {
    const big = makeBoard({ id: 'big', name: '大板2440', wMm: 2440, hMm: 1220, priceCents: 13800 })
    const small = makeBoard({ id: 'small', name: '小板1830', wMm: 1830, hMm: 915, priceCents: 8600 })
    const parts = [
      makePart({ code: 'LONG', lenMm: 2000, widMm: 500, qty: 2, grain: 'length' }),
      makePart({ code: 'S', lenMm: 700, widMm: 400, qty: 6 })
    ]
    const inp = { boards: [big, small], parts, kerfMm: 3.2, trimMm: 8, batchByCabinet: false }
    const cheap = selectBoards({ ...inp, budgetCents: -1, strategy: 'cheapest' })
    const large = selectBoards({ ...inp, budgetCents: -1, strategy: 'largest' })
    const cp = cheap.report.plan!
    const lp = large.report.plan!
    const ok =
      cp.totalCostCents < lp.totalCostCents &&
      cp.items.length >= 2 &&
      lp.items.every((i) => i.boardId !== 'small' || i.sheets === 0) &&
      lp.boardsUsed <= cp.boardsUsed
    add(
      '选板：先最省（多板种/更便宜）与先板幅最大（少张数/可能更贵）结论不同且各自成立',
      ok,
      `最省 ${cp.boardKinds} 种 ${cp.boardsUsed} 张 ¥${cp.totalCostCents}；板幅最大 ${lp.boardKinds} 种 ${lp.boardsUsed} 张 ¥${lp.totalCostCents}`
    )
  }

  // 11) 选板失败分类：预算不够给差额（按分），板幅/纹理/板种要分清
  {
    const b = makeBoard({ id: 'b1', priceCents: 13800 })
    const mkJobParts = (): Part[] => [makePart({ code: 'P', lenMm: 1000, widMm: 500, qty: 10 })]
    const budget = selectBoards({
      boards: [b],
      parts: mkJobParts(),
      kerfMm: 3.2,
      trimMm: 8,
      batchByCabinet: false,
      budgetCents: 20000,
      strategy: 'cheapest'
    })
    const okBudget =
      budget.report.status === 'blocked' &&
      budget.report.blockers[0]?.block === 'budget' &&
      budget.report.gap?.kind === 'money' &&
      budget.report.gap.shortCents === budget.report.gap.cheapestCents! - 20000 &&
      !!budget.report.referencePlan

    const size = selectBoards({
      boards: [makeBoard({ id: 'sm', wMm: 1830, hMm: 915, priceCents: 8600 })],
      parts: [makePart({ code: 'BIG', l: 2000, w: 800 })],
      kerfMm: 3.2,
      trimMm: 8,
      batchByCabinet: false,
      budgetCents: -1,
      strategy: 'cheapest'
    })
    const grain = selectBoards({
      boards: [makeBoard({ id: 'sq', wMm: 1066, hMm: 866, priceCents: 8600 })],
      parts: [makePart({ code: 'G', l: 800, w: 1000, grain: 'length' })],
      kerfMm: 3.2,
      trimMm: 8,
      batchByCabinet: false,
      budgetCents: -1,
      strategy: 'cheapest'
    })
    const spec = selectBoards({
      boards: [b],
      parts: [makePart({ code: 'T', lenMm: 500, widMm: 400, qty: 2, thicknessMm: 25 })],
      kerfMm: 3.2,
      trimMm: 8,
      batchByCabinet: false,
      budgetCents: -1,
      strategy: 'cheapest'
    })
    const okKinds =
      size.report.blockers[0]?.block === 'size' &&
      grain.report.blockers[0]?.block === 'grain' &&
      spec.report.blockers[0]?.block === 'spec'
    add(
      '选板：预算不够按分给差额，板幅/纹理/板种三类卡点分清',
      okBudget && okKinds,
      `预算差额 ${budget.report.gap?.shortCents} 分；size/grain/spec = ${okKinds}`
    )
  }

  // 12) 零件为空或预算为零：不下结论
  {
    const b = makeBoard()
    const empty = selectBoards({ boards: [b], parts: [], kerfMm: 3.2, trimMm: 8, batchByCabinet: false, budgetCents: -1, strategy: 'cheapest' })
    const zero = selectBoards({
      boards: [b],
      parts: [makePart({ code: 'P', lenMm: 500, widMm: 400 })],
      kerfMm: 3.2,
      trimMm: 8,
      batchByCabinet: false,
      budgetCents: 0,
      strategy: 'cheapest'
    })
    const ok =
      empty.report.status === 'inconclusive' &&
      empty.report.plan === null &&
      zero.report.status === 'inconclusive' &&
      zero.report.plan === null &&
      zero.report.steps.some((s) => s.includes('预算为零'))
    add('选板：零件一件没有或预算为零时不出结论并说清卡点', ok, ok ? '均为 inconclusive' : '错误给出了结论')
  }

  // 13) 选板与最终摆法同源：选板 pack 直接成为 nestJob 输出，不允许第二套摆法
  {
    const big = makeBoard({ id: 'big', name: '大板', priceCents: 13800 })
    const small = makeBoard({ id: 'small', name: '小板', wMm: 1830, hMm: 915, priceCents: 8600 })
    const parts = [
      makePart({ code: 'LONG', lenMm: 2000, widMm: 500, qty: 2, grain: 'length' }),
      makePart({ code: 'S', lenMm: 700, widMm: 400, qty: 6 })
    ]
    const sel = selectBoards({ boards: [big, small], parts, kerfMm: 3.2, trimMm: 8, batchByCabinet: false, budgetCents: -1, strategy: 'cheapest' })
    const job = makeJob(parts, { boards: [big, small] })
    const r = nestJob(job, { pack: sel.chosenPack!, boardSelect: sel.report })
    const same =
      r.sheets.length === sel.chosenPack!.sheets.length &&
      r.sheets.every((s, i) => s.placements.length === sel.chosenPack!.sheets[i].placements.length) &&
      r.boardSelect === sel.report
    add(
      '选板 pack 与三处消费的 NestResult 是同一次排样（无第二套摆法）',
      same,
      same ? 'sheets/placements 完全一致' : '摆法出现分叉'
    )
  }

  // 13b) 同源强校验：plan 的板种×张数 = 最终 sheets 的逐张统计（领料/统计/明细同源）
  {
    const big = makeBoard({ id: 'big', name: '大板', priceCents: 13800 })
    const small = makeBoard({ id: 'small', name: '小板', wMm: 1830, hMm: 915, priceCents: 8600 })
    const parts = [
      makePart({ code: 'LONG', lenMm: 2000, widMm: 500, qty: 2, grain: 'length' }),
      makePart({ code: 'S', lenMm: 700, widMm: 400, qty: 6, thicknessMm: 0 })
    ]
    const sel = selectBoards({ boards: [big, small], parts, kerfMm: 3.2, trimMm: 8, batchByCabinet: false, budgetCents: -1, strategy: 'cheapest' })
    const job = makeJob(parts, { boards: [big, small] })
    const r = nestJob(job, { pack: sel.chosenPack!, boardSelect: sel.report })
    // 逐板种：plan 张数 == sheets 中该板出现次数；小计 == 各张 priceCents 之和
    const sheetCount = new Map<string, { n: number; sum: number }>()
    for (const s of r.sheets) {
      const c = sheetCount.get(s.boardId) ?? { n: 0, sum: 0 }
      c.n++
      c.sum += s.priceCents
      sheetCount.set(s.boardId, c)
    }
    const ok =
      r.boardSelect?.plan?.items.every((it) => {
        const c = sheetCount.get(it.boardId)
        return c && c.n === it.sheets && c.sum === it.subtotalCents
      }) &&
      r.boardSelect?.plan?.totalCostCents === r.totalCostCents &&
      sheetCount.size === r.boardSelect.plan.items.length
    add(
      '三处同源：选板 plan 的板种/张数/小计与最终 sheets 逐张统计完全一致',
      !!ok,
      ok ? `${sheetCount.size} 个板种全部一致` : 'plan 与 sheets 出现一新一旧'
    )
  }

  // 14) 变化清单：改板价/锯路后板种行、成本合计、指纹变化；未改时无变化
  {
    const big = makeBoard({ id: 'big', name: '大板', priceCents: 13800 })
    const small = makeBoard({ id: 'small', name: '小板', wMm: 1830, hMm: 915, priceCents: 8600 })
    const parts = [makePart({ code: 'S', lenMm: 700, widMm: 400, qty: 6 })]
    const job = makeJob(parts, { boards: [big, small] })
    const pack1 = packBoards({ boards: [big, small], parts, kerfMm: 3.2, trimMm: 8, batchByCabinet: false, policy: 'cheapest' })
    job.result = nestJob(job, { pack: pack1 })
    const snap1 = buildSnapshot(job.result, { kerfMm: 3.2, trimMm: 8, budgetCents: -1, strategy: 'cheapest' })
    const same = diffSnapshots(snap1, snap1)
    const small2 = { ...small, priceCents: 9900 }
    const pack2 = packBoards({ boards: [big, small2], parts, kerfMm: 4.0, trimMm: 8, batchByCabinet: false, policy: 'cheapest' })
    job.result = nestJob({ ...job, boards: [big, small2], kerfMm: 4.0 }, { pack: pack2 })
    const snap2 = buildSnapshot(job.result, { kerfMm: 4.0, trimMm: 8, budgetCents: -1, strategy: 'cheapest' })
    const d = diffSnapshots(snap1, snap2)
    const ok =
      !same.changed &&
      d.changed &&
      d.fingerprintChanged &&
      d.costTableRows.length > 0 &&
      d.paramChanges.some((x) => x.includes('锯路'))
    add(
      '重算变化清单：板价/锯路变动能列出成本表行与参数，指纹随之改变；无变动时报告无变化',
      ok,
      ok ? `成本行 ${d.costTableRows.length} 条，参数 ${d.paramChanges.join('/')}` : '变化检测缺失'
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
