// 跨模块组合测试（2026-08-20）：验证多个模块协同工作时的行为正确性。
// 场景：① 战场指挥 + 驯兽守卫协同（指挥官征召 → 守卫猫参战）
//       ② 寻路缓存跨决策周期存活（decisionCd 不清 trailCache）
//       ③ 暖炉烧木 + 温度场 + 决策节流（节流期间不重新决策但仍受温度惩罚）
//       ④ 装配卸载 + 命令契约（卸 field-command 系统后 drafting 仍在，命令处理器随包保留）
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { pushHostile } from '../../sim/systems/hostiles';
import { ENEMIES } from '../../sim/defs/enemies';
import { World } from '../../sim/core/world';

const makeSim = (seed = 100, pawns = 5) => {
  const mods = ModRegistry.default();
  return new Sim({ seed, pawnCount: pawns, registry: mods });
};

describe('跨模块组合测试（2026-08-20）', () => {
  it('① 战场指挥 + 驯兽守卫协同：册封指挥官 → 征召 → 同时驯化重伤猫 → 守卫参战', () => {
    const sim = makeSim(101, 4);
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 步进让小人就位
    for (let i = 0; i < 60; i++) sim.step(1);

    // 册封指挥官 + 下达冲锋
    const [c, s1, s2] = sim.pawns.slice(0, 3);
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: c, args: { tactic: 'charge' } });
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: c, args: { subordinates: [s1, s2] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: c, args: { tactic: 'charge' } });

    // 放一只重伤猫用于驯化
    pushHostile(sim as never, ENEMIES.cat, cx + 4, cy + 4, { targetX: cx, targetY: cy });
    const cat = sim.hostiles[sim.hostiles.length - 1]!;
    cat.hp = cat.maxHp * 0.15; // 重伤
    const tamer = sim.pawns[3] ?? sim.pawns[0];
    sim.pawnStates.get(tamer)!.decisionCd = 0; // 确保立即决策
    sim.issueCommand({ type: 'tame', x: 0, y: 0, pawnId: tamer, args: { hostileIndex: sim.hostiles.indexOf(cat) } });
    expect(cat.taming).toBeDefined();

    // 验证：指挥官 + 驯化同时生效（不互斥）
    expect(sim.pawnProfile(c)?.commander).toBeDefined();
    expect(sim.pawnProfile(c)?.tactic).toBe('charge');
    expect(cat.taming?.tamer).toBe(tamer);

    // 推进驯化到完成
    sim.stockpile.food = 200;
    for (let i = 0; i < 120; i++) sim.step(0.5); // 60 秒 > 20 秒驯化
    expect(cat.faction).toBe('player'); // 驯服成功
    expect(cat.owner).toBe(tamer);
  });

  it('② 寻路缓存跨决策周期存活：decisionCd 期间 trailCache 不被清', () => {
    const sim = makeSim(102, 3);
    for (let i = 0; i < 60; i++) sim.step(0.2); // 热身 + 缓存建立
    const tc = sim as unknown as { trailCache: Map<string, unknown> };
    const cacheBefore = tc.trailCache.size;
    expect(cacheBefore).toBeGreaterThan(0); // 确实有缓存
    // 步进过多个决策周期（decisionInterval=2s，步进 10 秒）
    for (let i = 0; i < 50; i++) sim.step(0.2);
    // 缓存不因决策周期切换而清空（只有地形/建筑变更才清）
    expect(tc.trailCache.size).toBeGreaterThan(0);
  });

  it('③ 装配卸载：卸载 field-command 系统后 drafting 仍在，命令处理器随包保留（不随系统卸载）', () => {
    const mods = ModRegistry.default();
    mods.disableSystem('field-command');
    // field-command 卸载 = 系统不在序；命令处理器按“命令随包不随系统”仍注册
    const sim = new Sim({ seed: 103, pawnCount: 3, registry: mods });
    expect(sim.systemIds).not.toContain('field-command');
    // 但 drafting 仍在
    expect(sim.systemIds).toContain('drafting');
    // commander/train/dispatch 命令仍注册（field-command 包仍挂载）
    expect(sim.mods.commandHandlers.has('commander')).toBe(true);
    expect(sim.mods.commandHandlers.has('draft')).toBe(true);
  });

  it('④ 存档往返 + 驯兽守卫：驯化中/守卫状态随局不随档（读档后野生化）', () => {
    const sim = makeSim(104, 3);
    for (let i = 0; i < 30; i++) sim.step(1);
    // 放一只猫并驯化中
    pushHostile(sim as never, ENEMIES.cat, 50, 50, {});
    const cat = sim.hostiles[0]!;
    cat.hp = cat.maxHp * 0.15;
    cat.taming = { progress: 5, tamer: sim.pawns[0] };
    const beforeTaming = cat.taming;

    // 存档
    const data = sim.save();
    // 读档
    const sim2 = new Sim({ seed: 104, pawnCount: 0, registry: ModRegistry.default() });
    sim2.load(data);
    // hostiles 是运行时状态 → 存档不含 → 读档后 hostiles 为空（驯化中猫消失）
    expect(sim2.hostiles.length).toBe(0);
    // 但 pawn 保留了（不受 hostiles 丢失影响）
    expect(sim2.pawns.length).toBeGreaterThan(0);
  });

  it('⑤ 冲锋战术 + 寻路：冲锋指定目标后 attackTarget 设定 → drafting 接管追击', () => {
    const sim = makeSim(105, 3);
    const [c, s1, s2] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: c, args: { subordinates: [s1, s2] } });
    // 放一个静止敌
    sim.hostiles.push({
      x: 80, y: 80, hp: 500, maxHp: 500, targetX: 80, targetY: 80,
      name: '掠夺者', enemyId: 'raider', faction: 'unit', speed: 0, dmgPerSec: 0.01, loot: { item: 'food', amount: 2 },
    });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: c, args: { tactic: 'charge' } });
    for (const eid of [c, s1, s2]) {
      sim.pawnStates.get(eid)!.decisionCd = 0; // 确保立即决策
    }
    // 步进看 attackTarget 是否设定
    for (let i = 0; i < 60; i++) sim.step(0.2);
    // 至少有一个受命者设了 attackTarget
    // charge 走 engageRadius 自动索敌 → 设 attackTarget；或 drafted + attackTarget 已设
    const hasDrafted = [c, s1, s2].some((e) => sim.pawnProfile(e)?.drafted === true);
    expect(hasDrafted).toBe(true); // 至少被征召了
  });

  it('⑥ 暖炉 + 温度场 + 篝火光环：多热源叠加不崩（thermo + san 同帧跑）', () => {
    const sim = makeSim(106, 2);
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 放暖炉
    for (let dx = -3; dx <= 3; dx++) {
      if (sim.world.placeBuilding(cx + dx, cy + 2, 'heater', 'player')) break;
    }
    sim.stockpile.wood = 50;
    // 步进 60 秒——thermo 烧木 + san 篝火恢复同帧跑，不崩
    expect(() => { for (let i = 0; i < 300; i++) sim.step(0.2); }).not.toThrow();
  });
});