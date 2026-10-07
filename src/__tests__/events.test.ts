/**
 * events.test.ts —— events 事件包验收（"事件 = 谓词 + 效果表，无脚本线"）。
 *
 * 覆盖验收清单：
 *  1. 丰收：库存 food 低 + 浆果丛存在 → 触发后 food 增加；
 *  2. 寒潮：无火堆 → 触发后 env.tempMod 被写入（契约：events 写修饰量，env 合成最终值）；
 *  3. 瘟疫：6 只鼠 → 全体 hp 下降；
 *  4. 流浪者：food 充足 + 有棚屋 → 鼠数 +1；
 *  5. 丰收节：food > 80 → food 再 +15；
 *  6. 冷却去重：同一事件在冷却期内不重复触发（触发次数 ≤ 1）；
 *  7. 卸载 events 后世界照跑且无事件触发；
 *  8. 卸载 events 但挂 env：无 tempShift 发生（env.temp 与 env.tempMod 都不变）；
 *  9. 存读档：冷却计时随档，读档续跑不立刻重触发；
 *  10. EventSeedDef 向后兼容：只有 { log } 的 seed 注册并触发不报错。
 *
 * 测试风格：最小装配 + 手动架设局面 + run() 步进（照 tech-pool.test.ts 范式）。
 * 调参：checkSec=1 / cooldownSec=3 加速测试（overrideTuning）。
 * 卸载 behavior 系统防鼠自主行为干扰局面（disableSystem('behavior')）。
 */
