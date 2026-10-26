/**
 * npc-bases-minerals.test.ts —— 无限地图矿脉开采与野生 NPC 据点（Friendly & Hostile）完整测试。
 */
import { describe, expect, it } from 'vitest';
import {
  Sim,
  mineralAt,
  mineMineralAt,
  getNpcBases,
  discoverChunkOutposts,
  tradeWithNpcBase,
  giftNpcBase,
  requestAllyReinforcements,
  assaultNpcBase,
} from '../sim';
import { ModRegistry } from '../mods';

describe('无限地图矿物系统与野生 NPC 据点 (npc-bases)', () => {
  it('无限地图上可确定性扫描到矿脉，开采后入库且原格耗尽', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    let found = null;
    outer: for (let y = -45; y <= 45; y++) {
      for (let x = -45; x <= 45; x++) {
        const m = mineralAt(sim.world, x, y);
        if (m) {
          found = m;
          break outer;
        }
      }
    }
    expect(found).not.toBeNull();
    const before = sim.stockpile[found!.yieldItem] ?? 0;
    const res = mineMineralAt(sim, 1, found!.x, found!.y);
    expect(res.ok).toBe(true);
    expect(sim.stockpile[found!.yieldItem]).toBeGreaterThan(before);
    // 同一格已被采空
    expect(mineralAt(sim.world, found!.x, found!.y)).toBeNull();
  });

  it('默认世界包含友好 (friendly) 与敌对 (hostile) 野生 NPC 据点', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const bases = [...getNpcBases(sim).values()];
    const friendly = bases.filter((b) => b.attitude === 'friendly');
    const hostile = bases.filter((b) => b.attitude === 'hostile');
    expect(friendly.length).toBeGreaterThanOrEqual(2);
    expect(hostile.length).toBeGreaterThanOrEqual(2);
  });

  it('友好野生据点：支持物资贸易、赠礼涨好感与呼叫鼠卫盟军驰援', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 50;
    const beforeMeal = sim.stockpile['meal'] ?? 0;

    const tradeRes = tradeWithNpcBase(sim, 'base_acorn_bazaar', 0);
    expect(tradeRes.ok).toBe(true);
    expect(sim.stockpile['meal'] ?? 0).toBeGreaterThan(beforeMeal);

    // 呼叫盟军支援对敌军造成伤害并空投补给
    const h = sim.spawnHostile('cat', 4, 4);
    const hp0 = h.hp;
    const allyRes = requestAllyReinforcements(sim, 'base_acorn_bazaar');
    expect(allyRes.ok).toBe(true);
    expect(h.hp).toBeLessThan(hp0);
  });

  it('敌对野生据点：支持远征队攻城夺取全套战利品，或多次赠礼转化为友好据点', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const beforeGold = sim.stockpile['gold'] ?? 0;

    // 连续远征猛攻赤爪掠夺者营地直至攻克
    let defeated = false;
    for (let i = 0; i < 6; i++) {
      const r = assaultNpcBase(sim, 'base_redclaw_camp');
      expect(r.ok).toBe(true);
      if (r.defeated) {
        defeated = true;
        break;
      }
    }
    expect(defeated).toBe(true);
    expect(sim.stockpile['gold'] ?? 0).toBeGreaterThan(beforeGold);

    // 对另一座敌对据点通过赠礼缓和关系转为 friendly
    sim.stockpile['wood'] = 200;
    for (let i = 0; i < 8; i++) {
      giftNpcBase(sim, 'base_rustfang_fort', 'wood', 10);
    }
    const fort = getNpcBases(sim).get('base_rustfang_fort')!;
    expect(fort.attitude).toBe('friendly');
  });

  it('远方大区块探索可动态发现新的野生据点', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    let discovered = null;
    for (let cx = 3; cx <= 20; cx++) {
      const b = discoverChunkOutposts(sim, cx, -4);
      if (b) {
        discovered = b;
        break;
      }
    }
    expect(discovered).not.toBeNull();
  });
});
