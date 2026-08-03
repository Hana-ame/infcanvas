// 小人需求系统（P0 简化）：饥饿/休息/心情
// 需求不满足 → 行为变化（意图失真简化版）

export interface Needs {
  food: number; // 0-100，100=饱，<30 饿
  rest: number; // 0-100，100=精力足，<30 困
  mood: number; // 0-100，心情
  san: number;  // 0-100，理智（SAN）：目睹死亡/恐怖事件 ↓，篝火/休息恢复
}

export function initNeeds(): Needs {
  return { food: 80, rest: 90, mood: 60, san: 100 };
}

// 每 tick 衰减
export function tickNeeds(n: Needs, dt: number): void {
  n.food -= 0.15 * dt; // 饿
  n.rest -= 0.08 * dt; // 困
  // 心情随满足度漂移（简化）
  if (n.food < 30) n.mood -= 0.05 * dt;
  else if (n.food > 70) n.mood += 0.01 * dt;
  // 理智缓慢自然恢复（人天生会自我调节）
  n.san += 0.02 * dt;
  // 严重受创（重伤/低满足）动摇理智
  if (n.food < 15 || n.mood < 15) n.san -= 0.03 * dt;
  n.food = clamp(n.food);
  n.rest = clamp(n.rest);
  n.mood = clamp(n.mood);
  n.san = clamp(n.san);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// 紧急需求：返回最高优先级的动作（返回 null = 无紧急需求）
export function urgentNeedAction(n: Needs): 'eat' | 'rest' | null {
  if (n.food < 30) return 'eat';
  if (n.rest < 20) return 'rest';
  return null;
}
