/**
 * farming.test.ts —— R3-2 农耕包验收。
 *
 * 覆盖验收清单（ROADMAP R3-2 原文）：
 *  1. 完整耕收闭环：开垦 → 播种 → 冷却 → 收割 → 入 food（统计测试，自然抽卡跑出来）；
 *  2. 卸载 farming 包后**农田留存但不产出**，核心照跑（原则④卸载不破坏核心）；
 *  3. 生长确实由世界时钟驱动（不靠人在场推进），冷却语义与 world.harvestCd 同构；
 *  4. 涌现点方向：饿 → farm 系列权重上抬（权重钩子可单测，不需要跑长模拟）；
 *  5. 存读档：作物状态随档，读档后同一块田仍在原冷却进度上。
 *
 * 测试风格：最小 ctx（单包挂载 + debugForceCard 钉住卡），照 packs-isolated.test.ts 范式；
 *  强制抽卡走内核 commit 路径（Sim.debugForceCard），保证统计/熟练度语义不漂移。
 */
import { describe, expect, it } from 'vitest';
import { Sim, loadSim, snapshotOf } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { K_STOCK_FOOD, K_STOCK_WOOD, SER_FARM } from '../mods/contracts';
import { farmingPack } from '../mods/packs/farming';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';

/** 最小装配： farming 依赖 building，其余玩法包挂上以提供真实的卡池与鼠群生态。 */
const WITH_FARMING: ModPack[] = [
  needsPack,
  gatheringPack,
  buildingPack,
  socialPack,
  raidPack,
  bootstrapPack,
  farmingPack,
];

/** 同款装配但**摘掉** farming：对照"卸载不破坏核心"。 */
const WITHOUT_FARMING: ModPack[] = [needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack];

/** 收集全部农田建筑 */
function fieldsOf(s: Sim) {
  return [...s.world.buildings.values()].filter((b) => b.defId === 'field');
}

