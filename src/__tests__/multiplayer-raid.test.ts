/**
 * multiplayer-raid.test.ts —— 多人联机对战与「玩家扮演 Raid 袭击指挥官」系统测试。
 */
import { describe, expect, it } from 'vitest';
import {
  Sim,
  getMultiplayerState,
  switchPlayerRole,
  spawnPlayerRaidSquad,
  orderPlayerRaiders,
  tickPlayerControlledRaiders,
} from '../sim';
import { ModRegistry } from '../mods';

describe('多人对战与玩家扮演 Raid 指挥官系统 (multiplayer-raid)', () => {
  it('支持切换玩家角色（Colony Defender <-> Raider Commander）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const st = switchPlayerRole(sim, 'raider');
    expect(st.localRole).toBe('raider');
    switchPlayerRole(sim, 'colony');
    expect(getMultiplayerState(sim).localRole).toBe('colony');
  });

  it('玩家扮演 Raid：消耗威胁点数从四方边缘或敌对据点投放袭击小队', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const st = getMultiplayerState(sim);
    st.raidPoints = 200;

    const r1 = spawnPlayerRaidSquad(sim, {
      unitKind: 'raider_rat_scout',
      count: 3,
      entryDirection: 'E',
    });
    expect(r1.ok).toBe(true);
    expect(r1.spawnedIds).toHaveLength(3);
    expect(sim.hostiles().length).toBeGreaterThanOrEqual(3);

    // 从赤爪敌对据点投放破墙工兵鼠
    const r2 = spawnPlayerRaidSquad(sim, {
      unitKind: 'raider_sapper',
      count: 2,
      entryDirection: 'base_redclaw_camp',
    });
    expect(r2.ok).toBe(true);
    expect(r2.spawnedIds).toHaveLength(2);
  });

  it('玩家扮演 Raid：下达推进 (march)、破墙 (breach_building)、战吼 (war_cry) 与撤退指令', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const st = getMultiplayerState(sim);
    st.raidPoints = 250;

    const sp = spawnPlayerRaidSquad(sim, { unitKind: 'raider_sapper', count: 2, entryDirection: 'N' });
    expect(sp.ok).toBe(true);

    // 战吼加速
    const cry = orderPlayerRaiders(sim, { mode: 'war_cry' });
    expect(cry.ok).toBe(true);
    expect(st.warCryUntil).toBeGreaterThan(sim.time);

    // 协同推进（生成 FlowField）
    const march = orderPlayerRaiders(sim, { mode: 'march', targetPos: { x: 0, y: 0 } });
    expect(march.ok).toBe(true);
    expect(st.activeFlowField).not.toBeNull();

    // 步进推进
    tickPlayerControlledRaiders(sim, 1.0);
    expect(st.raidPoints).toBeGreaterThan(0);

    // 破墙测试：放一堵墙在工兵旁
    const h = sim.hostiles()[0];
    const wall = sim.addBuilding('wall', Math.round(h.pos.x) + 1, Math.round(h.pos.y));
    if (wall) {
      const hpBefore = wall.hp;
      h.atkCd = 0;
      orderPlayerRaiders(sim, { mode: 'breach_building', targetBuildingId: wall.id });
      tickPlayerControlledRaiders(sim, 0.5);
      expect(wall.hp).toBeLessThan(hpBefore);
    }
  });
});
