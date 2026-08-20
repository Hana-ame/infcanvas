// 武器装备与兵种 DLC（2026-08-20）：燧发枪→步枪→机枪→冲锋枪 + 大炮 + 骑兵 + 装甲车
// 种子原则：
// 1. 武器 = 物品（meta.weapon = { dmg, range, cd, type }）→ wear 命令装备 → 战斗系统读 meta
// 2. 兵种 = 敌人 def（speed/hp/dmg/dash 组合 → 骑兵快/装甲车厚/炮兵远程）
// 3. 科技解锁（tech tree：火药→燧发枪→步枪→机枪→冲锋枪→大炮→装甲车）
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { K_WEARABLE, K_WARMTH } from '../../sim/mods/contracts';

const CFG = {
  // 武器数值
  musketDmg: 15, musketRange: 12, musketCd: 3,      // 燧发枪：中等伤害 + 中距离 + 慢射速
  rifleDmg: 20, rifleRange: 20, rifleCd: 2,          // 步枪：高伤害 + 远距离 + 中射速
  lmgDmg: 8, lmgRange: 15, lmgCd: 0.5,              // 机枪：低单发 + 中距离 + 极快射速
  smgDmg: 5, smgRange: 8, smgCd: 0.2,              // 冲锋枪：极低单发 + 近距离 + 极快
  cannonDmg: 50, cannonRange: 25, cannonCd: 8,      // 大炮：极高伤害 + 极远距离 + 极慢
  // 兵种
  cavalryHp: 120, cavalrySpeed: 12, cavalryDmg: 10,  // 骑兵：快 + 中 HP + 冲锋
  tankHp: 500, tankSpeed: 4, tankDmg: 30,            // 装甲车：极厚 + 慢 + 重火力
  artilleryHp: 80, artillerySpeed: 2, artilleryDmg: 50, // 炮兵：脆 + 极慢 + 远程重击
  // 武器装备加成
  weaponMoodBonus: 2,  // 装备武器心情 +2
};

export const weaponsPack: ModPack = {
  id: 'weapons',
  requires: ['clothing'],
  apply(m: ModRegistry): void {
    // ---- 武器物品（meta.weapon = 战斗系统读此字段加成伤害/射程） ----
    // 燧发枪（初期火器）
    m.registerItem({ id: 'musket', name: '燧发枪', meta: { [K_WEARABLE]: true, [K_WARMTH]: 0, slot: 'hands', weapon: { dmg: CFG.musketDmg, range: CFG.musketRange, cd: CFG.musketCd, type: 'firearm' } } });
    // 步枪（进阶火器）
    m.registerItem({ id: 'rifle', name: '步枪', meta: { [K_WEARABLE]: true, [K_WARMTH]: 0, slot: 'hands', weapon: { dmg: CFG.rifleDmg, range: CFG.rifleRange, cd: CFG.rifleCd, type: 'firearm' } } });
    // 机枪（高射速压制）
    m.registerItem({ id: 'lmg', name: '机枪', meta: { [K_WEARABLE]: true, [K_WARMTH]: 0, slot: 'hands', weapon: { dmg: CFG.lmgDmg, range: CFG.lmgRange, cd: CFG.lmgCd, type: 'automatic' } } });
    // 冲锋枪（近战高射速）
    m.registerItem({ id: 'smg', name: '冲锋枪', meta: { [K_WEARABLE]: true, [K_WARMTH]: 0, slot: 'hands', weapon: { dmg: CFG.smgDmg, range: CFG.smgRange, cd: CFG.smgCd, type: 'automatic' } } });
    // 大炮（建筑级武器——放在炮台基座上）
    m.registerItem({ id: 'cannon', name: '大炮', meta: { weapon: { dmg: CFG.cannonDmg, range: CFG.cannonRange, cd: CFG.cannonCd, type: 'artillery' } } });
    // 弹药（消耗品——武器射击消耗）
    m.registerItem({ id: 'gunpowder', name: '火药' });
    m.registerItem({ id: 'bullets', name: '子弹' });
    m.registerItem({ id: 'shells', name: '炮弹' });

    // ---- 武器配方（需要火药科技） ----
    m.registerRecipe({ id: 'craft_musket', name: '打造燧发枪', kind: 'batch', input: [{ item: 'ore', amount: 5 }, { item: 'wood', amount: 3 }, { item: 'gunpowder', amount: 1 }], output: { item: 'musket', amount: 1 }, interval: 10 });
    m.registerRecipe({ id: 'craft_rifle', name: '打造步枪', kind: 'batch', input: [{ item: 'ore', amount: 8 }, { item: 'gunpowder', amount: 1 }], output: { item: 'rifle', amount: 1 }, interval: 12 });
    m.registerRecipe({ id: 'craft_lmg', name: '打造机枪', kind: 'batch', input: [{ item: 'ore', amount: 15 }, { item: 'steel', amount: 3 }], output: { item: 'lmg', amount: 1 }, interval: 15 });
    m.registerRecipe({ id: 'craft_smg', name: '打造冲锋枪', kind: 'batch', input: [{ item: 'steel', amount: 5 }], output: { item: 'smg', amount: 1 }, interval: 10 });
    m.registerRecipe({ id: 'craft_cannon', name: '铸造大炮', kind: 'batch', input: [{ item: 'ore', amount: 30 }, { item: 'steel', amount: 10 }], output: { item: 'cannon', amount: 1 }, interval: 20 });
    m.registerRecipe({ id: 'craft_gunpowder', name: '制造火药', kind: 'batch', input: [{ item: 'ore', amount: 3 }], output: { item: 'gunpowder', amount: 2 }, interval: 5 });
    m.registerRecipe({ id: 'craft_bullets', name: '制造子弹', kind: 'batch', input: [{ item: 'ore', amount: 1 }, { item: 'gunpowder', amount: 1 }], output: { item: 'bullets', amount: 10 }, interval: 3 });
    m.registerRecipe({ id: 'craft_shells', name: '制造炮弹', kind: 'batch', input: [{ item: 'steel', amount: 2 }, { item: 'gunpowder', amount: 3 }], output: { item: 'shells', amount: 1 }, interval: 8 });

    // ---- 兵种敌人（speed/hp/dmg 组合 = 不同战术定位）----
    // 骑兵：高速 + 中 HP + 冲锋（dash）
    m.registerEnemy({
      id: 'cavalry', name: '骑兵', hp: CFG.cavalryHp, speed: CFG.cavalrySpeed, climb: 2, dmg: CFG.cavalryDmg,
      predator: true, dash: { range: 8, cd: 5 },
      loot: { item: 'food', amount: 5 },
    });
    // 装甲车：极厚 + 慢 + 重火力
    m.registerEnemy({
      id: 'armored-car', name: '装甲车', hp: CFG.tankHp, speed: CFG.tankSpeed, climb: 0, dmg: CFG.tankDmg,
      predator: true,
      loot: { item: 'steel', amount: 10 },
    });
    // 炮兵：脆 + 极慢 + 远程重击
    m.registerEnemy({
      id: 'artillery-unit', name: '炮兵', hp: CFG.artilleryHp, speed: CFG.artillerySpeed, climb: 1, dmg: CFG.artilleryDmg,
      predator: true,
      loot: { item: 'ore', amount: 8 },
    });

    // ---- 科技树（火药 → 燧发枪 → 步枪 → 机枪 → 冲锋枪；火药 → 大炮 → 装甲车）----
    m.registerTech({ id: 'military:gunpowder', name: '火药', unlocks: ['craft_musket', 'craft_gunpowder'], desc: '制造火药与燧发枪', fragments: 3 });
    m.registerTech({ id: 'military:rifle', name: '步枪', unlocks: ['craft_rifle', 'craft_bullets'], desc: '线膛步枪与子弹', fragments: 3 });
    m.registerTech({ id: 'military:lmg', name: '机枪', unlocks: ['craft_lmg'], desc: '自动机枪——高射速压制', fragments: 5 });
    m.registerTech({ id: 'military:smg', name: '冲锋枪', unlocks: ['craft_smg'], desc: '近距离高射速——突击', fragments: 4 });
    m.registerTech({ id: 'military:artillery', name: '炮兵', unlocks: ['craft_cannon', 'craft_shells'], desc: '大炮与炮弹——远程重击', fragments: 5 });

    // ---- 武器系统：装备武器的小人有远程攻击能力 ----
    m.registerSystemDef({
      id: 'weapons', label: '武器系统', category: 'raid',
      ctor: (ctx) => new WeaponSystem(ctx),
    });
  },
};

