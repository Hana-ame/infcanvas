/**
 * types.ts —— 内核共享数据类型（零依赖，可被 sim/mods/客户端/服务端共同 import）。
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

/** Pawn 技能槽（验收硬约束：每个 Pawn 最多 3 个技能，skills.length <= 3） */
export interface PawnSkillSlot {
  id: string;
  name: string;
  level: number; // 0..20 (RimWorld 标准 0-20 级)
  passion: 0 | 1 | 2; // 0=无火, 1=小火🔥, 2=双火🔥🔥
  cooldown: number; // 主动技能剩余冷却秒数
}

/**
 * 技能/特质/熟练度 三者一对一绑定槽（每个人最多 3 个特质/技能/熟练度绑定，不属于这三者的操作一律效率*50%且无法学习）
 */
export interface BoundTriadSlot {
  index: 0 | 1 | 2;
  traitId: string;
  traitName: string;
  skillId: string;
  skillName: string;
  masteryId: string;
  masteryLabel: string;
  boundWorkIds: string[];
  boundCardSeries: string[];
  level: number; // 0..20
  xp: number;
  masteryValue: number; // 0..100
  passion: 0 | 1 | 2;
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
  /** 每个人最多 3 个绑定的【特质】列表（与 skills、mastery 一一对应绑定） */
  boundTraits?: string[];
  /** 每个人最多 3 个【技能/特质/熟练度】三绑定槽 */
  triads?: BoundTriadSlot[];
  /** 所属殖民者分组 ID（用于分组财产分配与 price=0 交易面板） */
  groupId?: string;
  /** 归属玩家 id（用于多玩家各自独立的战争迷雾与陌生人面板隐藏判定） */
  controlledBy?: string;
  /** 是否为陌生人/外部访客（看不到陌生人的详细面板，只有特质 trait 能看） */
  isStranger?: boolean;
  /** 是否因精神崩溃放弃并离开殖民地派系（在地图周围由 AI 自主管理生存，可被重新招募） */
  formerColonist?: boolean;
  /** 精神崩溃状态标记（如 'wild_man' 回归荒野 / 'give_up_leave' 放弃并离开派系） */
  mentalBreakState?: 'wild_man' | 'give_up_leave';
  /** NPC 标记（P2 2026-10-13）：带 dialogueId 的鼠可被玩家对话（E 键） */
  npc?: { dialogueId?: string };
  /** 交互冷却（P2） */
  interactCd?: number;
  // ---- 抽卡决策引擎状态（内核所有，玩法包只读/经 ctx 操作）----
  cardId: string | null;
  busyUntil: number;
  holdUntil: number;
  atkCd: number;
  path: Pos[];
  mastery: Record<string, MasteryEntry>;
  uses: Record<string, number>;
  avoidFeat?: { x: number; y: number; until: number };
  // ---- RimWorld 扩展档案（鼠鼠种族 / 生物基因 / 最多3个技能 / 征召 / 工作优先级 / 解剖部位 / 随身背包）----
  xenotype?: string;
  genes?: string[];
  skills?: PawnSkillSlot[];
  drafted?: boolean;
  workPriorities?: Record<string, 0 | 1 | 2 | 3 | 4>;
  equipWeapon?: string;
  equipApparel?: string;
  /** 逐根手指/内脏/四肢/头部/生殖系统独立建模 */
  anatomy?: Record<string, import('./anatomy-health').BodyPartState>;
  /** 小人随身携带物品（可参与小人点对点交易，且死亡时绑定在身上不掉落） */
  inventory?: Record<string, number>;
  /** 死亡时武器与随身物品保留在尸体上不掉落地面防卡顿 */
  retainedOnCorpse?: boolean;
  /** 遗体是否已被完全搜刮（死亡不掉落后可通过打开遗体窗口选择带出武器、护甲与随身物品） */
  corpseLooted?: boolean;
  /** 遗体是否已进行过战地尸检/器官义体摘除 */
  corpseOrgansHarvested?: boolean;
  /** 是否为野生动物/生物尸体（死亡后需拖回屠宰台屠宰分解产出肉与毛皮） */
  isAnimalCorpse?: boolean;
  /** 生物尸体原始物种 ID（如 rabbit / deer / cat） */
  animalKind?: string;
  /** 尸体是否已被屠宰分解完毕 */
  corpseButchered?: boolean;
  /** 屠宰该尸体可产出的资源（如 { meat: 2, leather: 1 }） */
  butcherYield?: Record<string, number>;
  /** 当前正在拖运该尸体的小人 EID */
  hauledByEid?: Eid;
  /** 当前小人正在拖运的目标尸体 EID */
  haulingCorpseEid?: Eid;
  /** 死亡原因描述 */
  causeOfDeath?: string;
  /** 死亡时刻 (秒) */
  deathTime?: number;
  /** 是否为敌袭者/机械族残骸遗体 */
  isRaiderCorpse?: boolean;
  /** 当前正在执行的工作/劳作任务（用于头上工作进度条显示） */
  activeWork?: {
    kind:
      | 'construct'
      | 'haul_blueprint'
      | 'chop'
      | 'mine'
      | 'bury'
      | 'rob_grave'
      | 'farm'
      | 'haul_corpse'
      | 'butcher'
      | 'scavenge'
      | 'cook';
    label: string;
    targetPos: Pos;
    targetId?: string | number;
    workTotal: number;
    workProgress: number;
    workContinuousSec: number;
  };
  /** 战斗读条出招 (Attack Windup) */
  attackWindup?: number;
  attackWindupTotal?: number;
  attackTargetId?: number;
  /** 近战缠斗/拖住 (Melee Grapple) */
  inMeleeGrapple?: boolean;
  /** 当前正在前往执行非隔空贴身搜刮的目标（遗迹建筑或遗体） */
  scavengeOrder?: {
    targetKind: 'ruin_building' | 'corpse' | 'ruin_site';
    targetId: string | number;
    targetPos: Pos;
    preferredGroupId?: string;
    selectedQuantities?: Record<string, number> | Array<{ key: string; qty: number }>;
  };
  /** 食用特色料理后获得的持续风味增益 (Culinary Buff) */
  culinaryBuff?: {
    dishId: string;
    dishName: string;
    dishIcon: string;
    buffName: string;
    expiresAt: number;
    moodBonus: number;
    moveSpeedPct: number;
    workSpeedPct: number;
    combatDmgPct: number;
    regenHpPerMin: number;
    coldHeatResistC: number;
    summary: string;
  };
  /** 最近品尝过的特色料理名称 */
  lastEatenDish?: string;
}

