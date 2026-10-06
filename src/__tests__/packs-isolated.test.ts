/**
 * packs-isolated.test.ts —— 各玩法包脱离完整装配的独立验证（原则④：
 * 系统只依赖 SimContext，最小注入即可跑）。
 *
 * 注：卡 action 由内核 behavior 执行——所以强制抽卡测试必须保留 behavior；
 * 只有"纯时钟/纯衰减"类断言才卸载它（见 cards.test.ts 衰减用例）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { K_STOCK_FOOD, K_STOCK_WOOD } from '../mods/contracts';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';

describe('玩法包独立测试（最小装配）', () => {
  it('needs：需求按 tuning 速率衰减；吃卡消耗库存并恢复；睡卡在火旁更快', () => {
    const s = new Sim({ seed: 5, registry: ModRegistry.mountPacks([needsPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.needs.food = 100;
    s.step(10); // 库存空 → eat 不可抽；rest 尚高 → sleep 不可抽：纯衰减
    expect(p.needs.food).toBeCloseTo(100 - 10 * s.tuning.needs.foodDecay, 5);

    // 吃：库存 -1、食欲 +eatFoodGain（debugForceCard 与真实抽卡共用 commit 路径）
    p.needs.food = 20;
    s.stockpile[K_STOCK_FOOD] = 3;
    s.debugForceCard(p.eid, 'eat');
    s.step(1);
    expect(s.stockpile[K_STOCK_FOOD]).toBe(2);
    // 当步同时发生衰减（needs 系统先于 behavior 执行）
    expect(p.needs.food).toBeCloseTo(20 + s.tuning.needs.eatFoodGain - s.tuning.needs.foodDecay, 5);

    // 睡：火旁恢复速率 > 野外打盹（needs-only 装配无建筑定义 → 注入最小定义）
    s.tuning.buildings['campfire'] = { name: '篝火', cost: {}, hp: 80, tags: ['fire'], passable: true };
    s.addBuilding('campfire', 0, 0);
    p.pos = { x: 0.5, y: 0 };
    p.needs.rest = 30;
    s.debugForceCard(p.eid, 'sleep');
    s.step(5);
    const nearFireRest = p.needs.rest;
    const s2 = new Sim({ seed: 5, registry: ModRegistry.mountPacks([needsPack]), pawnCount: 1 });
    const p2 = [...s2.pawns()][0];
    p2.needs.rest = 30; // 无火可依 → sleepRestWild
    s2.debugForceCard(p2.eid, 'sleep');
    s2.step(5);
    expect(nearFireRest).toBeGreaterThan(p2.needs.rest);
  });

  /**
   * 睡卡磁铁半径的**真场景**回归：火在磁铁圈内、鼠在圈外远处时，必须走过去躺下，
   * 而不是就地打盹。
   *
   * 【为什么上面那条 needs 用例挡不住这个缺陷】它把鼠摆到 `(0.5, 0)`——**贴脸在火边**
   * （`p.pos = { x: 0.5, y: 0 }` 与火在 `(0,0)`），于是"火旁睡得更快"恒成立。
   * 而真实局里鼠到最近火堆的距离**中位数 12.1 格**（全局 ≤8 格只有 23.6%），
   * 原实现写死 8 格找火、找不到就 `sleepRestWild` 且**永不尝试去找**：
   * 睡眠卡执行的 573 个 tick 里火在 8 格内只有 **14.5%**、贴到火边的只有 **12.7%**
   * ⇒ 85.5% 的睡眠是野外打盹，`sleepRestNearFire`/`sleepSanNearFire`/棚屋回心情
   * 事实上常年享受不到。**手工摆位的测试对这个缺陷完全免疫**（这与 chat 当年
   * 被"两只鼠摆到距离 1"的测试放过是同一类缺陷）。
   *
   * 【本条钉住的性质】"火在磁铁半径内 ⇒ 鼠会走过去并在火边睡"。用**放远处**而不是
   * 放贴脸，正是为了让"走过去"这一段真的被执行到。
   */
  it('needs 睡卡：火在磁铁半径内但鼠在远处时，会**走过去**在火边睡（火=安全感的锚点）', () => {
    const s = new Sim({ seed: 5, registry: ModRegistry.mountPacks([needsPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    s.tuning.buildings['campfire'] = { name: '篝火', cost: {}, hp: 80, tags: ['fire'], passable: true };
    s.addBuilding('campfire', 0, 0);
    // 放一处：距火 magnetRadius 以内、但**远大于旧硬编码的 8 格**（= 24 格），
    // 且落在磁铁圈内（≤24）——旧实现在这里必然搜不到火 → 只能野外打盹。
    p.pos = { x: 14, y: 0 };
    expect(Math.hypot(14, 0)).toBeLessThanOrEqual(s.tuning.needs.sleepMagnetRadius);
    expect(Math.hypot(14, 0)).toBeGreaterThan(8); // 旧硬编码半径够不着
    p.path = [];
    p.needs.rest = 30;
    s.debugForceCard(p.eid, 'sleep');
    // 走到火边约 3s（14 格 / 4.5 格每秒）；**在卡期到期内**取样，
    // 否则 sleep 的 duration(10s) 到点会重抽 wander 把鼠带走（那正是"睡醒了"，
    // 不是缺陷 —— 断言必须落在 sleep 还承诺着的窗口内）。
    s.run(6);
    const fire = s.nearestBuildingByTag('fire', p.pos.x, p.pos.y)!;
    expect(
      Math.hypot(p.pos.x - fire.pos.x, p.pos.y - fire.pos.y),
      '睡卡没有把鼠带到火边——磁铁半径拿到了火却没走过去',
    ).toBeLessThanOrEqual(2.5);
    // 到位后吃的是火边高档数值：前 3s 在路上只吃 sleepRestWild，
    // 后 3s 在火边吃 sleepRestNearFire ⇒ 总量必须**超过**"全程野外打盹"的 6s 下界
    expect(p.needs.rest).toBeGreaterThan(30 + 6 * s.tuning.needs.sleepRestWild);
    // 火边确实给了更高档的恢复速率（数据表本身没被改坏）
    expect(s.tuning.needs.sleepRestNearFire).toBeGreaterThan(s.tuning.needs.sleepRestWild);
  });

  it('gathering：采浆果入库食物并触发再生冷却', () => {
    const s = new Sim({ seed: 8, registry: ModRegistry.mountPacks([gatheringPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const f = s.nearestFeature('berry', 0, 0, 40);
    expect(f).not.toBeNull();
    p.pos = { x: f!.x, y: f!.y }; // 精确锚点：nearest 必然返回同一丛 // 放到浆果丛旁
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    for (let i = 0; i < 8; i++) {
      s.debugForceCard(p.eid, 'gather_berry'); // 每拍都钉在采集上（排除自然重抽换卡）
      s.step(1); // 每份一 tick，3~5 份足够采空
    }
    expect(s.stockpile[K_STOCK_FOOD]).toBeGreaterThan(food0);
    expect(s.featureAt(f!.x, f!.y)).toBeNull(); // 采空 → 冷却中查不到
  });

  it('building：木料不足不建；充足时自主建成（成本门=抽卡谓词）', () => {
    const s = new Sim({ seed: 3, registry: ModRegistry.mountPacks([buildingPack]), pawnCount: 1 });
    const cost = s.tuning.buildings.campfire.cost[K_STOCK_WOOD];
    s.stockpile[K_STOCK_WOOD] = cost - 1;
    s.run(50); // 木料不足：build 卡条件不过，永远抽不中
    expect([...s.world.buildings.values()].some((b) => b.defId === 'campfire' || b.defId === 'hut')).toBe(false);

    s.stockpile[K_STOCK_WOOD] += 40; // 富余 → 权重钩子 ×2，自然兴土木
    s.run(150);
    expect([...s.world.buildings.values()].some((b) => b.defId === 'campfire' || b.defId === 'hut')).toBe(true);
  });

  it('social：相邻互聊加心情加关系；口角是低心情×概率的局面事件；无邻不可聊', () => {
    const s = new Sim({ seed: 21, registry: ModRegistry.mountPacks([socialPack]), pawnCount: 2 });
    const [a, b] = [...s.pawns()];
    a.pos = { x: 0, y: 0 };
    b.pos = { x: 1, y: 0 };
    a.needs.mood = 80; // 心情好 → 必无口角
    s.debugForceCard(a.eid, 'chat');
    s.step(1);
    // 宽松断言：b 也可能自发回聊（双方各 +8/+4），所以只验方向不验精确值
    expect(a.needs.mood).toBeGreaterThan(80);
    expect(b.needs.mood).toBeGreaterThan(70 - s.tuning.needs.moodDecay);
    expect(s.relation(a.eid, b.eid)).toBeGreaterThanOrEqual(s.tuning.social.chatRelGain);

    // 口角统计性存在：低心情对反复闲聊，固定 seed 下必出负面事件（确定性抽样）
    const s2 = new Sim({ seed: 4, registry: ModRegistry.mountPacks([socialPack]), pawnCount: 2 });
    const [c, d] = [...s2.pawns()];
    c.needs.mood = 10;
    d.needs.mood = 10;
    c.pos = { x: 0, y: 0 };
    d.pos = { x: 0, y: 1 };
    let quarrels = 0;
    for (let i = 0; i < 200; i++) {
      c.needs.mood = 10; // 按回低点：保证口角谓词（心情<30）每轮都成立
      d.needs.mood = 10;
      s2.debugForceCard(c.eid, 'chat');
      const before = s2.events.length;
      s2.step(1);
      quarrels += s2.events.slice(before).filter((e) => e.text.includes('吵了一架')).length;
    }
    expect(quarrels).toBeGreaterThan(0);

    // 无邻可聊：condition 不过 → 长跑零闲聊
    const s3 = new Sim({ seed: 21, registry: ModRegistry.mountPacks([socialPack]), pawnCount: 2 });
    const [e2, f2] = [...s3.pawns()];
    e2.pos = { x: 0, y: 0 };
    f2.pos = { x: 50, y: 50 };
    s3.run(60);
    expect((e2.uses['chat'] ?? 0) + (f2.uses['chat'] ?? 0)).toBe(0);
  });
});

describe('寻路联动回归（review 补）', () => {
  it('gathering：寻路失败的目标进入单槽避让——期内强抽也零产出，过期恢复', () => {
    const s = new Sim({ seed: 8, registry: ModRegistry.mountPacks([gatheringPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const f = s.nearestFeature('berry', 0, 0, 40)!;
    // 贴身站位排除行走变量，纯验避让语义
    p.pos = { x: f!.x, y: f!.y }; // 精确锚点：nearest 必然返回同一丛
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    // 避让生效：条件过滤 + 工作体双重拦截 → 强制抽卡也无产出
    p.avoidFeat = { x: f!.x, y: f!.y, until: s.time + 50 };
    s.debugForceCard(p.eid, 'gather_berry');
    s.step(1);
    expect(s.stockpile[K_STOCK_FOOD] ?? 0).toBe(food0);
    // 过期恢复：同一丛重新可采
    p.avoidFeat = undefined;
    s.debugForceCard(p.eid, 'gather_berry');
    s.step(1);
    expect(s.stockpile[K_STOCK_FOOD] ?? 0).toBeGreaterThan(food0);
  });

  it('wander：闲逛落点必须可通行（不再盲选水上呆立）', () => {
    const s = new Sim({ seed: 12, registry: ModRegistry.mountPacks([needsPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    for (let i = 0; i < 120; i++) {
      // 路径若在帧内可见就校验全可通行（A* 保证）；观察窗口用卡触发计数代替
      // 瞬时 path 长度——一步一格在 4.5 格/秒的移速下当拍就走完了
      if (p.path.length > 0) {
        for (const step of p.path) expect(s.passable(step.x, step.y)).toBe(true);
      }
      s.step(1);
    }
    expect((p.uses['wander'] ?? 0)).toBeGreaterThan(5); // 确实多次抽中闲逛并成功规划
  });
});
