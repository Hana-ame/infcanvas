// 种子化 RNG —— 保证 sim 回放可复现
// mulberry32：简单快速的确定性伪随机数生成器
export class SimRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // [0, 1)
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 整数 [min, max] 含端点
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  // [0, max) 浮点
  range(max: number): number {
    return this.next() * max;
  }

  // 从数组随机取一个
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // 加权随机挑选，weights 与 items 等长
  weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
