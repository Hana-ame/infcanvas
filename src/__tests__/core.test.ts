// 核心冒烟测试（2026-08-21 从零重写）——最小可玩闭环验证
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';
import { CORE_PACKS, defaultPlaystyle } from '../mods/packs';

function makeSim(): Sim {
  const reg = new ModRegistry();
  reg.mountMany(CORE_PACKS);
  reg.mount(defaultPlaystyle);
  return new Sim({ registry: reg, pawnCount: 4 });
}

describe('从零核心', () => {
  it('开局 4 鼠 + 4 系统 + 初始篝火', () => {
    const sim = makeSim();
    expect(sim.pawns.size).toBe(4);
    expect(sim.systems.map((s) => s.id)).toEqual(['needs', 'behavior', 'gather', 'raid']);
    expect(sim.world.buildings.size).toBe(1); // campfire
    expect(sim.campPos()).toBeDefined();
  });

  it('鼠自主采集：30 秒后木/食物增长', () => {
    const sim = makeSim();
    const w0 = sim.stockpile.wood, f0 = sim.stockpile.food;
    for (let i = 0; i < 600; i++) sim.step(0.05);
    expect(sim.stockpile.wood).toBeGreaterThan(w0);
    expect(sim.stockpile.food).toBeGreaterThan(f0);
    expect(sim.pawns.size).toBe(4); // 30s 内不死
  });

  it('玩家命令：批量移动 + 3s 冷却不自主', () => {
    const sim = makeSim();
    const eids = [...sim.pawns.keys()];
    sim.issueCommand('move', { eids, x: 10, y: 10 }, 'player');
    // 玩家的 commandCd=3 → behavior 跳过
    expect(sim.pawns.get(eids[0]!)!.commandCd).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) sim.step(0.05); // 2s < 3s
    const p = sim.pawns.get(eids[0]!)!.pos;
    expect(p.x !== 10 || p.y !== 10).toBe(true); // 没到（或命令冷却）
  });

  it('建造：消耗木材 + 放置建筑', () => {
    const sim = makeSim();
    sim.stockpile.wood = 100;
    sim.issueCommand('build', { buildingId: 'wall', x: 30, y: 30 });
    expect(sim.world.buildingAt(30, 30)?.defId).toBe('wall');
    expect(sim.stockpile.wood).toBe(98); // wall 耗 2
  });

  it('敌袭：野猫生成并攻击', () => {
    const sim = makeSim();
    // 跳过两次 raid interval 或直接塞敌人——直接塞 + 跑
    sim.world.buildings = new Map(); // 清营地? 不，直接推进
    // 用内部 timer：把 sim.step 跑 61s
    for (let i = 0; i < 61 * 20; i++) sim.step(0.05);
    expect(sim.hostiles.length).toBeGreaterThan(0);
  });
});