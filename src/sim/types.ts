// 核心类型（2026-08-21 从零重写·纯空白设计）
// 最小数据模型：实体 = 数字 id（连续递增），状态存并行 Map。
// 原则：能存 number 不存对象，能 O(1) 不扫表——但决不为性能牺牲可读性。

/** 实体 id（数字，连续） */
export type Eid = number;

/** 位置（世界格坐标） */
export interface Pos { x: number; y: number }

/** 需求值（0-100，越低越迫切） */
export interface Needs { food: number; rest: number; mood: number; san: number }

/** 健康（hp 归零 = 死亡） */
export interface Health { hp: number; maxHp: number }

/** 小人状态（挂在实体上的可变状态） */
export interface Pawn {
  eid: Eid;
  name: string;
  pos: Pos;
  needs: Needs;
  health: Health;
  job: string;            // 当前行为标签（显示用）
  path: Pos[];            // 移动路径（A* 结果）
  target?: Pos;           // 当前目标格
  trait?: string;         // 天赋（决定外观/行为倾向）：'strong'|'lazy'|'owl'...
}

/** 地图地形 */
export type TileId = 'grass' | 'tree' | 'ore' | 'water' | 'stone';

/** 建筑 */
export interface Building {
  id: string;             // 实例 id（位置 key）
  defId: string;
  x: number;
  y: number;
  hp: number;
}

/** 敌人 */
export interface Hostile {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dmg: number;
  speed: number;
  target?: Pos;           // 目标点（营地）
  attacking?: Eid;        // 正在攻击的实体
}

/** 事件（社交素材 / 历史日志） */
export interface GameEvent {
  type: string;
  text: string;
  time: number;
  eid?: Eid;
  x?: number;
  y?: number;
}