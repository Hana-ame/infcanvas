// 环境状态（DESIGN §6 卡相互作用：环境调制）
// 气温：随时间波动（热/温和/冷）；天气：晴/雨（确定性，种子 RNG）
// 影响：下雨 → 户外工作权重低、室内/娱乐权重高；酷暑/严寒 → 户外工作低
// 数值参数来自 tuning（docs/DATA_DRIVEN.md §3.4）
import type { EnvTuning } from '../defs/tuning';

export interface EnvState {
  raining: boolean;
  rainLeft: number;       // 剩余降雨秒数
  temperature: number;    // 摄氏度
}

// 初始化环境状态（温度/降雨/光照；baseTemp 读 tuning）
export function initEnv(t: { baseTemp: number }): EnvState {
  return { raining: false, rainLeft: 0, temperature: t.baseTemp };
}

// 环境 tick：气温随昼夜（白天热、夜晚凉）波动；降雨周期性
export function tickEnv(env: EnvState, dt: number, dayTime: number, rng: { next(): number }, t: EnvTuning): void {
  // 气温：基础 + 昼夜波动 + 随机天气偏移
  const dayFactor = Math.sin((dayTime - 0.25) * Math.PI * 2); // 正午峰值
  env.temperature = t.baseTemp + dayFactor * t.dayAmplitude + (env.raining ? t.rainCool : 0);

  // 降雨：随机的雨-晴循环
  if (env.rainLeft > 0) {
    env.rainLeft -= dt;
    if (env.rainLeft <= 0) env.raining = false;
  } else if (!env.raining && rng.next() < t.rainChancePerSec * dt) {
    // 开始下雨，持续 rainMin-rainMax 秒
    env.raining = true;
    env.rainLeft = t.rainMin + rng.next() * (t.rainMax - t.rainMin);
  }
}

// 天气标签（晴/雨/热/冷 → UI 显示用）
export const weatherLabel = (env: EnvState, t?: EnvTuning): string => {
  const temp = Math.round(env.temperature);
  // 兜底阈值 32/0°C 与 tuning.env 默认一致（显示用；调用方通常传 tuning 快照，未传时用默认）
  const hotAt = t?.hotAt ?? 32;
  const coldAt = t?.coldAt ?? 0;
  if (env.raining) return `🌧 雨 ${temp}°C`;
  if (temp > hotAt) return `☀️ 酷暑 ${temp}°C`;
  if (temp < coldAt) return `❄️ 严寒 ${temp}°C`;
  return `☁️ ${temp}°C`;
};
