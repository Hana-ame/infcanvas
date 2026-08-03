// Job 系统 —— 统一任务接口
// 行为卡产出 job，系统执行 job。mod 可注册新 job 类型。
import type { BehaviorCard } from '../ai/pawn';

// job 目标：一个坐标 + 半径（job 到达后开始工作）
export interface Job {
  type: 'chop' | 'mine' | 'build' | 'eat' | 'rest' | 'pray' | 'idle' | 'haul';
  x?: number;
  y?: number;
  defId?: string; // 建造用
  progress?: number;
  duration?: number; // 完成所需秒数
  card?: BehaviorCard; // 来源卡
  label: string;
}

// 系统执行 job 的进度状态（挂在 pawn 上）
export interface ActiveJob {
  job: Job;
  progress: number;
}
