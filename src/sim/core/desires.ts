// 七宗罪欲望系统（DESIGN §3 欲望系统，P0 版）
// 欲望 = 满足度(0-100)，先天有罪孽倾向(个性权重)；定期检查 → 行为权重偏移 + 心情
// 长期不满足 → 恶意槽（反社会行为：偷窃/暴怒攻击）
// 数值参数来自 tuning（docs/DATA_DRIVEN.md §3.4）
import type { DesireTuning } from '../defs/tuning';

// 欲望 id 开放为 string：mod 可声明新欲望维度（卡 satisfies / 卡 desire 字段引用即生效）
export type DesireId = string;

// 欲望目录（label 供 HUD/日志显示）。mod 新欲望经 ModRegistry.registerDesire 加入，进入循环后初始值/衰减/匮乏/满足自动成立
export const DESIRES: Record<string, { label: string }> = {
  gluttony: { label: '暴食' },
  sloth:    { label: '懒惰' },
  greed:    { label: '贪婪' },
  envy:     { label: '嫉妒' },
  pride:    { label: '傲慢' },
  wrath:    { label: '暴怒' },
  lust:     { label: '色欲' },
};

// 动态取欲望目录（registerDesire 后生效，勿缓存 Object.keys 结果）
export function allDesires(): string[] {
  return Object.keys(DESIRES);
}

// 初始满足度（各罪 initMin ~ initMin+initRange，随机）—— 参数读 tuning.desire
export function initDesires(rng: { next(): number }, t: { initMin: number; initRange: number }): Record<DesireId, number> {
  const d = {} as Record<DesireId, number>;
  for (const k of allDesires()) d[k] = t.initMin + Math.floor(rng.next() * t.initRange);
  return d;
}

// 每 tick 衰减：无人满足的欲望缓慢流失（懒人易满足懒惰→流失慢，反之流失快）
export function tickDesires(
  d: Record<DesireId, number>,
  personality: Partial<Record<DesireId, number>>,
  dt: number,
  t: DesireTuning,
): void {
  for (const k of allDesires()) {
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
  for (const k of allDesires()) {
    if (d[k] < t.criticalAt) critical.push(k);
    else if (d[k] < t.scarceAt) scarce.push(k);
  }
  return { scarce, critical };
}
