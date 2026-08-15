// 温度玩法包（2026-08-14，插件化大系统实验：空间温度场）
// 背景：内核只有全局 env.temperature（昼夜波动单值），没有"篝火旁暖和、野外冻人"的空间感。
// 本包加空间温度层：
//   ① 热源 = 建筑 def.meta.heat { radius, power }：篝火（overrideDef 补 meta）与暖炉自有；
//      有效温度 = env.temperature + Σ 热源加热（距离衰减：power × (1 - d/radius)）
//   ② 影响（低频 2s 评估，节流防高频 setNeeds）：极端温差持续掉心情/理智——
//      低于 env.coldAt(0°C)/高于 env.hotAt(32°C) 时按温差线性惩罚，热源覆盖区内回温
//   ③ 新建筑 'heater' 暖炉：半径更大的热源（烧木供暖，每 10s 烧 1 木维持热度）
// 装配：before 'raid'（needs/san 之后结算，无冲突），默认挂载。
// ⚠️ 2026-08-14 review 修复：热源坐标此前用 `key % world.width` 解码（旧 key 公式），
// 新 key 编码为 x + y*2^31 后该公式完全错乱（实测 campfire(96,100) → y≈11 亿）→
// 全部热源定位到错误坐标，取暖机制整体失效且无测试暴露；改 World.keyToXY 解码。
import type { ModRegistry } from '../../sim/mods/registry';
import { K_WARMTH, K_WORN } from '../../sim/mods/contracts';
import type { SimContext } from '../../sim/systems/context';
import type { BuildingData } from '../../sim/core/world';
import { World } from '../../sim/core/world';
import type { ModPack } from '../pack';

// 本包数值（玩法包自治）
// 设计：惩罚是"极端天气才有"（舒适带 2~30°C，正常昼夜 8~28 不触发）；
// 正向加成常驻——热源覆盖区心情回暖（烤火舒服，社交暖源），这让温度包有存在感但不作恶
const CFG = {
  evalInterval: 2,    // 评估周期（秒）
  comfortLo: 2,       // 舒适带下限（低于此才冷）
  comfortHi: 30,      // 舒适带上限（高于此才热）
  moodPerDegree: 0.01, // 每偏离舒适带 1°C 每评估周期的心情流失（温差超带才累计）
  sanPerDegree: 0.005, // 每偏离 1°C 的理智流失（弱于心情）
  warmMoodPerEval: 0.05, // 热源覆盖区内每评估周期的心情加成（烤火舒服）
  nightWarmFloor: 15, // 夜晚热源覆盖区温度保持下限（2026-08-14 用户需求「夜晚温度保持」：
  // 火堆夜里不让温度掉下去——夜里环境降到 4~8°C（雨天夜更低）时火旁仍维持 15°C 舒适；
  // 白天不干涉（那时 boost 正常叠加，floor 不动正常昼夜）
};

// meta.heat 语义：radius=加热半径；power=单位半径上的加热强度（有效温度 = power×(1-d/r)）
interface HeatMeta { radius: number; power: number }

const heatOf = (b: BuildingData): HeatMeta | undefined => b.def.meta?.heat as HeatMeta | undefined;

export const thermoPack: ModPack = {
  id: 'thermo',
// 依赖（2026-08-15 显式化）：无硬前置——热源补 meta.heat 深合并共存；clothing 的 meta.warmth 为可选联动（不挂则无穿着加成）
  requires: [],
  apply(m: ModRegistry): void {
  // 篝火补热源（overrideDef 部分合并不改其它字段）：火旁取暖是世界观的一部分
  m.overrideDef('building', 'campfire', { meta: { heat: { radius: 4, power: 6 } } });
  m.overrideDef('building', 'church', { meta: { heat: { radius: 5, power: 4 } } });
  // 新建筑：暖炉（烧木供暖，半径更大）
  m.registerBuilding({
    id: 'heater', name: '暖炉', size: { x: 1, y: 1 }, hp: 150, color: '#8a3a2a',
    emoji: '🔥', passable: false, buildTime: 4,
    tags: ['heat', 'warmth'], meta: { heat: { radius: 6, power: 8 } },
    costWood: 15,
  });
  m.registerSystemDef({
    id: 'thermo', label: '温度场', category: 'production',
    ctor: (sim) => new ThermoSystem(sim),
    before: 'raid',
  });
  },
};