import { describe, expect, it } from 'vitest';
import { Sim, snapshotOf, loadSim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import type { EventSeedDef } from '../mods/registry';
import { K_STOCK_FOOD, K_STOCK_WOOD } from '../mods/contracts';
import { eventsPack } from '../mods/packs/events';
import { buildingPack } from '../mods/packs/building';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';
import { techPoolPack } from '../mods/packs/tech-pool';
import { farmingPack } from '../mods/packs/farming';
import { cookingPack } from '../mods/packs/cooking';

// ---- 测试调参常量（加速检查节奏与冷却）----
const CHECK_SEC = 1;
const COOLDOWN_SEC = 3;

/** 事件 log 特征文本（用于断言事件是否触发） */
const EVT_TEXTS = {
  harvest: '丰收之年',
  coldsnap: '寒潮来袭',
  plague: '瘟疫',
  stranger: '流浪者加入',
  festival: '丰收节',
  fecund: '丰饶雨季',
} as const;

/** 创建测试用 Sim：events 包 + 可调场景参数 */
function eventSim(opts: {
  seed: number;
  pawnCount: number;
  withBuilding?: boolean;
  food?: number;
  wood?: number;
  coldsnapMinPawns?: number;
  envTemp?: number;
  addCampfire?: boolean;
  addHut?: boolean;
  harvestFoodBelow?: number;
  plagueMinPawns?: number;
  strangerFoodAbove?: number;
  festivalFoodAbove?: number;
}): Sim {
  const packs: ModPack[] = opts.withBuilding ? [buildingPack, eventsPack] : [eventsPack];
  const reg = ModRegistry.mountPacks(packs);
  // 卸载 behavior 系统：防止鼠自主抽卡行为干扰局面（测试要精确控制局面）
  reg.disableSystem('behavior');
  reg.overrideTuning((t) => {
    t.events.checkSec = CHECK_SEC;
    t.events.cooldownSec = COOLDOWN_SEC;
    if (opts.coldsnapMinPawns !== undefined) t.events.thresholds.coldsnapMinPawns = opts.coldsnapMinPawns;
    if (opts.harvestFoodBelow !== undefined) t.events.thresholds.harvestFoodBelow = opts.harvestFoodBelow;
    if (opts.plagueMinPawns !== undefined) t.events.thresholds.plagueMinPawns = opts.plagueMinPawns;
    if (opts.strangerFoodAbove !== undefined) t.events.thresholds.strangerFoodAbove = opts.strangerFoodAbove;
    if (opts.festivalFoodAbove !== undefined) t.events.thresholds.festivalFoodAbove = opts.festivalFoodAbove;
  });
  const s = new Sim({ seed: opts.seed, registry: reg, pawnCount: opts.pawnCount });
  if (opts.food !== undefined) s.stockpile[K_STOCK_FOOD] = opts.food;
  if (opts.wood !== undefined) s.stockpile[K_STOCK_WOOD] = opts.wood;
  if (opts.envTemp !== undefined) s.scratch['env.temp'] = opts.envTemp;
  if (opts.addCampfire && opts.withBuilding) s.addBuilding('campfire', 0, 0);
  if (opts.addHut && opts.withBuilding) s.addBuilding('hut', 5, 5);
  return s;
}

/** 找到原点 60 格内有浆果丛的 seed（berryRate=0.03 × 3600 格，几乎所有 seed 都有） */
function findSeedWithBerry(): number {
  for (let seed = 1; seed <= 20; seed++) {
    const reg = ModRegistry.mountPacks([eventsPack]);
    reg.disableSystem('behavior');
    const s = new Sim({ seed, registry: reg, pawnCount: 0 });
    if (s.nearestFeature('berry', 0, 0, 60)) return seed;
  }
  return 1; // fallback
}

/** 统计某事件 log 的出现次数 */
function countEvents(s: Sim, text: string): number {
  return s.events.filter((e) => e.text.includes(text)).length;
}

describe('events 事件包 —— 局面触发', () => {
  it('丰收 harvest-blessing：food 低 + 浆果丛 → 触发后 food 增加', () => {
    const seed = findSeedWithBerry();
    const s = eventSim({
      seed,
      pawnCount: 2,
      withBuilding: true,
      food: 5,
      wood: 100,
      addCampfire: true, // 避免 coldsnap（有火 + pawns < 6）
      coldsnapMinPawns: 999, // 双保险
    });
    // 前提验证：浆果丛存在
    expect(s.nearestFeature('berry', 0, 0, 60)).not.toBeNull();
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    expect(food0).toBeLessThan(s.tuning.events.thresholds.harvestFoodBelow);
    s.run(3);
    expect(s.stockpile[K_STOCK_FOOD]).toBeGreaterThan(food0);
    expect(countEvents(s, EVT_TEXTS.harvest)).toBeGreaterThan(0);
  });

  it('寒潮 coldsnap：无火堆 → env.tempMod 被写入（跨包契约：events 写修饰量，env 合成最终值）', () => {
    const s = eventSim({
      seed: 7,
      pawnCount: 2,
      food: 35, // ≥30 避免 harvest
      envTemp: 20, // 模拟 env 包在场（events 用它做能力探测）
      coldsnapMinPawns: 999, // 防 plague 联动（虽然 pawns<6 已挡，但双保险）
    });
    expect(s.scratch['env.temp']).toBe(20);
    s.run(3);
    // ⚠ 契约断言（2026-10-07）：events **只写 env.tempMod**，不碰 env.temp。
    // 直接断言 env.temp 降到 8 是旧行为——那会让 env 的昼夜循环每 tick 覆写掉
    // coldsnap 的 -12，使寒潮变成静默 no-op。现在断言两件事：
    // ① tempMod === -12（本包确实写了修饰量）；② env.temp 未被本包改动（契约边界）。
    expect(s.scratch['env.tempMod']).toBeCloseTo(-12, 0);
    expect(s.scratch['env.temp']).toBe(20); // 本包不改最终温度
    expect(countEvents(s, EVT_TEXTS.coldsnap)).toBeGreaterThan(0);
  });

  it('寒潮余波过期：到期后 env.tempMod 回退（durationSec 反向效果）', () => {
    // ⚠ 测试夹具两个坑（都踩过）：
    // ① coldsnap 的谓词是「无火堆 或 鼠数≥阈值」。若不中断触发条件，它会按
    //    cooldownSec 反复触发、每次叠加 -12，而每次都在登记自己的到期时刻——
    //    于是"最后一个寒潮还没过期"，tempMod 永远不会归零。必须在触发后补火堆掐断。
    // ② 篝火会**烧柴**（building.ts fuelSec=12，断薪按 id 序熄灭）。若 stockpile.wood
    //    为 0，补上的火堆约 15 tick 后自燃成灰，谓词又变真——所以必须给足木头。
    //    第一次写这个测试时就是漏了 ②，现象是「加了火堆还在触发」，查了半天才发现。
    const s = eventSim({
      seed: 7,
      pawnCount: 2,
      withBuilding: true, // 需要 buildingPack 才能 addBuilding（也会带来 fuel 系统）
      food: 35,
      wood: 100000, // 足够烧完整个测试期，火堆不会自燃
      envTemp: 20,
      coldsnapMinPawns: 999, // 只靠"无火堆"这一条分支触发
    });
    s.run(3); // 触发 coldsnap
    expect(s.scratch['env.tempMod']).toBeCloseTo(-12, 0);
    // 掐断触发条件：有火堆 + 鼠数 2 < coldsnapMinPawns(999) ⇒ 谓词恒假
    s.addBuilding('campfire', 0, 0);
    // 最后一次触发 ≤ 第 3 tick，其到期时刻 ≤ 63 ⇒ 跑到 70 tick 后修饰量应归零
    s.run(70);
    expect(s.scratch['env.tempMod']).toBeCloseTo(0, 0);
  });

  it('寒潮不级联：冷却期 > 持续期时，两次寒潮之间存在恢复窗口（锁定 cooldownSec > durationSec 不变量）', () => {
    // ⚠ 锁定一个真实事故（2026-10-07）：coldsnap 的 durationSec=60 而
    // cooldownSec 曾等于 60，两者严格相等 ⇒ 到期回退与新触发落在同一 check
    // 窗口内，env.tempMod 永远被压住、**回退窗口归零**，35.8% 的 tick 处于
    // 冻死温度（84% 的死因变成冻伤）。
    //
    // ⚠ 关键：这条测试的谓词**恒真**（无火堆 ⇒ coldsnap.when 直接 return true），
    // 所以寒潮会持续触发。这正好是上面那条「余波过期」测试刻意规避的场景——
    // 它加篝火掐断了条件，所以从未覆盖过「条件恒真 + 冷却=持续」的级联路径。
    // 断言恢复窗口存在（不是「不触发」——那样是冷却本身失效）。
    const reg = ModRegistry.mountPacks([eventsPack]);
    reg.disableSystem('behavior'); // 卸载自主行为，精确控制局面
    reg.overrideTuning((t) => {
      t.events.checkSec = 1; // 每 tick 检查，让时序可预测
      // 注意：cooldownSec 用出厂默认 120（> coldsnap.durationSec=60），
      // 不覆盖——这条测试要验证的就是出厂值的不变量。
    });
    const s = new Sim({ seed: 1, registry: reg, pawnCount: 6 });
    s.scratch['env.temp'] = 20; // 模拟 env 包在场（events 用它做能力探测）

    // 第一场寒潮
    s.run(1);
    expect(s.scratch['env.tempMod']).toBeCloseTo(-12, 0);

    // 到期回退（durationSec=60）后进入恢复窗口：修饰量回零，且新寒潮未被冷却触发
    s.run(65); // 跑到 t=65
    expect(
      s.scratch['env.tempMod'],
      '冷却期(120) > 持续期(60)，到期后应有 60s 恢复窗口，tempMod 应回零',
    ).toBeCloseTo(0, 0);

    // 冷却期耗尽后，第二场寒潮应该触发（不是不触发——是"有间隔地"触发）
    s.run(60); // 跑到 t=125（冷却 120 已在 t=121 耗尽）
    expect(
      s.scratch['env.tempMod'],
      '冷却期(120)耗尽后应触发第二场寒潮',
    ).toBeCloseTo(-12, 0);
  });

  it('瘟疫 plague：6 只鼠 → 全体 hp 下降', () => {
    const s = eventSim({
      seed: 11,
      pawnCount: 6,
      withBuilding: true,
      food: 35, // ≥30 避免 harvest
      wood: 100,
      addCampfire: true, // 有火避免 coldsnap
      coldsnapMinPawns: 999, // 双保险
    });
    const pawns = [...s.pawns()];
    expect(pawns.length).toBe(6);
    const hp0 = new Map(pawns.map((p) => [p.eid, p.hp]));
    s.run(3);
    // 瘟疫 hpDelta=-10 → 全体鼠 hp 应下降（damagePawn 单点出口）
    for (const p of s.pawns()) {
      const before = hp0.get(p.eid);
      if (before !== undefined) expect(p.hp).toBeLessThan(before);
    }
    expect(countEvents(s, EVT_TEXTS.plague)).toBeGreaterThan(0);
  });

  it('流浪者 stranger：food 充足 + 有棚屋 → 鼠数 +1', () => {
    const s = eventSim({
      seed: 13,
      pawnCount: 2,
      withBuilding: true,
      food: 50, // >40 触发 stranger，<80 避免 festival
      wood: 100,
      addCampfire: true, // 有火避免 coldsnap
      addHut: true, // 有棚屋
      coldsnapMinPawns: 999,
    });
    const pawns0 = [...s.pawns()].length;
    s.run(3);
    expect([...s.pawns()].length).toBe(pawns0 + 1);
    expect(countEvents(s, EVT_TEXTS.stranger)).toBeGreaterThan(0);
  });

  it('丰收节 festival：food > 80 → food 再 +15', () => {
    const s = eventSim({
      seed: 17,
      pawnCount: 2,
      withBuilding: true,
      food: 90, // >80 触发 festival，>40 但无棚屋所以 stranger 不触发
      wood: 100,
      addCampfire: true, // 有火避免 coldsnap
      coldsnapMinPawns: 999,
    });
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    s.run(3);
    // festival stock: { food: +15 }
    expect(s.stockpile[K_STOCK_FOOD]).toBe(food0 + 15);
    expect(countEvents(s, EVT_TEXTS.festival)).toBeGreaterThan(0);
  });

  it('丰饶雨季 fecund-season：雨天 + food > 阈值 → stockMul 倍增库存（stockMul 首个消费者）', () => {
    const s = eventSim({
      seed: 23,
      pawnCount: 2,
      withBuilding: true,
      food: 60, // >50 触发 fecund，且不会触发 harvest/festival
      wood: 100,
      addCampfire: true, // 有火避免 coldsnap
      coldsnapMinPawns: 999,
      harvestFoodBelow: 0,
      strangerFoodAbove: 999,
      festivalFoodAbove: 999,
    });
    // 模拟 env 包在场且正在下雨
    s.scratch['env.rain'] = 1;
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    expect(food0).toBe(60);
    s.run(3);
    // fecund-season stockMul: { food: 1.3 } → 60 × 1.3 = 78
    expect(s.stockpile[K_STOCK_FOOD]).toBeCloseTo(78, 1);
    expect(countEvents(s, EVT_TEXTS.fecund)).toBeGreaterThan(0);
  });

  it('丰饶雨季不触发：env 未挂载（env.rain 不存在）→ 静默跳过', () => {
    const s = eventSim({
      seed: 23,
      pawnCount: 2,
      withBuilding: true,
      food: 60, // 满足 fecund 的 food 条件，但不触发 harvest/festival/stranger
      wood: 100,
      addCampfire: true,
      coldsnapMinPawns: 999,
      harvestFoodBelow: 0,
      strangerFoodAbove: 999,
      festivalFoodAbove: 999,
    });
    // 不设置 env.rain（env 包未挂载时的行为）
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    s.run(3);
    // 无事件触发 → food 不变
    expect(s.stockpile[K_STOCK_FOOD]).toBe(food0);
    expect(countEvents(s, EVT_TEXTS.fecund)).toBe(0);
  });

  it('丰饶雨季不触发：food ≤ 阈值 → 静默跳过', () => {
    const s = eventSim({
      seed: 23,
      pawnCount: 2,
      withBuilding: true,
      food: 50, // ≤50 不触发 fecund，且不会触发 harvest/festival/stranger
      wood: 100,
      addCampfire: true,
      coldsnapMinPawns: 999,
      harvestFoodBelow: 0,
      strangerFoodAbove: 999,
      festivalFoodAbove: 999,
    });
    s.scratch['env.rain'] = 1; // 下雨但粮食不足
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    s.run(3);
    expect(s.stockpile[K_STOCK_FOOD]).toBe(food0);
    expect(countEvents(s, EVT_TEXTS.fecund)).toBe(0);
  });

  it('冷却去重：同一事件在冷却期内不重复触发（≤1 次）', () => {
    const s = eventSim({
      seed: 19,
      pawnCount: 2,
      withBuilding: true,
      food: 90, // 持续满足 festival 谓词
      wood: 100,
      addCampfire: true,
      coldsnapMinPawns: 999,
    });
    // 跑 cooldownSec 秒：在冷却期内只触发 1 次
    s.run(COOLDOWN_SEC);
    const inCooldown = countEvents(s, EVT_TEXTS.festival);
    expect(inCooldown).toBeLessThanOrEqual(1);
    // 再跑 checkSec 秒（超过冷却期）：应再次触发
    s.run(CHECK_SEC);
    const afterCooldown = countEvents(s, EVT_TEXTS.festival);
    expect(afterCooldown).toBeGreaterThan(inCooldown);
  });
});

describe('卸载不破坏核心（原则④）', () => {
  /** 默认装配减 events 的包列表（模拟"卸载 events 包"） */
  const WITHOUT_EVENTS: ModPack[] = [
    needsPack,
    gatheringPack,
    buildingPack,
    socialPack,
    raidPack,
    bootstrapPack,
    techPoolPack,
    farmingPack,
    cookingPack,
  ];

  it('卸载 events 后世界照跑且无事件触发（无 eventSeeds、无事件 log）', () => {
    const reg = ModRegistry.mountPacks(WITHOUT_EVENTS);
    // eventSeeds 为空（events 包未挂载）
    expect(reg.eventSeeds).toHaveLength(0);
    const s = new Sim({ seed: 42, registry: reg });
    expect(() => s.run(200)).not.toThrow();
    // 世界照跑：有鼠、有火
    expect([...s.pawns()].length).toBeGreaterThan(0);
    expect([...s.world.buildings.values()].some((b) => b.defId === 'campfire')).toBe(true);
    // 无事件 log（所有事件特征文本都不出现）
    for (const text of Object.values(EVT_TEXTS)) {
      expect(s.events.some((e) => e.text.includes(text))).toBe(false);
    }
  });

  it('卸载 events 但挂 env：无 tempShift 发生（env.temp 与 env.tempMod 都不变）', () => {
    // 只挂 buildingPack（无 events 包），预设 env.temp 模拟 env 包
    const reg = ModRegistry.mountPacks([buildingPack]);
    const s = new Sim({ seed: 1, registry: reg, pawnCount: 2 });
    s.scratch['env.temp'] = 20;
    // 无 events 系统 → 无谓词检查 → 无 tempShift
    expect(() => s.run(50)).not.toThrow();
    expect(s.scratch['env.temp']).toBe(20);
    // 卸载纪律：events 未挂载时连 env.tempMod 都不应被凭空写入
    expect(s.scratch['env.tempMod']).toBeUndefined();
  });

  it('卸载 events 后 eventSeeds 为空且世界照跑（无事件系统）', () => {
    const reg = ModRegistry.mountPacks(WITHOUT_EVENTS);
    expect(reg.eventSeeds).toHaveLength(0);
    const s = new Sim({ seed: 42, registry: reg });
    // 无 events 系统
    expect(s.systems.some((x) => x.id === 'events')).toBe(false);
    // 世界照跑
    expect(() => s.run(100)).not.toThrow();
    expect([...s.pawns()].length).toBeGreaterThan(0);
  });
});

describe('存读档', () => {
  it('冷却计时随档：读档续跑不立刻重触发', () => {
    const reg = ModRegistry.mountPacks([buildingPack, eventsPack]);
    reg.disableSystem('behavior');
    reg.overrideTuning((t) => {
      t.events.checkSec = CHECK_SEC;
      t.events.cooldownSec = COOLDOWN_SEC;
      t.events.thresholds.coldsnapMinPawns = 999;
    });
    const s = new Sim({ seed: 23, registry: reg, pawnCount: 2 });
    s.stockpile[K_STOCK_FOOD] = 90;
    s.stockpile[K_STOCK_WOOD] = 100;
    s.addBuilding('campfire', 0, 0);
    // 跑 1 秒触发 festival
    s.run(CHECK_SEC);
    expect(countEvents(s, EVT_TEXTS.festival)).toBe(1);
    // 快照（含 scratch 冷却计时）
    const snapshot = snapshotOf(s);
    const restored = loadSim(JSON.parse(JSON.stringify(snapshot)), reg);
    // 读档后继续跑（仍在冷却期内）
    restored.run(COOLDOWN_SEC - 1);
    // 不应再触发（冷却随档）
    expect(countEvents(restored, EVT_TEXTS.festival)).toBe(1);
  });
});

describe('向后兼容', () => {
  it('EventSeedDef 向后兼容：只有 { log } 的 seed 注册并触发不报错', () => {
    // 创建兼容测试包：注册一个只有 { log } 的 seed（旧形状）
    const compatPack: ModPack = {
      id: 'compat-test',
      requires: [],
      apply(m) {
        const mySeeds: EventSeedDef[] = [
          {
            id: 'compat-event',
            name: '兼容测试',
            when: () => true,
            effects: { log: '🧪 向后兼容测试事件' }, // 只有 log，无其他效果字段
          },
        ];
        m.registerEvent(mySeeds[0]);
        // 注册系统（与 events 包同款模式：闭包捕获自己的 seeds）
        m.registerSystemDef({
          id: 'compat-test',
          category: 'world',
          ctor: (ctx) => ({
            id: 'compat-test',
            update() {
              for (const seed of mySeeds) {
                if (!seed.when(ctx)) continue;
                const e = seed.effects;
                ctx.log(e.log);
                if (e.stock) for (const [k, v] of Object.entries(e.stock)) ctx.stockpile[k] = (ctx.stockpile[k] ?? 0) + v;
                if (e.stockMul) for (const [k, m2] of Object.entries(e.stockMul)) ctx.stockpile[k] = (ctx.stockpile[k] ?? 0) * m2;
                if (e.hpDelta !== undefined) for (const p of [...ctx.pawns()]) { if (e.hpDelta < 0) ctx.damagePawn(p.eid, -e.hpDelta, seed.name); else p.hp = Math.min(p.maxHp, p.hp + e.hpDelta); }
                if (e.spawnPawn) for (let i = 0; i < e.spawnPawn; i++) ctx.spawnPawn();
                if (e.tempShift !== undefined && ctx.scratch['env.temp'] !== undefined) ctx.scratch['env.temp'] += e.tempShift;
              }
            },
          }),
        });
      },
    };
    const reg = ModRegistry.mountPacks([compatPack]);
    const s = new Sim({ seed: 1, registry: reg, pawnCount: 1 });
    expect(() => s.run(5)).not.toThrow();
    expect(s.events.some((e) => e.text.includes('向后兼容测试事件'))).toBe(true);
  });
});
