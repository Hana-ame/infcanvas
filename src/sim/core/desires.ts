// 七宗罪欲望系统（DESIGN §3 欲望系统，P0 版）
// 欲望 = 满足度(0-100)，先天有罪孽倾向(个性权重)；定期检查 → 行为权重偏移 + 心情
// 长期不满足 → 恶意槽（反社会行为：偷窃/暴怒攻击）
// 数值参数来自 tuning（docs/DATA_DRIVEN.md §3.4）
import type { DesireTuning } from '../defs/tuning';

export type DesireId = 'gluttony' | 'sloth' | 'greed' | 'envy' | 'pride' | 'wrath' | 'lust';

export const DESIRES: Record<DesireId, { label: string }> = {
  gluttony: { label: '暴食' },
  sloth:    { label: '懒惰' },
  greed:    { label: '贪婪' },
  envy:     { label: '嫉妒' },
  pride:    { label: '傲慢' },
  wrath:    { label: '暴怒' },
  lust:     { label: '色欲' },
};

export const ALL_DESIRES = Object.keys(DESIRES) as DesireId[];

// 初始满足度（各罪 50-75，随机）
export function initDesires(rng: { next(): number }): Record<DesireId, number> {
  const d = {} as Record<DesireId, number>;
  for (const k of ALL_DESIRES) d[k] = 50 + Math.floor(rng.next() * 25);
  return d;
}

// 每 tick 衰减：无人满足的欲望缓慢流失（懒人易满足懒惰→流失慢，反之流失快）
export function tickDesires(
  d: Record<DesireId, number>,
  personality: Partial<Record<DesireId, number>>,
  dt: number,
  t: DesireTuning,
): void {
  for (const k of ALL_DESIRES) {
    // 先天倾向高 → 该欲望流失快（更"欲求不满"）
    const lustFactor = 1 + ((personality[k] ?? 0.5) - 0.5) * t.personalityFactor;
    d[k] = clamp(d[k] - t.decayPerSec * lustFactor * dt);
  }
}

export function fulfill(d: Record<DesireId, number>, id: DesireId, amount: number): void {
  d[id] = clamp(d[id] + amount);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// 欲望检查结论：哪些欲望处于匮乏(<scarceAt)/危急(<criticalAt)
export function starvingDesires(d: Record<DesireId, number>, t: DesireTuning): { scarce: DesireId[]; critical: DesireId[] } {
  const scarce: DesireId[] = [];
  const critical: DesireId[] = [];
  for (const k of ALL_DESIRES) {
    if (d[k] < t.criticalAt) critical.push(k);
    else if (d[k] < t.scarceAt) scarce.push(k);
  }
  return { scarce, critical };
}
