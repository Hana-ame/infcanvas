// hunter-gatherer 玩法包集成测试（2026-08-14）
// 覆盖：系统卸载装配 / 猎杀掉肉（个人口袋）/ 狩猎卡白天约束
// 发现背景：hg mod 多轮修复（猫拆营火拉锯 / hunt 卡抽不中 / 追猫 A* 风暴 /
// 全员狩猎夜宿崩溃），每个修复都需回归保护。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { hunterGathererPack } from '../hunter-gatherer';
import { World } from '../../sim/core/world';
import { cardPredicateOf } from '../../sim/mods/query';

// 2026-08-14 完全插件化：hg 已是 ModPack，经 registry.mount 装配（依赖图解析 requires:['gathering']）
const makeHg = () => {
  const mods = ModRegistry.default();
  mods.mount(hunterGathererPack);
  return new Sim({ seed: 20260803, pawnCount: 2, registry: mods });
};

describe('hunter-gatherer 玩法包', () => {
  it('装配：卸载 farm/craft/techPool/autobuild/repair/raid/medicine，保留狩猎三件套', () => {
    const sim = makeHg();
    for (const id of ['farm', 'craft', 'techPool', 'autobuild', 'repair', 'raid', 'medicine']) {
      expect(sim.systemIds).not.toContain(id);
    }
    for (const id of ['huntWildSpawn', 'huntCombat', 'campRebuild']) {
      expect(sim.systemIds).toContain(id);
    }
  });

  it('猎杀掉肉：huntCombat 击杀猫 → 个人口袋 food（私有化，不进公共库存）', () => {
    const sim = makeHg();
    const eid = sim.pawnList[0];
    const pos = sim.pawnPositions.get(eid)!;
    // 猫放在 2 格内（melee 范围），人为指定 huntTarget（绕过抽卡链，直测攻击推进）
    const enemy = sim.mods.enemyDef('cat');
    sim.hostiles.push({
      x: Math.round(pos.x) + 1, y: Math.round(pos.y), hp: enemy.hp, maxHp: enemy.hp,
      targetX: Math.round(pos.x) + 1, targetY: Math.round(pos.y),
      name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
      speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
    });
    const st = sim.pawnStates.get(eid)!;
    st.huntTarget = { x: Math.round(pos.x) + 1, y: Math.round(pos.y) };
    // 直接驱动 huntCombat 系统（不走行为系统，避免抽卡干扰测试确定性）
    const sys = (sim as unknown as { registry: { systems: { id: string; update(dt: number): void }[] } }).registry.systems.find((s) => s.id === 'huntCombat')!;
    // dt=0.1：伤害 0.75/帧，200 帧 = 150 > 猫 hp 40；累计 20s < 25s 追猫超时
    for (let i = 0; i < 200; i++) sys.update(0.1);
    expect(sim.hostiles.length).toBe(0);
    expect(st.inventory?.food ?? 0).toBeGreaterThanOrEqual(4);
    // 公共库存不涨（猎物私有化：击杀前后库存不变，开局 30）
    expect(sim.stockpile.food).toBe(30);
    // 记账（审计中③）：猎杀掉肉进 economy 流（earn 记到猎人头上,工作优先级评估可见狩猎收益）
    expect(sim.flow['food']?.earn ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('营火自主（审计中③）：重建篝火扣木记账（recordSpend → flow.wood.spend）', () => {
    const sim = makeHg();
    // 拆光所有 campfire（出生篝火）→ 触发重建分支。必须走 damageBuilding 正规拆除路径
    //（footprint/索引/拥挤占位表全清）——裸 delete 会残留拥挤表条目，后续 queryBuildingsNear
    // 读到幽灵建筑崩（hunger/nearAura 每帧查）。
    for (const [k, b] of [...sim.world.buildings]) {
      if (b.def.id === 'campfire') {
        const { x, y } = World.keyToXY(k);
        sim.world.damageBuilding(x, y, 999999);
      }
    }
    expect([...sim.world.buildings].some(([, b]) => b.def.id === 'campfire')).toBe(false);
    sim.stockpile.wood = 25;
    // 推进 60s：campRebuild acc 首个周期到点（无火 + wood>=10 → 重建出生点篝火）
    for (let i = 0; i < 65; i++) sim.step(1);
    const campsAfter = [...sim.world.buildings].filter(([, b]) => b.def.id === 'campfire').length;
    expect(campsAfter).toBeGreaterThanOrEqual(1); // 重建发生（campRebuild 是 hg 唯一补火来源）
    // 记账：重建扣 10 木 → flow.wood.spend 记录（此前直扣 stockpile 不记账；
    // 伐木 earn 同时入账使 stockpile 回升，故不断言库存上限）
    expect(sim.flow['wood']?.spend ?? 0).toBeGreaterThanOrEqual(10);
    expect(sim.flow['wood']?.spend ?? 0).toBeLessThan((sim.flow['wood']?.earn ?? 0) + 10);
  });

  it('狩猎卡白天约束：夜晚猫在旁时猎杀不发生（huntIsDay 谓词）', () => {
    const sim = makeHg();
    const eid = sim.pawnList[0];
    const pos = sim.pawnPositions.get(eid)!;
    const enemy = sim.mods.enemyDef('cat');
    sim.hostiles.push({
      x: Math.round(pos.x) + 8, y: Math.round(pos.y), hp: enemy.hp, maxHp: enemy.hp,
      targetX: Math.round(pos.x) + 8, targetY: Math.round(pos.y),
      name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
      speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
    });
    // 直接评估谓词（卡工厂从 predicateStore 解析 when）
    const dayOk = cardPredicateOf('huntIsDay');
    // 模拟白天 ctx：isNight=false → 谓词真；夜晚（isNight=true）→ 假
    const dayCtx = { view: { isNight: () => false } } as never;
    const nightCtx = { view: { isNight: () => true } } as never;
    expect(dayOk(dayCtx)).toBe(true);
    expect(dayOk(nightCtx)).toBe(false);
  });
});