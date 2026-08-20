// 电力玩法包（2026-08-14，插件化大系统实验：电网）
// 背景：生产只有手作（workbench 吃木头），本包提供"风电 → 电池蓄电 → 电锻炉产工具"的
// 独立生产链：风车产电存进电池，forge 有序耗电产工具（比 workbench 快且省木，但依赖电网）。
// 机制（刻意自闭环，不碰 craftSystem/workbench）：
//   ① 建筑 def.meta.power 携带电器语义（meta = 玩法包自定义字段通道，BuildingDef 开放）：
//      windmill{gen} / battery{storage} / forge{use}
//   ② 电网 = 4 连通 BFS 分组（并查集）：同组的风车/电池/电炉共享电荷，多组互不相通
//   ③ 电荷只存 battery.extra.charge（依赖内核存档扩展点 extra 随档持久；JSON-safe 数值）：
//      风车产电按电池剩余容量比例充入（上限 = 组内总容量）；无电池组不蓄电（即产即弃）
//   ④ forge 按 interval 节奏抽电生产：电荷不足 → 停产等电（不扣资源）；夜间风电衰减
// 装配：before 'raid'（与 craft 同锚点，注册序在其后 = 结算在后），默认挂载。
// 注：forge 不挂 'craft' tag → craftSystem 不碰电锻炉，电动生产链完全由本系统驱动。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { BuildingData } from '../../sim/core/world';
import { World } from '../../sim/core/world';
import type { ModPack } from '../pack';

// 本包数值（玩法包自治，不往内核 tuning 塞电参）
const CFG = {
  nightGenMul: 0.3,   // 夜间发电倍率（风小）
  interval: 4,        // forge 生产节奏（秒）——与配方同步
  forgeCharge: 6,     // forge 每次生产抽电量（= use × interval = 1.5 × 4）
  woodPerTool: 3,     // 每次生产耗木（与 forge 配方 input 同步）
  wireRange: 1,       // 4 连通判距（曼哈顿距离 ≤ 此值视为同网）
};

// meta.power 语义：gen=发电量/s；storage=蓄电容量；use=耗电量/s（def 自由字段，无 schema 校验）
interface PowerMeta { gen?: number; storage?: number; use?: number }

// 读取建筑动力配置（meta.power = 每秒产动力量；蒸汽机/水车用）
const powerOf = (b: BuildingData): PowerMeta | undefined => b.def.meta?.power as PowerMeta | undefined;

export const powerPack: ModPack = {
  id: 'power',
// 依赖（2026-08-15 显式化）：无硬前置——发电机建筑自注册
  requires: [],
  apply(m: ModRegistry): void {
  m.registerBuilding({
    id: 'windmill', name: '风车', size: { x: 2, y: 2 }, hp: 200, color: '#8a7a5a',
    emoji: '🎐', passable: false, buildTime: 8,
    tags: ['power'], meta: { power: { gen: 3 } },
    costWood: 60, costOre: 10,
  });
  m.registerBuilding({
    id: 'battery', name: '电池', size: { x: 1, y: 1 }, hp: 120, color: '#3a5a3a',
    emoji: '🔋', passable: false, buildTime: 4,
    tags: ['power'], meta: { power: { storage: 30 } },
    costWood: 20,
  });
  m.registerBuilding({
    id: 'forge', name: '电锻炉', size: { x: 1, y: 1 }, hp: 250, color: '#5a3a5a',
    emoji: '⚒️', passable: false, buildTime: 6,
    tags: ['power'], meta: { power: { use: CFG.forgeCharge / CFG.interval } },
    costWood: 25, costOre: 10,
  });
  // 配方（走 registerRecipe 数据通道：数据在表、生产在电网系统——样式与内核 recipe 一致）
  // id 'forge_tools' 而非 'forge'（审计 2026-08-15：与建筑 id 'forge' 跨命名空间重名，
  // 日志/科技/调试易指错；配方 id 不进存档，改名零迁移）
  m.registerRecipe({
    id: 'forge_tools', name: '电锻工具', kind: 'batch',
    input: [{ item: 'wood', amount: CFG.woodPerTool }],
    output: { item: 'tools', amount: 1 },
    interval: CFG.interval,
  });

  m.registerSystemDef({
    id: 'power', label: '电力', category: 'production',
    ctor: (sim) => new PowerSystem(sim),
    // 表内系统不设 before：执行序 = 类别序 × 组内注册序推导（SYSTEM_DEFS 表位置定序；
    // before 锚点仅第三方表外系统专用——2026-08-20 审计 L7 清理死锚点）
  });
  },
};

// 电网：分组 → 产电（风电充电池）→ 耗电（forge 抽电生产）
// 电荷持久在 battery.extra.charge（随存档），电网组是运行时概念（每帧从建筑布局重建）
export class PowerSystem {
  id = 'power';
  // forge 生产冷却表（2026-08-20 审查修复）：forge 建筑 key → 剩余冷却秒。
  // 此前 CFG.interval 是死参数（每帧量产）；冷却跨帧持久，每台 forge 独立节奏
  private forgeCooldowns = new Map<number, number>();
  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    const powerBuildings = new Map<number, BuildingData>();
    for (const [key, b] of this.ctx.world.buildings) {
      if (b.def.tags?.includes('power')) powerBuildings.set(key, b);
    }
    if (powerBuildings.size === 0) return;