// 空间温度场：热源衰减加热 → 有效温度 → 极端损伤（心情/理智）
// 低频评估（2s 一拍）——温度是慢变量，逐帧 setNeeds 浪费且会污染需求节奏
export class ThermoSystem {
  id = 'thermo';
  private timer = 0;
  private heaters = new Map<number, BuildingData>(); // 热源缓存（建筑变化时刷新）

  constructor(private ctx: SimContext) {}

  init(): void {}

  private refreshHeaters(): void {
    this.heaters.clear();
    for (const [key, b] of this.ctx.world.buildings) {
      if (heatOf(b)) this.heaters.set(key, b);
    }
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = CFG.evalInterval;
    this.refreshHeaters();
    if (this.heaters.size === 0) return;

    const envT = this.ctx.env.temperature;
    for (const eid of this.ctx.pawnList) {
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      // 热源叠加（距离衰减）
      let boost = 0;
      for (const [key, b] of this.heaters) {
        const h = heatOf(b)!;
        // 新 key 编码（2026-08-14 无限地图）：必须 World.keyToXY 解码——
        // 旧 `key % w` 公式解码 y 坐标乱到上亿，热源全部定位错误（review 暴露）
        const { x: hx, y: hy } = World.keyToXY(key);
        // 方形热场近似（曼哈顿距离衰减）：半径内线性
        const d = Math.abs(hx - pos.x) + Math.abs(hy - pos.y);
        if (d <= h.radius) boost += h.power * (1 - d / h.radius);
      }
      let eff = envT + boost;
      // 服装保暖（2026-08-15 clothing 玩法包跨包契约）：穿着的衣物物品 meta.warmth
      // 直接调有效温度——正 = 御寒（皮衣/皮大衣），负 = 散热（亚麻衫夏天穿凉爽）。
      // 契约：PawnState.extra.worn.body = 衣物物品 id（clothing 包写入，存档扩展点自动随档）；
      // 未挂 clothing 包时 worn 恒无 → 本行零效果，不破坏核心
      const wornId = (this.ctx.pawnStates.get(eid)?.extra?.[K_WORN] as { body?: string } | undefined)?.body;
      if (wornId) {
        const w = this.ctx.mods.items[wornId]?.meta?.[K_WARMTH];
        if (typeof w === 'number') eff += w;
      }
      // 夜晚温度保持（2026-08-14 用户需求）：热源覆盖区内夜里有效温度不低于
      // nightWarmFloor——"火堆夜里保温"（环境夜里降、火旁不降）；野外无火照常冷
      if (this.ctx.isNight() && boost > 0 && eff < CFG.nightWarmFloor) eff = CFG.nightWarmFloor;
      // 热源覆盖区心情加分（烤火舒服——篝火暖源的社会价值）；极端温差惩罚：
      // 热源覆盖区内回温后自然缓解（冷胜过热惩罚，负温差窗口内惩罚更早归零）
      let mood = 0, san = 0;
      if (boost > 0) mood += CFG.warmMoodPerEval;
      const cold = CFG.comfortLo - eff;
      const hot = eff - CFG.comfortHi;
      if (cold > 0) { mood -= cold * CFG.moodPerDegree * CFG.evalInterval; san -= cold * CFG.sanPerDegree * CFG.evalInterval; }
      if (hot > 0) { mood -= hot * CFG.moodPerDegree * CFG.evalInterval; san -= hot * CFG.sanPerDegree * CFG.evalInterval; }
      if (mood < 0) this.ctx.adjustMood(eid, mood);
      if (san < 0) {
        const n = this.ctx.readNeeds(eid);
        if (n) { n.san = Math.max(0, n.san + san); this.ctx.setNeeds(eid, n); }
      }
    }
  }
}
