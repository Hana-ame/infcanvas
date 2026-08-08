// 行为倾向（勒沙特列原理反馈）—— 用户指定：只存概率，按 profit 调整，自然动态平衡
// 每个行为有倾向（0-100，越靠近 100 越倾向做）；每次执行后按实际收益调整：
//   收益高 → 倾向↑（多做有好处的事）；收益低/亏 → 倾向↓
// 倾向进入抽卡权重（持久调制），形成负反馈自平衡（勒沙特列原理）
// 数据驱动：LEANS 表定义行为 key + 倾向调整参数（mod 可扩展）

export type LeanKey = string;

export interface LeanDef {
  key: LeanKey;
  label: string;        // 行为名（日志/显示）
  adjust: number;       // 每次执行的倾向调整基础量（正=偏向该行为）
  max?: number;         // 倾向上限（默认 100）
}

// 内建行为倾向（数据驱动：mod 加新行为 = 加一行）
export const LEANS: Record<LeanKey, LeanDef> = {
  chop:    { key: 'chop', label: '伐木', adjust: 1.5 },
  mine:    { key: 'mine', label: '采矿', adjust: 1.5 },
  caveMine:{ key: 'caveMine', label: '矿洞采掘', adjust: 1.2 },
  build:   { key: 'build', label: '建造', adjust: 1.5 },
  eat:     { key: 'eat', label: '进食', adjust: 2 },
  rest:    { key: 'rest', label: '休息', adjust: 1.8 },
  pray:    { key: 'pray', label: '祈祷', adjust: 1 },
  heal:    { key: 'heal', label: '疗伤', adjust: 2 },
  idle:    { key: 'idle', label: '闲逛', adjust: 1 },
};

// 初始化倾向（中性 50，带轻微个性偏移）
export function initLean(rng: { next(): number }): Record<LeanKey, number> {
  const out: Record<LeanKey, number> = {};
  for (const k of Object.keys(LEANS)) {
    out[k] = 45 + Math.floor(rng.next() * 10); // 45-55 中性
  }
  return out;
}

// 勒沙特列反馈：执行某行为后，按 profit（正=收益，负=亏损）调整倾向
// profit 是实际收益差（如采到矿 +n、白干 -n），倾向随之增减 → 自然平衡
export function adjustLean(
  lean: Record<LeanKey, number>,
  key: LeanKey,
  profit: number,
  def: LeanDef = LEANS[key],
): void {
  if (!def) return;
  const cur = lean[key] ?? 50;
  // profit>0 倾向升（值得做），profit<0 倾向降（不划算）
  const delta = def.adjust * profit;
  const max = def.max ?? 100;
  lean[key] = Math.max(5, Math.min(max, cur + delta));
}