export interface Hostile {
  id: number;
  kind: string; // tuning.enemies 表键
  pos: Pos;
  hp: number;
  maxHp: number;
  atkCd: number;
  attackWindup?: number;
  attackWindupTotal?: number;
  inMeleeGrapple?: boolean;
}

export interface BuildingState {
  id: string;
  defId: string; // tuning.buildings 表键
  pos: Pos;
  hp: number;
  /** 可选：多格建筑朝向（0=默认北, 1=东 90°, 2=南 180°, 3=西 270°；rot 奇数时占地 w 与 h 互换） */
  rot?: 0 | 1 | 2 | 3;
  w?: number;
  h?: number;
  /** 创建该建筑的玩家 ID（用于电灯塔/大篝火按玩家独立驱散战争迷雾，不同玩家不共享） */
  ownerPlayerId?: string;
  /** 蓝图标志与施工进度 */
  isBlueprint?: boolean;
  targetDefId?: string;
  materialsNeeded?: Record<string, number>;
  materialsDelivered?: Record<string, number>;
  workTotal?: number;
  workProgress?: number;
  /** 坟墓附加数据 */
  buriedPawnName?: string;
  buriedItems?: Record<string, number>;
  buriedWeapon?: string;
  buriedApparel?: string;
  isRobbed?: boolean;
  /** 遗迹内部可搜刮建筑附加数据（搜刮目标是遗迹里的建筑，而不是遗迹区域本身） */
  isRuinBuilding?: boolean;
  ruinSiteId?: string;
  scavengeLoot?: Record<string, number>;
  scavenged?: boolean;
  relicGear?: string[];
  customName?: string;
}

export interface FeatureHit {
  x: number;
  y: number;
  kind: 'tree' | 'berry';
  amount: number;
}

export interface LogEvent {
  time: number;
  text: string;
}

export type InteractOutcome =
  | { kind: 'npc'; npcEid: Eid }
  | { kind: 'loot_corpse'; corpseEid: Eid }
  | { kind: 'scavenge_ruin'; siteId: string }
  | { kind: 'pickup'; item: string; gained: number }
  | { kind: 'pickup-fail' }
  | { kind: 'use'; tag: string }
  | { kind: 'teleport'; from: Pos; to: Pos }
  | { kind: 'none' };

export interface DialogueState {
  npcEid: Eid;
  dialogueId: string;
}