describe('R3-2 农耕包', () => {
  it('数据种子：农田是 1×1 可通行建筑，数值全在 tuning 表上（零魔法数）', () => {
    const s = new Sim({ seed: 1, registry: ModRegistry.mountPacks(WITH_FARMING) });
    const def = s.tuning.buildings['field'];
    expect(def).toBeDefined();
    expect(def.passable).toBe(true); // 可通行：人要能站进自家田里
    expect(def.w ?? 1).toBe(1); // 1×1
    expect(def.h ?? 1).toBe(1);
    expect(def.cost[K_STOCK_WOOD]).toBeGreaterThan(0); // 造价走木料
    // 核心语义：卡片注册进同一个卡池、引用已登记系列（契约校验在挂载期已跑过）
    expect(s.cards().some((c) => c.id === 'build_field')).toBe(true);
    expect(s.cards().some((c) => c.id === 'sow_field')).toBe(true);
    expect(s.cards().some((c) => c.id === 'harvest_field')).toBe(true);
    expect(s.cards().find((c) => c.id === 'sow_field')?.series).toBe(SER_FARM);
  });

  it('完整耕收闭环：开垦→播种→冷却→收割→入 food（单块田逐步走通）', () => {
    // 卡 action 只在 behavior.update 里执行（systems.ts），所以**不能**关 behavior——
    // 关了连播种都不会发生。正确姿势是：让 behavior 跑（保证 action 执行），
    // 但等冷却期间把鼠挪到远超 senseRadius 的角落——它的 harvest_field condition
    // 找不到田 → 抽不中 → 不会自己把田收了，我们断言的"田还熟着"那一瞬间才存在。
    const reg = ModRegistry.mountPacks([buildingPack, farmingPack]);
    const s = new Sim({ seed: 2, registry: reg, pawnCount: 1 });
    const p = [...s.pawns()][0];
    // 造一块田（不用 build_field 卡，直接 addBuilding 架设测试夹具——闭环本身在后面验）
    const spot = s.addBuilding('field', 0, 0);
    expect(spot).not.toBeNull();
    p.pos = { x: 0, y: 0 }; // 站进田心（田可通行）

    // ① 播种：钉住 sow_field 卡，走到田边即种（sow 是"到田即种"的一次性工序）
    s.debugForceCard(p.eid, 'sow_field');
    s.step(1);
    // 作物状态写进 scratch（键 farming.<建筑id>），未成熟前不可收
    const stateKey = `farming.${spot!.id}`;
    expect(s.scratch[stateKey]).toBeDefined();
    expect(s.scratch[stateKey]).toBeLessThan(0); // 负值编码：-value = 成熟时刻

    // ② 收割卡此刻**不可抽**（没成熟）：条件谓词挡住了（condition 是抽卡谓词，非行为规则）
    const harvestCard = s.cardById('harvest_field')!;
    expect(harvestCard.condition!(p, s)).toBe(false);

    // ③ 等冷却过：把鼠放逐到 senseRadius 之外再跑满 growSec —— 它够不着田，
    //    所以不会自己收走；这一步只验"冷却到期"，不掺寻路
    const far = s.tuning.farming.senseRadius + 20;
    p.pos = { x: far, y: far };
    p.path = [];
    s.run(s.tuning.farming.growSec + 1);
    p.pos = { x: 0, y: 0 }; // 收工前回到田边
    p.path = [];
    expect(harvestCard.condition!(p, s)).toBe(true); // 到点即可收

    // ④ 收割：入 food + 田回空地（可再种）
    const food0 = s.stockpile[K_STOCK_FOOD] ?? 0;
    s.debugForceCard(p.eid, 'harvest_field');
    s.step(1);
    expect(s.stockpile[K_STOCK_FOOD]).toBe(food0 + s.tuning.farming.yieldFood);
    expect(s.scratch[stateKey]).toBeUndefined(); // 收走后作物状态清空
  });

  it('生长是地块冷却：不需要人在场，世界时钟自己把田催熟', () => {
    // 极简装配：只挂 building + farming，且 0 鼠——本例只回答"世界时钟会不会催熟田"，
    // 不掺任何小人的行为（掺进来就分不清是时钟催熟还是鼠去收的）。
    const s = new Sim({ seed: 3, registry: ModRegistry.mountPacks([buildingPack, farmingPack]), pawnCount: 0 });
    const b = s.addBuilding('field', 0, 0)!;
    // 负值编码：-v = 成熟时刻。取 now+1 = 下一秒就熟（不真等满 growSec，本例只验"时钟会催熟"）
    s.scratch[`farming.${b.id}`] = -(s.time + 1);
    expect([...s.pawns()].length).toBe(0); // 无鼠
    s.run(3);
    expect([...s.pawns()].length).toBe(0);
    // 成熟播报事件发生了（farming-growth 系统报"田里的庄稼熟了"）
    expect(s.events.some((e) => e.text.includes('庄稼熟了'))).toBe(true);
  });

  it('涌现点方向：饿把 farm 系列权重抬起来（权重钩子方向性单测）', () => {
    const s = new Sim({ seed: 4, registry: ModRegistry.mountPacks(WITH_FARMING), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const card = s.cardById('harvest_field')!;
    p.needs.food = 10; // 很饿
    const wHungry = s.weightHooks().reduce((w, h) => w * h(p, { series: card.series, id: card.id }, s), 1);
    p.needs.food = 95; // 饱
    const wFull = s.weightHooks().reduce((w, h) => w * h(p, { series: card.series, id: card.id }, s), 1);
    // 饿时 farm 系列权重更高 → 更可能抽到种地卡（而不是任何 if-else 强制）
    expect(wHungry).toBeGreaterThan(wFull);
    // 非 farm 系列不受这条钩子影响（钩子只认 SER_FARM）
    p.needs.food = 10;
    const wOther = s.weightHooks().reduce((w, h) => w * h(p, { series: 'wander', id: 'wander' }, s), 1);
    expect(wOther).toBe(1);
  });

  it('完整耕收闭环统计：默认装配下鼠群自主开垦并产出食物（自然抽卡，非强抽）', () => {
    // 不挂 raid：敌袭会随机打死鼠，鼠数掉下来 → 田数比例门跟着掉 → 闭环是否跑通变得
    // 依赖战斗胜负，与"农耕闭环本身能不能自转"无关。去掉这层噪声后，本例只回答一个问题：
    // 在真实卡池竞争下（开垦 vs 采集 vs 建火 vs 盖棚），田**能不能**被自然抽出来并收成。
    //
    // 统计口径不能只看最终的 events（maxLog=200，1800s 跑下来开垦/收割的记录早被裁掉了）。
    // 改成**边跑边数**：每 20s 扫一次当窗事件流累计命中数——这正是 tech-pool.test.ts
    // 踩过的坑（注释已写在那里：不可逆事件用集合差分/累计计数，不用末尾快照）。
    const reg = ModRegistry.mountPacks([needsPack, gatheringPack, buildingPack, bootstrapPack, farmingPack]);
    const s = new Sim({ seed: 42, registry: reg });
    s.stockpile[K_STOCK_WOOD] = 300; // 备足木料，让 build_field 的成本门不是瓶颈
    let till = 0;
    let reap = 0;
    let foodPeak = 0;
    let seen = 0; // 已扫过的事件条数（游标，避免重复计数被保留窗口里的旧事件）
    while (s.time < 1800) {
      s.step(20);
      const ev = s.events;
      // 事件被裁剪时游标要跟着回退：窗口左移了多少就从新的左端继续扫
      if (seen > ev.length) seen = 0;
      for (let i = seen; i < ev.length; i++) {
        if (ev[i].text.includes('开垦')) till++;
        if (ev[i].text.includes('收获农田')) reap++;
      }
      seen = ev.length;
      foodPeak = Math.max(foodPeak, s.stockpile[K_STOCK_FOOD] ?? 0);
    }
    // 自然抽卡把"开垦 → 播种 → 等冷却 → 收割"整条链跑通了（累计计数，不被裁剪影响）
    expect(till).toBeGreaterThan(0);
    expect(reap).toBeGreaterThan(0);
    // 田是留存实体：世界里确实有田（涌现不该被数量钉死，只断言 >0）
    expect(fieldsOf(s).length).toBeGreaterThan(0);
    // 耕收真的把食物搬进了仓库（不只是开了田没收成）
    expect(foodPeak).toBeGreaterThan(0);
  });

  it('存读档：作物状态随档，读档后田仍在原冷却进度上', () => {
    const s = new Sim({ seed: 5, registry: ModRegistry.mountPacks(WITH_FARMING), pawnCount: 0 });
    const b = s.addBuilding('field', 0, 0)!;
    s.scratch[`farming.${b.id}`] = -(s.time + s.tuning.farming.growSec);
    const key = `farming.${b.id}`;
    const before = s.scratch[key];
    const restored = loadSim(JSON.parse(JSON.stringify(snapshotOf(s))), ModRegistry.mountPacks(WITH_FARMING));
    // 田随档（建筑实体）
    expect(restored.world.buildings.has(b.id)).toBe(true);
    // 作物状态随档（scratch 原样）
    expect(restored.scratch[key]).toBe(before);
  });
});

describe('卸载不破坏核心（原则④）', () => {
  it('卸载 farming：农田留存但不产出，核心照跑', () => {
    // 先用带 farming 的装配跑出田，再**换装配**（不含 farming）读同一份存档——
    // 模拟"开局有田、后来卸载了农耕包"的热卸载场景。
    const s1 = new Sim({ seed: 42, registry: ModRegistry.mountPacks(WITH_FARMING), pawnCount: 0 });
    s1.addBuilding('field', 0, 0);
    const saved = JSON.parse(JSON.stringify(snapshotOf(s1)));

    // ② 卸载 farming 读同一份档：田必须还在
    const s2 = loadSim(saved, ModRegistry.mountPacks(WITHOUT_FARMING));
    expect(fieldsOf(s2).length).toBe(1); // 农田留存
    // 没有 farming 的系统与卡
    expect(s2.systems.some((x) => x.id === 'farming-growth')).toBe(false);
    expect(s2.cards().some((c) => c.id === 'sow_field' || c.id === 'harvest_field')).toBe(false);
    // 核心照跑：长跑不炸
    expect(() => s2.run(300)).not.toThrow();
  });

  it('卸载 farming：长跑零产出——田在、状态在，但没人读（不产出也不报错）', () => {
    // 极简装配 + 0 鼠：把"世界时钟催熟"与"小人去收割"彻底分开。
    // 先在带 farming 的装配下种好田并跑一拍，让成熟播报系统走过一次。
    const s = new Sim({ seed: 6, registry: ModRegistry.mountPacks([buildingPack, farmingPack]), pawnCount: 0 });
    const b = s.addBuilding('field', 0, 0)!;
    const key = `farming.${b.id}`;
    // 负值编码：-v = 成熟时刻。v = now+1 = 下一秒就熟（不真等满 growSec，
    // 本例只验「卸载后有没有人读这个状态」，不关心生长本身要多久）
    s.scratch[key] = -(s.time + 1);
    expect(s.events.some((e) => e.text.includes('庄稼熟了'))).toBe(false); // 还没跑 tick
    s.step(1);
    expect(s.events.some((e) => e.text.includes('庄稼熟了'))).toBe(true); // 报过了

    // 卸载组：同一份档换不含 farming 的装配 → 长跑
    const saved = JSON.parse(JSON.stringify(snapshotOf(s)));
    const s2 = loadSim(saved, ModRegistry.mountPacks([buildingPack])); // 无 farming
    const food0 = s2.stockpile[K_STOCK_FOOD] ?? 0;
    const events0 = s2.events.length;
    s2.run(400); // 远超 growSec

    // ① 田留存、作物状态留存（无人清理——但也无人读）
    expect(fieldsOf(s2).length).toBe(1);
    expect(s2.scratch[key]).toBe(saved.scratch[key]);
    // ② 不产出：无 gathering 食物不会凭空涨，无收割卡也没有人收
    expect(s2.stockpile[K_STOCK_FOOD] ?? 0).toBe(food0);
    // ③ 零播报：存档里那 1 条是读档带过来的，运行 400s 一条新的都没有
    expect(s2.events.length).toBe(events0);
    // ④ 无农耕卡、无农耕系统
    expect(s2.cards().some((c) => c.series === SER_FARM)).toBe(false);
    expect(s2.systems.some((x) => x.id === 'farming-growth')).toBe(false);
  });
});
