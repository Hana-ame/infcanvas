/**
 * factions.test.ts —— 派系外交包：部落登记 / 贸易 / 掠夺 / 传闻 / 卸载 / 存读档。
 *
 * 每条测试的价值（不是"跑了就不算"）：
 *  - 「双向声望初值」这条专门抓循环死锁：单靠跑 900 tick 看 trade 有没有被抽到，
 *    在长局里可能恰好没触发（社交卡权重被压制、鼠群忙于吃喝），死锁会一直隐身。
 *  - 「卸载」这条是本包最重要的卸载测试：raider 的 AI 不在本包，卸载 factions 后
 *    必须只剩"没有 raider"，而 raid 包的猫照常出没。
 */
import { describe, expect, it } from 'vitest';
import { Sim, cardWeight, loadSim, snapshotOf } from '../sim';
import { ModRegistry } from '../mods';
import { K_STOCK_FOOD, K_STOCK_WOOD, K_TAG_FIRE } from '../mods/contracts';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';
import { FACTION_KEYS, factionIds, factionNameOf, factionsPack } from '../mods/packs/factions';

/**
 * SOLO 装配：factions 的全部硬依赖 + needs/social/gathering，
 * 不含 tech/farming/cooking/hunting（那些与本包无关，加进来只会污染断言）。
 * factions.requires = ['building','raid','bootstrap']——三者缺一，mountPacks 会在
 * 挂载期响亮失败，而不是运行期静默降级。
 */
const SOLO = [needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack, factionsPack];

/** 找一片可立足、且离任何现有篝火 > 5 格的空地（minSpacing=5 会拒绝更近的同类建筑）。 */
function freeSpot(s: Sim, ox: number, oy: number, rMin = 6, rMax = 16): { x: number; y: number } {
  for (let r = rMin; r <= rMax; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = ox + dx;
        const y = oy + dy;
        if (!s.passable(x, y)) continue;
        if (s.nearestBuildingByTag(K_TAG_FIRE, x, y, 5.5)) continue;
        return { x, y };
      }
    }
  }
  throw new Error(`找不到可落脚地（原点 ${ox},${oy}，环 ${rMin}~${rMax}）`);
}

/** 两座篝火的最小装配 + 一步同步，返回两个派系 id（[0] = 出生篝火）。
 *  `noDrift` = true 时关掉声望漂移，用于隔离测掠夺/贸易本身
 *  （漂移每 check 拍施加 ±repDriftMag 的噪声，会把「声望恰好降了 repLossRaid」
 *  这类精确断言打散——那是漂移的本职，不是掠夺的）。 */
function twoFactionSim(seed: number, noDrift = false): Sim {
  const reg = ModRegistry.mountPacks(SOLO);
  reg.overrideTuning((t) => {
    t.bootstrap.pawnCount = 0; // 要的是可控世界，不要随机鼠群
    if (noDrift) {
      t.factions.repMeanRev = 0;
      t.factions.repDriftMag = 0;
    }
  });
  const s = new Sim({ seed, registry: reg });
  // 喂足木柴：building 包的 buildings-upkeep 每 12s 烧一份 wood，断薪会按 id 序
  // 熄灭篝火 → 派系随之消失，测试夹具会自己把自己拆掉。
  s.stockpile[K_STOCK_WOOD] = 500;
  const spot = freeSpot(s, 0, 0);
  const b2 = s.addBuilding('campfire', spot.x, spot.y);
  if (!b2) throw new Error('第二座篝火落不了地');
  s.step(1); // factions-sync 扫描到新火 → 登记为 seq 1 = 野营-2
  return s;
}

