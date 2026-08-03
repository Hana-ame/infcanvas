// 环境状态（DESIGN §6 卡相互作用：环境调制）
// 气温：随时间波动（热/温和/冷）；天气：晴/雨（确定性，种子 RNG）
// 影响：下雨 → 户外工作权重低、室内/娱乐权重高；酷暑/严寒 → 户外工作低

export interface EnvState {
  raining: boolean;
  rainLeft: number;       // 剩余降雨秒数
  temperature: number;    // 摄氏度
}

export function initEnv(): EnvState {
  return { raining: false, rainLeft: 0, temperature: 18 };
}

// 环境 tick：气温随昼夜（白天热、夜晚凉）波动；降雨周期性
export function tickEnv(env: EnvState, dt: number, dayTime: number, rng: { next(): number }): void {
  // 气温：基础 18°C + 昼夜波动（正午 ~28°，深夜 ~8°）+ 随机天气偏移
  const dayFactor = Math.sin((dayTime - 0.25) * Math.PI * 2); // 正午峰值
  env.temperature = 18 + dayFactor * 10 + (env.raining ? -4 : 0);

  // 降雨：随机的雨-晴循环（平均每 45 秒有 20% 概率开始下雨）
  if (env.rainLeft > 0) {
    env.rainLeft -= dt;
    if (env.rainLeft <= 0) env.raining = false;
  } else if (!env.raining && rng.next() < 0.003 * dt) {
    // 开始下雨，持续 15-35 秒
    env.raining = true;
    env.rainLeft = 15 + rng.next() * 20;
  }
}

export const weatherLabel = (env: EnvState): string => {
  const t = Math.round(env.temperature);
  if (env.raining) return `🌧 雨 ${t}°C`;
  if (t > 32) return `☀️ 酷暑 ${t}°C`;
  if (t < 0) return `❄️ 严寒 ${t}°C`;
  return `☁️ ${t}°C`;
};
