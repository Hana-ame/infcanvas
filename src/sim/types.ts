/**
 * types.ts —— 内核共享数据类型（零依赖，可被 sim/mods/客户端/服务端共同 import）。
 *
 * 设计取舍：
 *  - PawnState 用普通对象字段（非 ECS 并行数组）：本阶段规模（几十只鼠）下可读性与
 *    存档友好优先；性能回归时再迁并行数组，接口不变。
 *  - 所有字段都是纯数据（JSON 可序列化）——存档即 JSON 是技术规格承诺。
 */

export type Eid = number;

export interface Pos {
  x: number;
  y: number;
}

/** 需求四维：0..100，100 = 完全满足。衰减速率见 tuning.needs */
export interface Needs {
  food: number;
  rest: number;
  mood: number;
  san: number;
}

/** 熟练度条目：v = 0..100，t = 最后触碰时刻（惰性衰减用，读时先按流逝时间扣） */
export interface MasteryEntry {
  v: number;
  t: number;
}

export interface PawnState {
  eid: Eid;
  name: string;
  pos: Pos;
  needs: Needs;
  hp: number;
  maxHp: number;
  /** 攀爬能力：可跨越的地形高差（tuning.pawn.climb 缺省，未来特质/mod 可改） */
  climb: number;
  trait: string; // tuning.traits 表键
  // ---- 抽卡决策引擎状态（内核所有，玩法包只读/经 ctx 操作）----
  cardId: string | null; // 当前执行卡
  busyUntil: number; // 到期后重新抽卡
  holdUntil: number; // 玩家命令优先窗口：期内不自主抽卡（命令层语义，非玩法 AI）
  atkCd: number; // 近战攻击冷却
  path: Pos[]; // 待走的路径（内核 moveStep 消费）
  mastery: Record<string, MasteryEntry>;
  uses: Record<string, number>; // 卡触发计数（验证抽卡驱动 / 统计用）
  /** 单槽避让：寻路失败的目标格在 until 前不再尝试（防"看得见够不着"的抽卡死循环）。
   *  可选字段=旧档兼容；只由 gathering 等工作卡写读（跨包词汇暂无第二使用者）。 */
  avoidFeat?: { x: number; y: number; until: number };
}

export interface Hostile {
  id: number;
  kind: string; // tuning.enemies 表键
  pos: Pos;
  hp: number;
  maxHp: number;
  atkCd: number;
}

export interface BuildingState {
  id: string;
  defId: string; // tuning.buildings 表键
  pos: Pos;
  hp: number;
}

/** 世界特征（树/浆果丛）：无限地图上由哈希推导，本身不实例化存储；
 *  FeatureHit 是查询时的瞬时快照。 */
export interface FeatureHit {
  x: number;
  y: number;
  kind: 'tree' | 'berry';
  amount: number; // 浆果剩余份数 / 树可出木材份数
}

export interface LogEvent {
  time: number;
  text: string;
}
