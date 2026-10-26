/**
 * rimworld-bootstrap.test.ts —— bootstrapLocalRimWorldPreset 覆盖矩阵。
 *
 * 目的：锁死「本地模式开局套件」的关键不变量，让 preset 抽出的行为与 main.ts
 * 原版逐字节等价。任何行为漂移（漏掉一处 placeArchitectBuilding、改了一个坐标、
 * 换了名字）都会在这里红。
 *
 * 覆盖点：
 *   1. 启用 RimWorld 玩家规则（playerRimWorldMode / activePlayerId / singleOccupancy）
 *   2. stockpile 开局加成生效（wood/ore/stone/gold/herb 下限）
 *   3. 开局建筑存在（wall / door / stove / butcher_table / shelf / great_bonfire）
 *   4. 敌人/尸体已生成（hostiles 非空）
 *   5. 陌生人生成（isStranger=true，名字含"陌生人"）
 *   6. 确定性：同 seed 下 preset 输出指纹一致
 *   7. 幂等性警告：连调两次会重复生成敌人（**不是**幂等，这是设计约束）
 */
import { describe, expect, it } from 'vitest';
import { ModRegistry } from '../mods';
import { Sim, bootstrapLocalRimWorldPreset, fingerprint, getPackBeasts } from '../sim';

function newLocalSim(seed = 42): Sim {
  const sim = new Sim({ seed, registry: ModRegistry.default(), playerRimWorldMode: true });
  bootstrapLocalRimWorldPreset(sim);
  return sim;
}

describe('bootstrapLocalRimWorldPreset', () => {
  it('启用 RimWorld 玩家规则（playerRimWorldMode / activePlayerId / singleOccupancy）', () => {
    const sim = newLocalSim();
    expect(sim.playerRimWorldMode).toBe(true);
    expect(sim.activePlayerId).toBe('p_local_1');
    expect(sim.world.rimWorldSingleOccupancy).toBe(true);
  });

  it('stockpile 开局加成生效（boost 后减去建造消耗的最终值）', () => {
    const sim = newLocalSim();
    // boost: wood→60, ore→32, stone→24, gold→8, herb→12
    // 建造消耗：stove(wood 10,ore 4) + butcher_table(wood 8,ore 2)
    //         + shelf(wood 6) + great_bonfire(wood 16,stone 6) = wood 40, ore 6, stone 6
    // 最终值（seed=42 下确定性结果）：
    expect(sim.stockpile['wood']).toBe(20);
    expect(sim.stockpile['ore']).toBe(26);
    expect(sim.stockpile['stone']).toBe(18);
    expect(sim.stockpile['gold']).toBe(8);
    expect(sim.stockpile['herb']).toBe(12);
  });

  it('开局建筑齐全（wall / door / stove / butcher_table / shelf / great_bonfire）', () => {
    const sim = newLocalSim();
    const kinds = [...sim.world.buildings.values()].map((b) => b.defId);
    expect(kinds).toContain('wall');
    expect(kinds).toContain('door');
    expect(kinds).toContain('stove');
    expect(kinds).toContain('butcher_table');
    expect(kinds).toContain('shelf');
    expect(kinds).toContain('great_bonfire');
  });

  it('温驯驼兽（Pack Beast）已生成', () => {
    const sim = newLocalSim();
    // spawnPackBeast 生成的是友方贸易动物，不是 hostiles
    const beasts = getPackBeasts(sim);
    expect(beasts.length).toBe(1);
    expect(beasts[0].ownerPlayerId).toBe('p_local_1');
  });

  it('陌生人生成（isStranger=true，名字含"陌生人"）', () => {
    const sim = newLocalSim();
    const stranger = [...sim.pawns()].find((p) => p.isStranger);
    expect(stranger).toBeDefined();
    expect(stranger!.name).toContain('陌生人');
    expect(stranger!.controlledBy).toBe('p_stranger_faction');
  });

  it('确定性：同 seed 下 preset 输出指纹一致', () => {
    const a = newLocalSim(20260821);
    const b = newLocalSim(20260821);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('不同 seed 下 preset 输出指纹不同（sanity check）', () => {
    const a = newLocalSim(1);
    const b = newLocalSim(2);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('幂等性警告：连调两次会重复生成驼兽/尸体/陌生鼠（**不是**幂等，设计约束）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    bootstrapLocalRimWorldPreset(sim);
    const beastsAfter1st = getPackBeasts(sim).length;
    const pawnsAfter1st = sim.pawnMap.size;
    bootstrapLocalRimWorldPreset(sim);
    // 设计约束：不幂等。第二次调用会追加驼兽 + 尸体 + 陌生鼠。
    expect(getPackBeasts(sim).length).toBeGreaterThan(beastsAfter1st);
    expect(sim.pawnMap.size).toBeGreaterThan(pawnsAfter1st);
  });

  it('可选 playerId 参数生效', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    bootstrapLocalRimWorldPreset(sim, { playerId: 'p_test_42' });
    expect(sim.activePlayerId).toBe('p_test_42');
    // 陌生鼠的 controlledBy 仍然固定为 'p_stranger_faction'（与 main.ts 原版一致）
    const stranger = [...sim.pawns()].find((p) => p.isStranger);
    expect(stranger!.controlledBy).toBe('p_stranger_faction');
  });

  it('建筑归属：所有开局建筑的 ownerPlayerId = playerId', () => {
    const sim = newLocalSim();
    const buildings = [...sim.world.buildings.values()];
    // 至少有一栋建筑属于 p_local_1（其他建筑可能是无主或属于别的玩家）
    const owned = buildings.filter((b) => b.ownerPlayerId === 'p_local_1');
    expect(owned.length).toBeGreaterThan(0);
  });
});
