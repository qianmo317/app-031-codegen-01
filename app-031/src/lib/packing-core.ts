// 选板与排样共用的判定内核（唯一路径）：
// 板种/厚度匹配、纹理朝向、余隙（0 或 ≥锯路）、四周修边后的可放入性、
// 以及「为什么排不下」（纹理卡死 / 板幅不够）的分型都在这里。
// 选板枚举（selector.ts）与排样装箱（packing.ts）都只能调用这里的判定，
// 不允许为选板另写一套孤立算法。
import type { Board, Part } from '../types'
import { EPS } from './geometry'

export interface Orient {
  pw: number // 实际占 x 方向
  ph: number // 实际占 y 方向
  rotated: boolean
}

/** 统一为横向板（长边沿 x）。余料上台可以转，所以归一化安全。 */
export function normalizeBoard(b: Board): Board {
  if (b.wMm >= b.hMm) return b
  return { ...b, wMm: b.hMm, hMm: b.wMm }
}

export function partThickness(p: Part): number {
  return p.thicknessMm && p.thicknessMm > 0 ? p.thicknessMm : 0
}

/**
 * 板件与板种是否对得上：
 * - 指定 boardId：只认该板；指定板若是余料上台，则同厚度的余料板也算对得上
 * - 指定厚度（part.thicknessMm>0）：必须同厚度
 * 与 packing.ts 历史行为保持一致，仅新增「指定厚度」这一条硬约束。
 */
export function boardMatchesPart(b: Board, p: Part, defs: Map<string, Board>): boolean {
  if (partThickness(p) > 0 && partThickness(p) !== b.thicknessMm) return false
  if (!p.boardId) return true
  if (b.id === p.boardId) return true
  if (b.kind === 'offcut') {
    const target = defs.get(p.boardId)
    return !!target && target.thicknessMm === b.thicknessMm
  }
  return false
}

/** 只允许严丝合缝（0）或余隙 ≥ 锯路；0<余隙<锯路 时下不了刀，禁止放入。 */
export function fitsClean(avail: number, size: number, kerf: number): boolean {
  const gap = avail - size
  return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
}

/**
 * 纹理朝向（与排样内核完全一致）：
 * length 竖纹 → 长边沿 x、不旋转；width 横纹 → 短边沿 x、不旋转；
 * none 可转；正方形不需要转。竖纹件与横纹件绝不靠转方向硬塞。
 */
export function orientsOf(p: Part): Orient[] {
  if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
  if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  return [
    { pw: p.lenMm, ph: p.widMm, rotated: false },
    { pw: p.widMm, ph: p.lenMm, rotated: true }
  ]
}

/** 一件能否按纹理/锯路/修边约束排上某张板（板按横向归一化后判定）。 */
export function canPlaceOnBoard(p: Part, b: Board, kerf: number, trim: number): boolean {
  const n = normalizeBoard(b)
  const uw = n.wMm - 2 * trim
  const uh = n.hMm - 2 * trim
  return orientsOf(p).some((o) => fitsClean(uw, o.pw, kerf) && fitsClean(uh, o.ph, kerf))
}

export type BlockKind = 'grain' | 'size'

/**
 * 一件在所有「对得上」的板上都排不下时的分型：
 * - grain：受纹理朝向限制排不下，但放开旋转本可排下（纹理要求卡死）
 * - size ：即使允许旋转也排不下（板幅不够），或根本没有对得上板种/厚度的板
 */
export function blockKind(
  p: Part,
  boards: Board[],
  defs: Map<string, Board>,
  kerf: number,
  trim: number
): { kind: BlockKind; reason: string } | null {
  const matching = boards.filter((b) => boardMatchesPart(b, p, defs))
  const fitsConstrained = (o: Orient): boolean =>
    matching.some((b) => {
      const n = normalizeBoard(b)
      return (
        fitsClean(n.wMm - 2 * trim, o.pw, kerf) && fitsClean(n.hMm - 2 * trim, o.ph, kerf)
      )
    })
  if (orientsOf(p).some(fitsConstrained)) return null
  if (matching.length === 0) {
    return {
      kind: 'size',
      reason: '没有对得上指定板种/厚度的板材，先在板材库里添加或改指定'
    }
  }
  // 放开旋转试一次：能排下说明是纹理卡死，否则才是板幅不够
  const swapped: Orient =
    p.grain === 'length'
      ? { pw: p.widMm, ph: p.lenMm, rotated: true }
      : { pw: p.lenMm, ph: p.widMm, rotated: true }
  if (p.grain !== 'none' && fitsConstrained(swapped)) {
    return {
      kind: 'grain',
      reason:
        p.grain === 'length'
          ? `竖纹纹理件 ${p.lenMm}×${p.widMm} 不可旋转，对得上的板幅面（扣修边后）都不够；放开旋转本可排下，但竖纹要求卡死`
          : `横纹纹理件 ${p.lenMm}×${p.widMm} 不可旋转，对得上的板幅面（扣修边后）都不够；放开旋转本可排下，但横纹要求卡死`
    }
  }
  const maxW = Math.max(...matching.map((b) => normalizeBoard(b).wMm - 2 * trim))
  const maxH = Math.max(...matching.map((b) => normalizeBoard(b).hMm - 2 * trim))
  return {
    kind: 'size',
    reason: `板幅不够：${p.lenMm}×${p.widMm} 超过所有对得上的板的可用幅面（最大约 ${Math.round(
      maxW
    )}×${Math.round(maxH)}，已扣修边 ${trim}mm 与锯路 ${kerf}mm）`
  }
}