describe('派系外交包', () => {
  it('派系登记：开局 1 个派系且有名字；再建一座篝火 → 2 个派系、名字按序递增', () => {
    const s = new Sim({ seed: 1, registry: ModRegistry.mountPacks(SOLO) });
    // 开局：bootstrap.init 落出生篝火，factions-sync.init 登记为首个派系
    expect(factionIds(s)).toHaveLength(1);
    expect(factionNameOf(s, factionIds(s)[0])).toBe('鼠团');
    expect(s.scratch[FACTION_KEYS.seq]).toBe(1); // 序号计数器已推进

    // 再建一座篝火 → 同步出第二个派系，名字按登记顺序递增
    const spot = freeSpot(s, 0, 0);
    const b2 = s.addBuilding('campfire', spot.x, spot.y);
    expect(b2).not.toBeNull();
    s.step(1);
    const ids = factionIds(s);
    expect(ids).toHaveLength(2);
    expect(factionNameOf(s, ids[0])).toBe('鼠团');
    expect(factionNameOf(s, ids[1])).toBe('野营-2');
    expect(factionNameOf(s, b2!.id)).toBe('野营-2'); // id→名字 的映射方向正确
  });

  it('开局双向声望都 === repInit，且 repInit > friendlyThresh（贸易前提天然成立）', () => {
    // 这条测试的价值：它直接抓循环死锁。
    //   声望上升的唯一来源是 trade（+repGainTrade），而 trade 的门槛是 rep > friendlyThresh。
    //   若初值 ≤ friendlyThresh，则 trade 抽不中 ⇒ 声望永不涨 ⇒ trade 永远抽不中。
    //   单靠"跑 900 tick 看 trade 有没有被抽到"在长局里可能恰好没触发，死锁会一直隐身。
    const s = twoFactionSim(2);
    const ids = factionIds(s);
    expect(ids).toHaveLength(2);
    const init = s.tuning.factions.repInit;
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(s.scratch[FACTION_KEYS.rep(a, b)], `声望 ${factionNameOf(s, a)} → ${factionNameOf(s, b)}`).toBe(init);
      }
    }
    expect(init, '死锁守卫：初值必须高于友好线').toBeGreaterThan(s.tuning.factions.friendlyThresh);
    expect(init).toBeLessThan(100);
  });

  it('贸易：付 wood 得 food（按 tradeRatio 净转化），双方声望各 +repGainTrade', () => {
    const s = twoFactionSim(3);
    const [A, B] = factionIds(s);
    // 显式写声望 > friendlyThresh（两个方向都写）：钉住"贸易要求的是 home 对 target 的方向"
    const friendly = 60;
    s.scratch[FACTION_KEYS.rep(A, B)] = friendly;
    s.scratch[FACTION_KEYS.rep(B, A)] = friendly;

    // 摆一只鼠在 B 旁（家 = B），对面 A 在磁铁半径内 → trade 卡的 condition 必须成立
    const b2 = [...s.buildingsAll()].find((b) => b.id === B)!;
    const eid = s.spawnPawn(b2.pos.x, b2.pos.y);
    const p = s.pawn(eid)!;
    const trade = s.cardById('trade')!;
    expect(trade.series).toBe('trade');
    // 不变式回归：duration 必须装得下整段跋涉。stepPawn 的顺序是「到期检查 → action
    // → moveStep」，action 在 moveStep 之前，所以抵达后还要再多 1 拍才能结算。
    // 改了磁铁半径或 duration 却不改这条，trade 会静默变成死代码——本包踩过这个坑
    // （duration 3 时 8.5 格的贸易在第 4 拍到期重抽，鼠永远走不完）。
    const needDuration = Math.ceil(s.tuning.factions.tradeMagnetRadius / s.tuning.pawn.speed) + 1;
    expect(trade.duration, `磁铁 ${s.tuning.factions.tradeMagnetRadius} 格需要至少 ${needDuration}s`).toBeGreaterThanOrEqual(needDuration);
    expect(trade.duration).toBeGreaterThan(3);
    const wood0 = s.stockpile[K_STOCK_WOOD]!; // twoFactionSim 已喂足木柴（防 upkeep 熄火）
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;

    // 条件必须**天然成立**，不是靠手工凑位置
    expect(trade.condition!(p, s)).toBe(true);

    // 逼抽 trade，跑到第一次真正成交为止（第一次成交即停 → 恰好一次，delta 可精确断言）
    s.debugForceCard(eid, 'trade');
    let traded = false;
    for (let i = 0; i < 15 && !traded; i++) {
      s.step(1);
      traded = s.events.some((e) => e.text.includes('🤝'));
    }
    expect(traded, 'trade 卡在 15 秒内没有成交：磁铁/到位半径或声望方向有问题').toBe(true);

    const cost = s.tuning.factions.tradeWoodCost;
    const gain = Math.round(cost * s.tuning.factions.tradeRatio);
    expect(wood0 - (s.stockpile[K_STOCK_WOOD] ?? 0)).toBe(cost); // 付了 2 份 wood
    expect((s.stockpile[K_STOCK_FOOD] ?? 0) - food0).toBe(gain); // 得 round(2 × 0.5) = 1 份 food
    // 双向声望各 +repGainTrade（有向键各写一次，任缺一个方向都会被这里抓住）
    expect(s.scratch[FACTION_KEYS.rep(A, B)]).toBe(friendly + s.tuning.factions.repGainTrade);
    expect(s.scratch[FACTION_KEYS.rep(B, A)]).toBe(friendly + s.tuning.factions.repGainTrade);
    // 声望不越界
    expect(s.scratch[FACTION_KEYS.rep(A, B)]).toBeLessThanOrEqual(100);
  });

  it('贸易条件：声望低于友好线时 condition 必须为 false（门槛不是装饰）', () => {
    const s = twoFactionSim(4);
    const [A, B] = factionIds(s);
    s.scratch[FACTION_KEYS.rep(A, B)] = 10; // < friendlyThresh(30)
    s.scratch[FACTION_KEYS.rep(B, A)] = 10;
    const b2 = [...s.buildingsAll()].find((b) => b.id === B)!;
    const p = s.pawn(s.spawnPawn(b2.pos.x, b2.pos.y))!;
    s.stockpile[K_STOCK_WOOD] = 100;
    expect(s.cardById('trade')!.condition!(p, s)).toBe(false);
  });

  it('掠夺：声望低于敌对线且过了 checkSec → 刷 raider、声望再降、gossip 上升', () => {
    const s = twoFactionSim(5, true);
    const [A, B] = factionIds(s);
    expect(s.hostiles()).toHaveLength(0);
    s.scratch[FACTION_KEYS.rep(A, B)] = -40; // < hostileThresh(-25)
    const rep0 = s.scratch[FACTION_KEYS.rep(A, B)]!;

    const check = s.tuning.factions.checkSec;
    // 跑过 checkSec，掠夺检查必然至少触发一次
    let found = false;
    for (let i = 0; i < check + 30 && !found; i++) {
      s.step(1);
      found = s.hostiles().some((h) => h.kind === 'raider');
    }
    expect(found, `跑过 checkSec(${check}s) 仍无 raider：掠夺检查没触发或落点找不到`).toBe(true);

    // raider 定义已注册（raid.tickCats 靠 tuning.enemies[h.kind] 驱动它）
    const raider = s.tuning.enemies['raider'];
    expect(raider).toBeDefined();
    expect(raider!.hp).toBeGreaterThan(s.tuning.enemies['cat']!.hp); // 比猫更强：它是派系间的背叛

    // 声望再降（背叛加深仇恨）
    expect(s.scratch[FACTION_KEYS.rep(A, B)]).toBeLessThan(rep0);
    expect(s.scratch[FACTION_KEYS.rep(A, B)]).toBe(rep0 - s.tuning.factions.repLossRaid);
    // 掠夺方的传闻上升（"故事活在传闻里"）
    expect(s.scratch[FACTION_KEYS.gossip(A)] ?? 0).toBeGreaterThan(0);
    // 冷却被记上
    expect(s.scratch[FACTION_KEYS.raidCd(A, B)] ?? 0).toBeGreaterThan(0);
    // 落点必须可立足（掉进湖里的 raider 会永久卡死成幽灵敌袭）
    for (const h of s.hostiles()) {
      expect(s.passable(Math.round(h.pos.x), Math.round(h.pos.y))).toBe(true);
    }
  });

  it('掠夺：声望高于敌对线时绝不刷 raider（谓词不是常开的）', () => {
    const s = twoFactionSim(6, true);
    const [A, B] = factionIds(s);
    s.scratch[FACTION_KEYS.rep(A, B)] = 80; // 友好
    s.scratch[FACTION_KEYS.rep(B, A)] = 80;
    s.run(s.tuning.factions.checkSec * 3); // 三次检查窗口，一次都不该刷
    expect(s.hostiles().some((h) => h.kind === 'raider')).toBe(false);
    expect(factionIds(s)).toContain(A);
    expect(factionIds(s)).toContain(B);
  });

  it('掠夺冷却：同一对派系的相邻两波间隔 ≥ raidCooldownSec', () => {
    const s = twoFactionSim(7);
    const [A, B] = factionIds(s);
    s.scratch[FACTION_KEYS.rep(A, B)] = -60;
    const cdSec = s.tuning.factions.raidCooldownSec;

    // 追踪 raidCd 键的变化时刻 = 掠夺发生的时刻
    const raidTimes: number[] = [];
    let lastCd = 0;
    for (let i = 0; i < 320; i++) {
      s.step(1);
      const cd = s.scratch[FACTION_KEYS.raidCd(A, B)] ?? 0;
      if (cd !== lastCd) {
        raidTimes.push(s.time);
        lastCd = cd;
      }
    }
    expect(raidTimes.length, '320 秒内至少该有 3 波掠夺').toBeGreaterThanOrEqual(3);
    for (let i = 1; i < raidTimes.length; i++) {
      const gap = raidTimes[i] - raidTimes[i - 1];
      expect(gap, `第 ${i} 波间隔 ${gap}s`).toBeGreaterThanOrEqual(cdSec);
    }
  });

  it('传闻随时间衰减，且 gossip > 0 时压低本派系成员的 SER_SOCIAL 权重', () => {
    const s = new Sim({ seed: 8, registry: ModRegistry.mountPacks(SOLO) });
    s.step(1);
    const A = factionIds(s)[0];
    const g = FACTION_KEYS.gossip(A);
    const p = [...s.pawns()][0];
    const social = s.cardById('chat')!;
    expect(social.series).toBe('social');

    s.scratch[g] = 0.8;
    const wGossipy = cardWeight(p, social, s);
    s.scratch[g] = 0;
    const wCalm = cardWeight(p, social, s);
    expect(wGossipy).toBeLessThan(wCalm); // 有传闻 → 社交变谨慎
    expect(wCalm / wGossipy).toBeCloseTo(1 / (1 - 0.8 * s.tuning.factions.socialPenalty), 5); // 压制系数精确

    // 衰减：0.8 经 60s 应降到 0.8 - 0.01×60 = 0.2
    s.scratch[g] = 0.8;
    s.run(60);
    const after = s.scratch[g] ?? 0;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(0.8);
    // 衰减到 0 即删键，scratch 不无界增长
    s.run(200);
    expect(s.scratch[g]).toBeUndefined();
  });

  /**
   * 【本包最重要的卸载测试】卸载 factions 后，raid 包必须照常工作。
   *
   * raider 的追猎 AI **不在本包**——raid.tickCats 遍历全部 hostile、跳过 passive 的，
   * 剩下的一律驱动。依赖链是单向的：factions 产生 raider → raid 驱动 raider。
   * 所以卸载 factions 的正确后果只有"没有 raider"，猫的叙事压力生成与追咬不受影响。
   * 如果 raid 包被本包污染（比如 raider 的 AI 被写进了 raid），这里会红。
   */
  it('卸载 factions：raid 包的猫照常出没，全场无 raider（卸载不破坏核心）', () => {
    const s = new Sim({
      seed: 42,
      registry: ModRegistry.mountPacks([needsPack, gatheringPack, buildingPack, bootstrapPack, raidPack]),
    });
    let sawCat = false;
    let sawRaider = false;
    for (let i = 0; i < 600; i++) {
      s.step(1);
      for (const h of s.hostiles()) {
        if (h.kind === 'cat') sawCat = true;
        if (h.kind === 'raider') sawRaider = true;
      }
    }
    expect(sawCat, '600 秒内连一只猫都没见过：raid 包失效了').toBe(true);
    expect(sawRaider).toBe(false);
    expect(s.tuning.enemies['raider']).toBeUndefined(); // 敌人定义也随包卸载
    expect(s.tuning.factions).toBeDefined(); // tuning 残留在出厂表，但无人读（安全）
  });

  it('存读档：声望 / 传闻 / 派系名 / 掠夺冷却全部随档', () => {
    const s = twoFactionSim(9);
    const [A, B] = factionIds(s);
    s.scratch[FACTION_KEYS.rep(A, B)] = 55;
    s.scratch[FACTION_KEYS.rep(B, A)] = -18;
    s.scratch[FACTION_KEYS.gossip(A)] = 0.42;
    s.scratch[FACTION_KEYS.raidCd(A, B)] = 999;
    s.scratch[FACTION_KEYS.seq] = 2;
    const namesBefore = factionIds(s).map((id) => factionNameOf(s, id));

    // 经 JSON 往返（真实存读档会序列化）+ 重新挂载同一装配
    const restored = loadSim(JSON.parse(JSON.stringify(snapshotOf(s))), ModRegistry.mountPacks(SOLO));

    expect(factionIds(restored)).toEqual(factionIds(s)); // 派系名单一致
    expect(factionIds(restored).map((id) => factionNameOf(restored, id))).toEqual(namesBefore); // 名字随档
    expect(restored.scratch[FACTION_KEYS.rep(A, B)]).toBe(55);
    expect(restored.scratch[FACTION_KEYS.rep(B, A)]).toBe(-18);
    expect(restored.scratch[FACTION_KEYS.gossip(A)]).toBe(0.42);
    expect(restored.scratch[FACTION_KEYS.raidCd(A, B)]).toBe(999);
    expect(restored.scratch[FACTION_KEYS.seq]).toBe(2);
    // 读档后不再重复登记（init 跳过 + name 键已存在）
    restored.step(1);
    expect(restored.scratch[FACTION_KEYS.seq]).toBe(2);
    expect(factionIds(restored)).toHaveLength(2);
  });

  it('声望漂移：默认开启时声望必须真的会动（改动前是永久冻结，掠夺数学上不可能）', () => {
    const s = twoFactionSim(5);
    const [A, B] = factionIds(s);
    const k = FACTION_KEYS.rep(A, B);
    const start = s.scratch[k] ?? 0;
    // 跑 30 拍（600s）：期间至少应触发一次 driftReputation
    for (let i = 0; i < 30; i++) s.step(1);
    const after = s.scratch[k] ?? 0;
    // ⚠ 核心断言：改动前 rep 只升不降（trade +4 / raid -12），而 raid 要求 rep<-25
    //    才能发生——所以 rep 恒 ≥ repInit(35)，掠夺永远不可能。这里断言"声望真的
    //    离开了 35"，就是在断言那个死锁被打断了。
    expect(after).not.toBe(start);

    // 关掉漂移 → 回到冻结语义：声望恒等于 repInit（trade 会涨，但纯跑不动就不会有）
    const reg2 = ModRegistry.mountPacks(SOLO);
    reg2.overrideTuning((t) => {
      t.bootstrap.pawnCount = 0;
      t.factions.repMeanRev = 0;
      t.factions.repDriftMag = 0;
    });
    const s2 = new Sim({ seed: 5, registry: reg2 });
    s2.stockpile[K_STOCK_WOOD] = 500;
    const spot2 = freeSpot(s2, 0, 0);
    expect(s2.addBuilding('campfire', spot2.x, spot2.y)).not.toBeNull();
    s2.step(1);
    const [A2, B2] = factionIds(s2);
    const k2 = FACTION_KEYS.rep(A2, B2);
    for (let i = 0; i < 30; i++) s2.step(1);
    expect(s2.scratch[k2] ?? 0).toBe(35); // 严格冻结
  });

  it('声望漂移：足以触达敌对区并真的刷出掠夺（改动前数学上不可能）', () => {
    // 直接断言「掠夺发生过」——这是「背叛与战争」半系统存在性的判据。
    // 改动前 rep 只升不降、恒 ≥ 35，掠夺门槛 -25 永远到不了，该断言必然失败。
    //
    // ⚠ Round 56：本断言原先硬编码**单 seed 75**，而「这个 seed 有掠夺」是轨迹运气，
    //   不是机制保证——任何无关改动都会让那个 seed 的漂移走向不同分支。
    //   实测证据（bedRatio 闸 A/B，14 seed×6000 tick）：改前 4/14 seed 出掠夺
    //   （75:11、2026:20、8080:19、5555:2），改后仍是 4/14（42:1、99:6、2026:6、1234:6）
    //   ⇒ 机制活着，只是命中了不同 seed。故本断言改为**多 seed 比率**：
    //   「N 个 seed 里至少 M 个出掠夺」才是机制的真正判据，且不被单条轨迹绑架。
    const SEEDS = [75, 42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080, 1234, 5555, 60606];
    let seedsWithRaid = 0;
    let raids = 0;
    let minRep = 1e9;
    for (const seed of SEEDS) {
      const s = new Sim({ seed, registry: ModRegistry.default() });
      for (let t = 0; t < 6000; t++) {
        s.step(1);
        for (const key of Object.keys(s.scratch)) {
          if (!key.startsWith('factions.rep.')) continue;
          const v = s.scratch[key];
          if (v < minRep) minRep = v;
        }
      }
      const n = s.events.filter((e) => /袭击了.+的营地/.test(e.text)).length;
      raids += n;
      if (n > 0) seedsWithRaid++;
    }
    expect(minRep).not.toBe(1e9); // 至少有派系对存在（否则漂移无从谈起）
    expect(minRep).toBeLessThan(-25); // 穿到敌对线以下
    expect(
      seedsWithRaid,
      `${raids} 次掠夺落在 ${seedsWithRaid}/${SEEDS.length} 个 seed 上（minRep=${minRep.toFixed(1)}）`,
    ).toBeGreaterThanOrEqual(2); // 多个 seed 各自都能撞出掠夺 ⇒ 机制成立而非轨迹巧合
  });
});
