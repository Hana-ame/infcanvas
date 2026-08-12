// 意图/工作执行器表（逻辑组件层：行为执行分派数据驱动）
// 内置执行器清单集中声明（id/label/kind/handler），BehaviorSystem 从表装配；
// mod 可 registerIntent/registerWork 新增，也可覆盖内置（同 id 即替换）
// handler 指向 BehaviorSystem 类方法（执行器需要系统内部分派状态，如 walkAndWork 按 workType 查工作表）
export interface IntentDef {
  id: string;
  label: string;              // 中文名（调试/工具/UI）
  kind: 'instant' | 'ongoing'; // instant: 立即生效；ongoing: 需要走位/持续执行
  handler: string;            // BehaviorSystem 上的方法名
}

export interface WorkDef {
  type: string;   // workType（卡 decide 产出）
  label: string;  // 中文名
  handler: string; // BehaviorSystem 上的方法名
}

export const BUILTIN_INTENTS: IntentDef[] = [
  { id: 'walkAndWork', label: '走位工作', kind: 'ongoing', handler: 'execWalkAndWork' },
  { id: 'eat',         label: '进食',     kind: 'instant', handler: 'execEat' },
  { id: 'rest',        label: '休息',     kind: 'instant', handler: 'execRest' },
  { id: 'heal',        label: '疗伤',     kind: 'ongoing', handler: 'execHeal' },
  { id: 'pray',        label: '祈祷',     kind: 'ongoing', handler: 'execPray' },
  { id: 'idle',        label: '闲逛',     kind: 'instant', handler: 'execIdle' },
  { id: 'explore',     label: '探索',     kind: 'instant', handler: 'execExplore' },
];

export const BUILTIN_WORKS: WorkDef[] = [
  { type: 'chop',     label: '伐木', handler: 'workChop' },
  { type: 'mine',     label: '采矿', handler: 'workMine' },
  { type: 'caveMine', label: '矿洞采掘', handler: 'workCaveMine' },
  { type: 'fish',     label: '捕鱼', handler: 'workFish' },
  { type: 'build',    label: '建造', handler: 'workBuild' },
];