// 武器系统：装备武器的小人 → 远程射击敌人（超越 meleeRange 的近身反击）
// 只处理 batch 内的 pawn，2s 节流
class WeaponSystem {
  id = 'weapons';
  private _throttle = 0;
  private shootCd = new Map<number, number>();

  // 武器系统：装备武器的小人有远程射击能力
  // 监听 batch 内 pawn → 读 extra.worn → 查 meta.weapon → 射击范围内敌人
  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 0.5) return; // 0.5s 节流（射击检定）
    this._throttle = 0;

    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      // 只处理征召中的小人（非征召不开火）
      if (st.extra?.['drafted' as string] !== true) continue;

      // 读装备：extra.worn = "itemId"（wear 命令设）
      const worn = st.extra?.['worn' as string] as string | undefined;
      if (!worn) continue;
      const item = this.ctx.mods.items[worn];
      if (!item) continue;
      const weapon = (item.meta as Record<string, unknown>)?.['weapon' as string] as { dmg: number; range: number; cd: number; type: string } | undefined;
      if (!weapon) continue;

      // 射击冷却
      const cd = (this.shootCd.get(eid) ?? 0) - dt;
      if (cd > 0) { this.shootCd.set(eid, cd); continue; }

      // 找射程内最近敌人
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      let best: number = -1;
      let bestD2 = weapon.range * weapon.range;
      for (let i = 0; i < this.ctx.hostiles.length; i++) {
        const h = this.ctx.hostiles[i]!;
        const d2 = (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (best >= 0) {
        const h = this.ctx.hostiles[best]!;
        h.hp -= weapon.dmg;
        this.shootCd.set(eid, weapon.cd);
        // 击杀
        if (h.hp <= 0) {
          if (h.loot) this.ctx.stockpile[h.loot.item] = (this.ctx.stockpile[h.loot.item] ?? 0) + h.loot.amount;
          this.ctx.hostiles.splice(best, 1);
          this.ctx.logEvent(`🎯 #${eid} 用${item.name}击杀目标！`);
        }
      }
    }
  }
}