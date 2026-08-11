// 小人需求系统（P0 简化）：饥饿/休息/心情
// 需求不满足 → 行为变化（意图失真简化版）
// 数值参数来自 tuning（docs/DATA_DRIVEN.md §3.4），不写死魔法数字
import type { NeedsTuning } from '../defs/tuning';

export interface Needs {
  food: number; // 0-100，100=饱，<30 饿
  rest: number; // 0-100，100=精力足，<30 困
  mood: number; // 0-100，心情
  san: number;  // 0-100，理智（SAN）：目睹死亡/恐怖事件 ↓，篝火/休息恢复
}

export function initNeeds(t: NeedsTuning): Needs {
  return { food: t.initFood, rest: t.initRest, mood: t.initMood, san: t.initSan };
}

// 每 tick 衰减（t = tuning.needs）
export function tickNeeds(n: Needs, dt: number, t: NeedsTuning): void {
  n.food -= t.foodDecay * dt; // 饿
  n.rest -= t.restDecay * dt; // 困
  // 心情随满足度漂移（简化）
  if (n.food < t.foodMoodLow) n.mood -= t.moodDriftDown * dt;
  else if (n.food > t.foodMoodHigh) n.mood += t.moodDriftUp * dt;
  // 理智缓慢自然恢复（人天生会自我调节）
  n.san += t.sanRecover * dt;
  // 严重受创（重伤/低满足）动摇理智
  if (n.food < t.sanTraumaThreshold || n.mood < t.sanTraumaThreshold) n.san -= t.sanTraumaDrain * dt;
  n.food = clamp(n.food);
  n.rest = clamp(n.rest);
  n.mood = clamp(n.mood);
  n.san = clamp(n.san);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// 紧急需求：返回最高优先级的动作（返回 null = 无紧急需求）
export function urgentNeedAction(n: Needs, t: NeedsTuning): 'eat' | 'rest' | null {
  if (n.food < t.hungerAt) return 'eat';
  if (n.rest < t.sleepyAt) return 'rest';
  return null;
}