    // ① 分组：并查集按 wireRange 连通（曼哈顿距离判邻）
    const parent = new Map<number, number>();
    const keys = [...powerBuildings.keys()];
    const find = (k: number): number => {
      let r = parent.get(k) ?? k;
      if (r !== k) { r = find(r); parent.set(k, r); }
      return r;
    };
    for (const k of keys) parent.set(k, k);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const ax = World.keyToXY(a).x, ay = World.keyToXY(a).y;
        const bx = World.keyToXY(b).x, by = World.keyToXY(b).y;
        if (Math.abs(ax - bx) + Math.abs(ay - by) <= CFG.wireRange) {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent.set(ra, rb);
        }
      }
    }

    // 组聚合：gen / storage / batteryKeys / forgeKeys（电荷实时从电池 extra 读）
    const groups = new Map<number, { gen: number; storage: number; batteryKeys: number[]; forgeKeys: number[] }>();
    for (const k of keys) {
      const b = powerBuildings.get(k)!;
      const p = powerOf(b) ?? {};
      const root = find(k);
      let g = groups.get(root);
      if (!g) { g = { gen: 0, storage: 0, batteryKeys: [], forgeKeys: [] }; groups.set(root, g); }
      if (p.gen) g.gen += p.gen;
      if (p.storage) { g.storage += p.storage; g.batteryKeys.push(k); }
      if (p.use) g.forgeKeys.push(k);
    }

    // ② 发电：风电注入组内电池（按各电池剩余容量比例分配——不挑食、不浪费）
    for (const g of groups.values()) {
      if (g.gen <= 0 || g.batteryKeys.length === 0) continue;
      let add = g.gen * dt * (this.ctx.isNight() ? CFG.nightGenMul : 1);
      const remain = new Map<number, number>();
      let totalRemain = 0;
      for (const bk of g.batteryKeys) {
        const b = powerBuildings.get(bk)!;
        const r = Math.max(0, (powerOf(b)!.storage ?? 0) - ((b.extra?.charge as number | undefined) ?? 0));
        remain.set(bk, r);
        totalRemain += r;
      }
      if (totalRemain <= 0) continue;
      add = Math.min(add, totalRemain);
      for (const bk of g.batteryKeys) {
        const r = remain.get(bk) ?? 0;
        if (r <= 0) continue;
        const b = powerBuildings.get(bk)!;
        b.extra = b.extra ?? {};
        b.extra.charge = ((b.extra.charge as number | undefined) ?? 0) + (r / totalRemain) * add;
      }
    }

    // ③ 耗电生产：forge 按 interval 节奏抽电（电荷不足 → 停产不扣料）
    // 2026-08-20 审查修复：此前 CFG.interval 是死参数——电荷够就每帧量产；且组内多 forge
    // 每帧只产一次（第二台 forge 同组永无产出）。修复：①每台 forge 独立冷却节奏（forgeCooldowns）；
    // ②组电荷记账递减——多 forge 本帧并行生产时，靠帧首快照判断会"超抽电/重复扣木"
    //（第二台 forge 看到的 charge 还是第一台抽走前的旧值），必须逐台扣减记账
    for (const g of groups.values()) {
      if (g.forgeKeys.length === 0) continue;
      // 冷却统一走（与电荷无关；到期清除条目，Map 不膨胀）
      for (const fk of g.forgeKeys) {
        const cd = (this.forgeCooldowns.get(fk) ?? 0) - dt;
        if (cd <= 0) this.forgeCooldowns.delete(fk);
        else this.forgeCooldowns.set(fk, cd);
      }
      // 组电荷 = Σ 电池 charge（无电池组 = 0 → forge 一直停产，提示玩家造电池）
      let charge = 0;
      for (const bk of g.batteryKeys) charge += (powerBuildings.get(bk)!.extra?.charge as number | undefined) ?? 0;
      if (charge < CFG.forgeCharge) continue;
      let producedCount = 0;
      for (const fk of g.forgeKeys) {
        if (this.forgeCooldowns.has(fk)) continue; // 冷却中：轮到本台但未就绪
        // 电/木任一不足 → 停（先查后抽，不出现"电抽了料扣了却没产出"）
        if (charge < CFG.forgeCharge || (this.ctx.stockpile.wood ?? 0) < CFG.woodPerTool) break;
        this.powerForge(fk, g, powerBuildings);
        charge -= CFG.forgeCharge; // 记账：下一台 forge 的可用电量（防超抽）
        this.forgeCooldowns.set(fk, CFG.interval);
        producedCount++;
      }
      if (producedCount > 0) {
        this.ctx.logEvent(producedCount === 1 ? '⚒️ 电锻炉产出了工具' : `⚒️ 电锻炉产出了 ${producedCount} 件工具`);
      }
    }
  }

  // 单台 forge 生产：抽电（按电池电荷比例扣减）+ 扣木产工具。
  // 电量可用性由调用方记账保证（③ 的 charge 递减）——本方法只负责实际扣减
  private powerForge(
    _fk: number,
    g: { batteryKeys: number[] },
    powerBuildings: Map<number, BuildingData>,
  ): void {
    let taken = 0;
    for (const bk of g.batteryKeys) {
      const b = powerBuildings.get(bk)!;
      const c = (b.extra?.charge as number | undefined) ?? 0;
      if (c <= 0) continue;
      // 剩余所需电量中本电池承担比例：c/Σ 剩余电荷
      const rest = CFG.forgeCharge - taken;
      const share = Math.min(c, rest);
      b.extra!.charge = c - share;
      taken += share;
      if (taken >= CFG.forgeCharge) break;
    }
    this.ctx.stockpile.wood -= CFG.woodPerTool;
    this.ctx.stockpile.tools = (this.ctx.stockpile.tools ?? 0) + 1;
    this.ctx.recordSpend(null, 'wood', CFG.woodPerTool);
  }
}