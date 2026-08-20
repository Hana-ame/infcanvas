// 工业革命玩法包（2026-08-20，用户「工业革命DLC」）：
// 蒸汽机/工厂/烟囱/炼钢厂/纺织厂/煤矿井 → 工业时代转型
// 核心机制：蒸汽机 = 大量产动力(tools)，工厂 = 高效产出加工品，
// 烟囱 = 副作用（污染 = 附近小人心情/san 下降），炼钢厂 = 矿石→钢锭，
// 纺织厂 = 木+食物→布匹，煤矿井 = passive 产煤（新资源）。
// 设计：工业建筑产出高但有污染代价（烟囱范围内 mood/san 衰减）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  steamEnginePowerPerSec: 2.0,    // 蒸汽机每秒产动力（tools）= 水车的 100 倍
  factoryCraftSpeed: 3,           // 工厂加工速度倍率
  smokestackRange: 8,             // 烟囱污染范围（格）
  smokestackMoodDrain: 0.3,       // 烟囱范围内每人每秒心情流失
  smokestackSanDrain: 0.1,        // 烟囱范围内每人每秒理智流失
  coalMineCoalPerSec: 0.5,        // 煤矿井每秒产煤
  steelworksOreCost: 2,           // 炼钢消耗矿石/次
  steelworksSteelYield: 1,        // 炼钢产出钢锭/次
  steelworksInterval: 5,          // 炼钢周期（秒）
  textileWoodCost: 3,             // 纺织厂消耗木材
  textileFoodCost: 2,             // 纺织厂消耗食物
  textileClothYield: 1,           // 纺织厂产出布匹
  textileInterval: 6,             // 纺织周期（秒）
};

export const INDUSTRIAL_CONFIG = CFG;

const K_POLLUTION = 'industrial-pollution'; // 标记建筑有污染

// 工业革命系统：蒸汽机产动力 + 煤矿井产煤 + 炼钢厂（矿→钢锭）+ 纺织厂（木+食→布匹）+ 烟囱污染
// 2026-08-20：节流 2s（产出是周期性检定，污染检查不需要每帧遍历全体小人）
class IndustrialSystem {
  id = 'industrial';
  private steelTimer = 0;
  private textileTimer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 2) return;
    this._throttle = 0;
    // 节流：工业系统（污染/炼钢/纺织/煤矿/蒸汽）2s 评估一次
    const doPollution = true;
    // 收集烟囱位置（用于污染计算）
    const smokestacks: { x: number; y: number }[] = [];
    let hasSteam = false, hasCoalMine = false;

for (const [k, b] of this.ctx.world.buildings) {
      if (b.def.id === 'smokestack') {
        smokestacks.push(World.keyToXY(k));
      }
      if (b.def.id === 'steam-engine') hasSteam = true;
      if (b.def.id === 'coal-mine') hasCoalMine = true;
    }

    // 污染：烟囱范围内的每人 mood/san 流失（2s 节流）
    if (doPollution && smokestacks.length > 0) {
      for (const eid of this.ctx.iterPawns) {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) continue;
        for (const s of smokestacks) {
          const d = Math.hypot(pos.x - s.x, pos.y - s.y);
          if (d <= CFG.smokestackRange) {
            this.ctx.adjustNeedField(eid, 'mood', -CFG.smokestackMoodDrain * dt);
            this.ctx.adjustNeedField(eid, 'san', -CFG.smokestackSanDrain * dt);
            break; // 一人只受一个烟囱影响
          }
        }
      }
    }

    // 炼钢厂：每 interval 秒消耗矿石 → 产钢锭
    this.steelTimer += dt;
    if (this.steelTimer >= CFG.steelworksInterval) {
      this.steelTimer = 0;
      let steelWorks = 0;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id === 'steelworks') steelWorks++;
      }
      if (steelWorks > 0 && (this.ctx.stockpile.ore ?? 0) >= CFG.steelworksOreCost * steelWorks) {
        this.ctx.stockpile.ore -= CFG.steelworksOreCost * steelWorks;
        this.ctx.stockpile['steel'] = (this.ctx.stockpile['steel'] ?? 0) + CFG.steelworksSteelYield * steelWorks;
        this.ctx.recordEarn(null, 'steel', CFG.steelworksSteelYield * steelWorks, 'steelworks');
        this.ctx.logEvent(`🔩 炼钢厂产出钢锭 +${CFG.steelworksSteelYield * steelWorks}`);
      }
    }

    // 纺织厂：每 interval 秒消耗木+食 → 产布匹
    this.textileTimer += dt;
    if (this.textileTimer >= CFG.textileInterval) {
      this.textileTimer = 0;
      let textileMills = 0;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id === 'textile-mill') textileMills++;
      }
      if (textileMills > 0
        && (this.ctx.stockpile.wood ?? 0) >= CFG.textileWoodCost * textileMills
        && (this.ctx.stockpile.food ?? 0) >= CFG.textileFoodCost * textileMills) {
        this.ctx.stockpile.wood -= CFG.textileWoodCost * textileMills;
        this.ctx.stockpile.food -= CFG.textileFoodCost * textileMills;
        this.ctx.stockpile['cloth'] = (this.ctx.stockpile['cloth'] ?? 0) + CFG.textileClothYield * textileMills;
        this.ctx.recordEarn(null, 'cloth', CFG.textileClothYield * textileMills, 'textile');
        this.ctx.logEvent(`🧵 纺织厂产出布匹 +${CFG.textileClothYield * textileMills}`);
      }
    }

    // 煤矿井：passive 产煤
    if (hasCoalMine) {
      let coalMines = 0;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id === 'coal-mine') coalMines++;
      }
      this.ctx.stockpile['coal'] = Math.min(500, (this.ctx.stockpile['coal'] ?? 0) + CFG.coalMineCoalPerSec * coalMines * dt);
    }

    // 蒸汽机：passive 产动力（tools）
    if (hasSteam) {
      let engines = 0;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id === 'steam-engine') engines++;
      }
      this.ctx.stockpile.tools = Math.min(500, (this.ctx.stockpile.tools ?? 0) + CFG.steamEnginePowerPerSec * engines * dt);
    }
  }
}

