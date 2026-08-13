// 采集狩猎 mod（2026-08-14 用户："现在只留采集狩猎"）
// 玩法包：卸载 farm/craft/techPool/autobuild/repair → 无耕种/手作/科技/自主扩张，纯采集 + 狩猎。
// 机制：
//   1. disableSystem 卸载默认系统（装配过滤，见 sim.registerSystems）
//   2. 猫掉肉：overrideDef 野猫 loot → food（击杀私有化进个人口袋，见 raidSystem）
//   3. 野外常驻猎物：mod 系统（huntWildSpawn）周期性在营地外刷少量游荡野猫（不是袭击波）
//   4. 狩猎卡 + hunt 工作：小人主动找猫 → 走过去 → 插件系统推进攻击 → 猫死掉肉
//   5. 采集侧重：tuning 调高食物采集产出 + 人口阈值放宽
import type { ModRegistry, HookContext } from '../sim/mods/registry';
import type { SimContext } from '../sim/systems/context';

export default (m: ModRegistry): void => {
  // 1) 卸载与纯采集狩猎无关的默认系统
  for (const id of ['farm', 'craft', 'techPool', 'autobuild', 'repair']) m.disableSystem(id);

  // 2) 野猫掉肉（击杀 → 个人口袋 food）
  m.overrideDef('enemy', 'cat', { loot: { item: 'food', amount: 4 }, dmg: 4, hp: 40 });

  // 3) 野外常驻猎物：每 ~40s 在营地外环带刷 1-3 只游荡野猫（非袭击波，纯猎物）
  m.registerSystemDef({
    id: 'huntWildSpawn', label: '野外猎物', category: 'raid', before: 'raid',
    ctor: (sim) => {
      let acc = 0;
      return {
        id: 'huntWildSpawn',
        init: () => {},
        update(dt: number) {
          acc += dt;
          if (acc < 40) return;
          acc = 0;
          // 猫数量上限（防堆积）：场内已有 ≥6 只野猫不再刷
          const cats = sim.hostiles.filter((h) => h.enemyId === 'cat').length;
          if (cats >= 6) return;
          // 营地外环带随机位置（远于 20 格，避免出生点被围攻）
          const cx = Math.floor(sim.world.width / 2);
          const cy = Math.floor(sim.world.height / 2);
          const r = 20 + Math.floor(sim.rng.next() * 40);
          const a = sim.rng.next() * Math.PI * 2;
          const x = Math.round(cx + Math.cos(a) * r);
          const y = Math.round(cy + Math.sin(a) * r);
          if (!sim.world.inBounds(x, y)) return;
          const count = 1 + Math.floor(sim.rng.next() * 3);
          const enemy = sim.mods.enemyDef('cat');
          for (let i = 0; i < count; i++) {
            sim.hostiles.push({
              x, y, hp: enemy.hp, maxHp: enemy.hp,
              targetX: cx, targetY: cy,
              name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
              speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
            });
          }
        },
      };
    },
  });

  // 4) 狩猎：卡 + 工作执行器
  m.registerWork('hunt', (c: SimContext, eid: number, st) => {
    const pos = c.pawnPositions.get(eid);
    if (!pos) return;
    // 找最近的猫（比袭击 combat 的 meleeRange 更远一点的主动索敌半径）
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const h of c.hostiles) {
      const d = (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2;
      if (d < bestD) { bestD = d; best = { x: h.x, y: h.y }; }
    }
    if (!best) { st.job = '闲逛'; return; }
    st.huntTarget = best;
    st.job = '狩猎';
    c.moveAdjacent(eid, best.x, best.y);
  });

  // 狩猎攻击推进系统：小人 huntTarget 到近旁后每帧对目标猫造成伤害（杀猫掉肉）
  m.registerSystemDef({
    id: 'huntCombat', label: '狩猎攻击', category: 'raid', before: 'raid',
    ctor: (sim) => ({
      id: 'huntCombat',
      init: () => {},
      update(dt: number) {
        for (const eid of sim.pawnList) {
          const st = sim.pawnStates.get(eid);
          const pos = sim.pawnPositions.get(eid);
          if (!st || !st.huntTarget || !pos) continue;
          const t = st.huntTarget;
          // 走到近旁才开始攻击（meleeRange 内）
          if (Math.hypot(pos.x - t.x, pos.y - t.y) > 2.2) continue;
          // 找该位置的猫（hostiles 按坐标匹配最近一只）
          let hit: number = -1;
          for (let i = 0; i < sim.hostiles.length; i++) {
            const h = sim.hostiles[i];
            if (Math.hypot(h.x - t.x, h.y - t.y) < 2.5) { hit = i; break; }
          }
          if (hit < 0) { st.huntTarget = undefined; st.job = '闲逛'; continue; }
          const h = sim.hostiles[hit];
          // 猎杀伤害：基础 + fight 技能加成（COC：fight 越高越快猎杀）
          const skill = st.skills?.fight ?? 10;
          h.hp -= (6 + skill * 0.15) * dt;
          sim.growSkill(eid, 'fight');
          if (h.hp <= 0) {
            sim.hostiles.splice(hit, 1);
            const loot = h.loot ?? { item: 'food', amount: 4 };
            if (loot.item === 'food') {
              st.inventory = { food: (st.inventory?.food ?? 0) + loot.amount }; // 猎物进个人口袋
            } else {
              sim.stockpile[loot.item] = (sim.stockpile[loot.item] ?? 0) + loot.amount;
            }
            sim.bus.emit({ type: 'resource_gained', eid, item: loot.item, amount: loot.amount });
            sim.recordOutcome(eid, 'fight', loot.amount);
            sim.logEvent(`🏹 #${eid} 猎杀了一只${h.name ?? '野猫'}，获得${loot.item === 'food' ? '肉' : loot.item}×${loot.amount}`);
            st.huntTarget = undefined;
            st.job = '闲逛';
          }
        }
      },
    }),
  });

  // 狩猎卡（work 系列）：附近有猫才可选；fight 技能越高越愿意打。
  // 注意：谓词必须先于卡注册（cardFromDef 构建卡时即解析 when 谓词）
  m.registerPredicate('huntNearby', (c) => c.view.hostilesNearby?.(c.eid) ?? false);
  m.registerCardDef({
    id: 'hunt', name: '狩猎', series: 'work', weight: 5,
    when: ['huntNearby'],
    utilityFixed: 25,
    action: 'walkAndWork', workType: 'hunt', label: '狩猎',
    satisfies: [{ desire: 'wrath', amount: 1 }],
  });

  // 5) 采集侧重：食物采集产出提高（tuning 覆盖），人口上限放宽；
  //    猫对建筑的伤害调低（采集狩猎是游牧生活，营地是歇脚处不是要塞，
  //    且无 autobuild 重建，营地被拆即散落——猫主要威胁人而非建筑）
  m.overrideTuning({
    gather: { harvestYield: 3.5 },
    population: { maxPawns: 10 },
    combat: { buildingDmg: 0.4 },
  });

  // 6) 营火自动重建：营地被拆后，若资源够则重建出生点 campfire（防鼠鼠散落成游牧）
  m.registerSystemDef({
    id: 'campRebuild', label: '营火重建', category: 'world', before: 'events',
    ctor: (sim) => {
      let acc = 0;
      return {
        id: 'campRebuild',
        init: () => {},
        update(dt: number) {
          acc += dt;
          if (acc < 60) return;
          acc = 0;
          const cx = Math.floor(sim.world.width / 2);
          const cy = Math.floor(sim.world.height / 2);
          if (sim.world.getBuilding(cx, cy + 2)) return; // 营火还在
          if ((sim.stockpile.wood ?? 0) < 10) return;     // 资源不足
          if (sim.world.placeBuilding(cx, cy + 2, 'campfire', 'auto')) {
            sim.socialUnits.onCampfireBuilt(sim.world.buildKey(cx, cy + 2));
            sim.stockpile.wood = Math.max(0, (sim.stockpile.wood ?? 0) - 10);
            sim.logEvent('🔥 鼠鼠们在原营地重建了篝火');
          }
        },
      };
    },
  });
};

export function __hunterProbe(ctx: HookContext): void { void ctx; }