export const industrialPack: ModPack = {
  id: 'industrial',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 蒸汽机：大量产动力（tools）
    m.registerBuilding({
      id: 'steam-engine', name: '蒸汽机', size: { x: 2, y: 2 }, hp: 300, color: '#5a5a5a',
      emoji: '⚙', passable: false, buildTime: 10,
      tags: ['power', 'industrial'], meta: { power: CFG.steamEnginePowerPerSec },
      costWood: 30, costOre: 20,
    });

    // 工厂：高效加工（meta.craftSpeed = 倍率，craft 系统可读）
    m.registerBuilding({
      id: 'factory', name: '工厂', size: { x: 3, y: 2 }, hp: 250, color: '#6a6a5a',
      emoji: '🏭', passable: false, buildTime: 12,
      tags: ['industrial', 'craft'], meta: { craftSpeed: CFG.factoryCraftSpeed },
      costWood: 40, costOre: 15,
    });

    // 烟囱：污染源（范围内小人 mood/san 下降）
    m.registerBuilding({
      id: 'smokestack', name: '烟囱', size: { x: 1, y: 1 }, hp: 150, color: '#3a3a3a',
      emoji: '🏭', passable: false, buildTime: 4,
      tags: ['industrial', K_POLLUTION], meta: { pollutionRange: CFG.smokestackRange },
      costWood: 10,
    });

    // 炼钢厂：矿石 → 钢锭
    m.registerBuilding({
      id: 'steelworks', name: '炼钢厂', size: { x: 2, y: 2 }, hp: 280, color: '#7a6a5a',
      emoji: '🔩', passable: false, buildTime: 8,
      tags: ['industrial'], meta: {},
      costWood: 25, costOre: 10,
    });

    // 纺织厂：木+食 → 布匹
    m.registerBuilding({
      id: 'textile-mill', name: '纺织厂', size: { x: 2, y: 2 }, hp: 200, color: '#8a8a7a',
      emoji: '🧵', passable: false, buildTime: 6,
      tags: ['industrial', 'clothing'], meta: {},
      costWood: 20, costOre: 5,
    });

    // 煤矿井：passive 产煤（新资源）
    m.registerBuilding({
      id: 'coal-mine', name: '煤矿井', size: { x: 1, y: 1 }, hp: 180, color: '#2a2a2a',
      emoji: '⛏', passable: false, buildTime: 5,
      tags: ['industrial', 'mine'], meta: {},
      costWood: 15,
    });

    // 新物品
    m.registerItem({ id: 'steel', name: '钢锭' });
    m.registerItem({ id: 'cloth', name: '布匹' });
    m.registerItem({ id: 'coal', name: '煤炭' });

    m.registerSystemDef({
      id: 'industrial', label: '工业革命', category: 'production',
      ctor: (ctx) => new IndustrialSystem(ctx),
    });
  },
};

export { K_POLLUTION };