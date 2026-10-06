/**
 * cooking.test.ts —— R3-4 篝火烹饪包验收。
 *
 * 覆盖 ROADMAP R3-4 的验收清单 + 本项目对该包的特有风险：
 *  1. **验收项**：熟食净收益 > 生食（收支平衡），且差异来自真实机制而非魔法数；
 *  2. **磁铁范式**（本项目已踩坑 4 次的根因）：远处的火只要在磁铁半径内，
 *     cook 卡必须**能抽中**（condition 通过），且 action 必须**真的走过去**才开烤；
 *  3. **契约**：新资源键 K_STOCK_MEAL / 新系列 SER_COOK 已在 contracts 登记（装配期校验）；
 *  4. **卸载不破坏核心**（原则④）：卸掉 cooking 包后 eat 退回纯生食、世界照跑；
 *  5. **存读档**：烤制进度（scratch "cooking.<火堆id>"）随档，读档后能接着烤完；
 *  6. **产能不过剩**：熟食不能大量烂在仓库（R3-4 的"净收益"要真的吃到嘴里）。
 *
 * 测试风格：机制断言走**最小装配 + debugForceCard**（照 farming.test.ts 范式），
 * 平衡断言走**多 seed 自然局**（照 card-liveness 范式）。
 * ⚠ 纪律提醒（来自 card-liveness.test.ts 文件头）：
 *   **任何 debugForceCard + 手动摆坐标的测试都在验证假想世界**——所以第 6 条
 *   必须用自然局统计来兜底，不能只靠前几条"摆好位置再 force"的用例。
 */
import { describe, expect, it } from 'vitest';
import { Sim, loadSim, snapshotOf } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { K_STOCK_FOOD, K_STOCK_MEAL, K_TAG_FIRE, SER_COOK } from '../mods/contracts';
import { cookingPack } from '../mods/packs/cooking';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { bootstrapPack } from '../mods/packs/bootstrap';
import { farmingPack } from '../mods/packs/farming';

const WITH_COOKING: ModPack[] = [
  needsPack,
  gatheringPack,
  buildingPack,
  bootstrapPack,
  farmingPack,
  cookingPack,
];
/** 同款装配但摘掉 cooking：对照"卸载不破坏核心"。 */
const WITHOUT_COOKING: ModPack[] = [needsPack, gatheringPack, buildingPack, bootstrapPack, farmingPack];

/**
 * 单鼠最小装配：**不挂 bootstrapPack**。
 *
 * 【为什么不能挂 bootstrap】bootstrap 的 init 会按 `tuning.bootstrap.pawnCount`(4) 出生鼠群，
 *   于是 `new Sim({pawnCount:1})` 实际得到 **5 只鼠**。step(1) 期间别的鼠也会抽卡、也会吃饭，
 *   于是"这只鼠吃了 1 份"这种断言会被**别人的消费**污染（实测：food 5→4 而非 5→5）。
 *   这不是实现的 bug，是夹具（test fixture）不够干净。
 * 凡是"一只鼠做了什么"的确定性断言（吃了几份、烤了几份），都必须用这个最小装配。
 */
const SOLO: ModPack[] = [needsPack, buildingPack, cookingPack];

function reg(packs: ModPack[]): ModRegistry {
  return ModRegistry.mountPacks(packs);
}

describe('R3-4 篝火烹饪包', () => {
  // ---------------------------------------------------------------- 验收项
  it('验收：熟食净收益 > 生食净收益（ROADMAP R3-4 原文验收）', () => {
    const s = new Sim({ seed: 1, registry: reg(WITH_COOKING) });
    const raw = s.tuning.needs.eatFoodGain;
    const cooked = s.tuning.cooking.eatCookedFoodGain;
    // 净收益口径 = 吃一份拿到的饱食点 / 消耗的一份食物（两者 cookYield=1，耗 1 产 1）
    const rawNet = raw / s.tuning.cooking.cookRawCost;
    const cookedNet = cooked / s.tuning.cooking.cookRawCost;
    expect(cookedNet, `熟食净收益 ${cookedNet} 未超过生食 ${rawNet}`).toBeGreaterThan(rawNet);
    // 差异必须"够抵消走一趟火边的成本"：实测磁铁 10 格 ≈ speed 4.5 下的 2 秒路程，
    // 加上 cookSec 6 秒烤制 ⇒ 若优势 < 10%，鼠宁可直接啃生食（那 R3-4 就没意义）。
    // 取 >15% 是实测选点：55/40 = 1.375× ⇒ 优势 37.5%，同时吃两份熟食(110)即满，
    // 不会把饱食上限(100)撑爆成"一口顶三顿"。
    expect(cookedNet / rawNet, '熟食优势过小，抵消不了烤制的工夫').toBeGreaterThan(1.15);
    // 熟食不能强到吃一份就满（否则又变成"另一个生食"的同义词）
    expect(cooked, '熟食一份就吃饱 ⇒ 高收益变成了数量而非质量').toBeLessThan(100);
  });

  it('eat 优先吃熟食：同等花一次吃的工夫，熟食给更多饱食（确定性归因）', () => {
    const s = new Sim({ seed: 3, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.needs.food = 10;
    s.stockpile[K_STOCK_FOOD] = 5;
    s.stockpile[K_STOCK_MEAL] = 5;
    s.debugForceCard(p.eid, 'eat');
    s.step(1);
    // 吃掉了熟食（不是生食），生食一动不动
    expect(s.stockpile[K_STOCK_MEAL]).toBe(4);
    expect(s.stockpile[K_STOCK_FOOD]).toBe(5); // 生食没动
    // 饱食：断言"相对基线的增量"而不是绝对值——`step(1)` 里 needs 系统还会扣
    // foodDecay(0.15)，直接比绝对值会把衰减算进去（实测 65 vs 64.85）。
    // 这里用容差把那一拍的自然衰减扣掉，只留"吃这一口带来的净增"。
    const netGain = p.needs.food - 10 + s.tuning.needs.foodDecay;
    expect(netGain, '吃熟食拿到的饱食不是熟食那份').toBeCloseTo(s.tuning.cooking.eatCookedFoodGain, 5);
  });

  it('熟食吃完后 eat 回落到生食（不留"吃不到饭"的洞）', () => {
    const s = new Sim({ seed: 3, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    // 从 0 饱食起步：55 + 40 = 95 < 100 才装得下两口。若从 10 起步，两口合计
    // 105 会被 needs 的**饱食上限**截到 100（实测读到 90.3 也含衰减），
    // 那是正确的游戏行为，会把"吃了几份"这个断言污染成"看起来少吃了"。
    p.needs.food = 0;
    s.stockpile[K_STOCK_FOOD] = 3;
    s.stockpile[K_STOCK_MEAL] = 1;
    s.debugForceCard(p.eid, 'eat');
    s.step(1); // 第一次吃熟食
    expect(s.stockpile[K_STOCK_MEAL]).toBe(0);
    p.busyUntil = 0;
    s.debugForceCard(p.eid, 'eat');
    s.step(1); // 第二次只能吃生食
    expect(s.stockpile[K_STOCK_FOOD]).toBe(2);
    // 两口合计：熟食那份 + 生食那份。
    // ⚠ 衰减只扣**一拍**，不是两拍：实测（/tmp 探针）第一拍从饱食 0 起步时，
    //   decay 把 0 往下扣会被 0 下限截住 = 那一拍实际没扣；第二拍才扣满一次
    //   （50 → 49.85，delta 恰为 foodDecay）。所以这里补 **1** 次，不是 2。
    const netGain = p.needs.food + s.tuning.needs.foodDecay;
    expect(netGain).toBeCloseTo(s.tuning.cooking.eatCookedFoodGain + s.tuning.needs.eatFoodGain, 5);
  });

  it('磁铁：**超出**磁铁半径的火不算（condition 不放水 ⇒ 不是"哪里有火都想去"）', () => {
    const s = new Sim({ seed: 5, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    s.addBuilding('campfire', 0, 0)!;
    s.stockpile[K_STOCK_FOOD] = 10;
    // 摆在磁铁圈之外
    p.pos = { x: Math.round(s.tuning.cooking.magnetRadius + 3), y: 0 };
    p.path = [];
    const cond = s.cardById('cook')!.condition!;
    expect(cond(p, s), '火在磁铁圈外却仍能抽 cook（condition 没做半径检查）').toBe(false);
  });

  // ---------------------------------------------------------------- 磁铁范式
  it('磁铁：鼠还远时抽到 cook，会**先走过去**再开烤（不得凭空在原地出锅）', () => {
    // ⚠ 这条是"倒推"补上的：做反向验证时把 action 里的距离闸 `if (false)` 掉，
    //   11 条测试**全部照样绿** —— 说明前面的用例只验了 condition（抽不抽得到），
    //   根本没验 action 的"走过去"。而"看得见却原地出锅"正是本项目已踩 4 次的
    //   同一个坑（chat/sow_field/harvest_field/sleep），所以必须显式钉住。
    const s = new Sim({ seed: 5, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const fire = s.addBuilding('campfire', 0, 0)!;
    s.stockpile[K_STOCK_FOOD] = 10;
    s.stockpile[K_STOCK_MEAL] = 0;
    const magnet = s.tuning.cooking.magnetRadius;
    const work = s.tuning.cooking.workRadius;
    // 摆在"看得见、但还没到位"的距离
    p.pos = { x: Math.round((magnet + work) / 2), y: 0 };
    p.path = [];
    expect(Math.hypot(p.pos.x - fire.pos.x, p.pos.y - fire.pos.y)).toBeGreaterThan(work);
    const startX = p.pos.x;
    s.debugForceCard(p.eid, 'cook');
    s.step(1);
    // ① 这一拍绝不能出锅（还没走到火边）
    expect(s.stockpile[K_STOCK_MEAL], '还没走到火边就出锅了 = 磁铁形同虚设').toBe(0);
    // ② 但它必须**已经在往火走**（position/or path 有变化）
    const moved = Math.abs(p.pos.x - startX) > 1e-9 || p.path.length > 0;
    expect(moved, '抽到 cook 后既没动也没规划路径 = 原地空转').toBe(true);
    // ③ 走够时间后必须真的出锅（证明磁铁最终可达，不是死循环）
    let producedAt = -1;
    for (let i = 0; i < 60 && producedAt < 0; i++) {
      s.step(1);
      if ((s.stockpile[K_STOCK_MEAL] ?? 0) > 0) producedAt = s.stockpile[K_STOCK_MEAL]!;
    }
    expect(producedAt, '走完路也没烤出来（磁铁路径不可达 / 到了却没开烤）').toBeGreaterThan(0);
  });

  it('磁铁：火在磁铁半径内（哪怕鼠还远）时 cook 卡抽得到 —— 远火 ≠ 死代码', () => {
    const s = new Sim({ seed: 5, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const fire = s.addBuilding('campfire', 0, 0)!;
    s.stockpile[K_STOCK_FOOD] = 10;
    const magnet = s.tuning.cooking.magnetRadius;
    const work = s.tuning.cooking.workRadius;
    // 把鼠放到"看得见火但还没到位"的距离：正好是两者之间
    p.pos = { x: Math.round((magnet + work) / 2), y: 0 };
    p.path = [];
    const d = Math.hypot(p.pos.x - fire.pos.x, p.pos.y - fire.pos.y);
    expect(d).toBeGreaterThan(work); // 确实还没到火边
    expect(d).toBeLessThan(magnet); // 确实在磁铁圈内
    const cond = s.cardById('cook')!.condition!;
    expect(cond(p, s), '火在磁铁圈内却抽不到 cook（磁铁半径被当成了贴身距离 = 死代码）').toBe(true);
  });

  it('磁铁：走到火边才开烤 —— raw 不足 / 熟食堆够时不产出', () => {
    const s = new Sim({ seed: 6, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const fire = s.addBuilding('campfire', 0, 0)!;
    p.pos = { x: fire.pos.x, y: fire.pos.y }; // 已在火边
    p.path = [];
    p.needs.food = 50;

    // ① 没原料 → 烤不出东西
    s.stockpile[K_STOCK_FOOD] = 0;
    s.stockpile[K_STOCK_MEAL] = 0;
    const cond = s.cardById('cook')!.condition!;
    expect(cond(p, s), '没有原料时 cook 卡仍可抽（纯空转）').toBe(false);

    // ② 有原料但熟食已堆到上限 → 不再开烤（这是实测出来的霸池防线，见 tuning.cooking）
    s.stockpile[K_STOCK_FOOD] = 20;
    s.stockpile[K_STOCK_MEAL] = s.tuning.cooking.cookRawMaxStock;
    expect(cond(p, s), '熟食已堆到上限却仍开烤（会无限生产烂在仓库）').toBe(false);

    // ③ 条件齐 → 能抽；烤满 cookSec 后产出恰好 cookYield 份
    s.stockpile[K_STOCK_MEAL] = 0;
    expect(cond(p, s)).toBe(true);
    s.debugForceCard(p.eid, 'cook');
    // 只跑到**刚好出锅**那一拍就停（实测 t=7 出锅、t=8 这只鼠就把它自己烤的熟食吃了、
    // t=9 又起了第二锅）。多跑几拍，"库里恰好有 1 份"的断言会被
    // **这只鼠自己吃掉 + 再开一锅**污染 ⇒ 那些是正确的游戏行为，不是缺陷。
    // 这里改成逐拍观察"出锅那一刻"的库存。
    let producedAt = -1;
    for (let i = 0; i < s.tuning.cooking.cookSec + 5 && producedAt < 0; i++) {
      s.step(1);
      const m = s.stockpile[K_STOCK_MEAL] ?? 0;
      if (m > 0) producedAt = m;
    }
    expect(producedAt, '走到火边烤满 cookSec 后没有出锅').toBe(s.tuning.cooking.cookYield);
    // 原料按 cookRawCost 扣（生产要先投入）
    expect(s.stockpile[K_STOCK_FOOD]).toBe(20 - s.tuning.cooking.cookRawCost);
  });

  it('产出闸在 action 里也守着：抽到卡后熟食被他人堆满 → 这一锅放弃（不再白扣原料）', () => {
    // ⚠ 上一条只验了 condition（wantCook 的闸）。action 里还有**第二道**闸
    //   （防止"condition 通过之后、走到火边之前"熟食被别人堆满）。
    //   反向验证时把那道闸去掉，12 条测试全绿 ⇒ 覆盖漏洞，这里补上。
    const s = new Sim({ seed: 6, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const fire = s.addBuilding('campfire', 0, 0)!;
    p.pos = { x: fire.pos.x, y: fire.pos.y };
    p.path = [];
    s.stockpile[K_STOCK_FOOD] = 10;
    s.stockpile[K_STOCK_MEAL] = 0;
    const cond = s.cardById('cook')!.condition!;
    expect(cond(p, s), '起点就不该通过（熟食还是空的）').toBe(true);
    s.debugForceCard(p.eid, 'cook');
    // 起锅那一拍就会扣掉 1 份原料
    s.step(1);
    expect(s.stockpile[K_STOCK_FOOD]).toBe(10 - s.tuning.cooking.cookRawCost);
    const afterPot = s.stockpile[K_STOCK_FOOD];
    // 烤制途中"别人"把熟食堆到上限 → 到点必须放弃这一锅。
    // ⚠ 这只鼠饱食被 setPath 走路时消耗后会**自己吃熟食**（实测 40→39），
    //   所以不能断言"库存恒等于上限"。真正要钉住的是**闸门生效**这件事本身：
    //   放弃 ⇒ (a) 半锅进度被清掉，(b) 熟食**没有**再被加一份（库存 ≤ 上限）。
    s.stockpile[K_STOCK_MEAL] = s.tuning.cooking.cookRawMaxStock;
    const max = s.tuning.cooking.cookRawMaxStock;
    const key = 'cooking.' + p.eid + '.' + fire.id;
    // 逐拍观察，**停在"半锅进度被清掉"那一刻**就断言（再多跑几拍，这只鼠会
    // 因为饱食下降去吃熟食、库存降到上限以下，然后又合法地起新一锅 —— 那是
    // 正确行为，不是缺陷；只有"清进度"那一刻才是不变式被破坏的瞬间）。
    const baseTime = s.time;
    let clearedAt = -1;
    for (let i = 0; i < s.tuning.cooking.cookSec + 4 && clearedAt < 0; i++) {
      s.step(1);
      if (s.scratch[key] === undefined) clearedAt = s.time;
    }
    expect(clearedAt, '熟食堆满后仍留着半锅进度（下一锅会跳过烤制时长直接出锅）').toBeGreaterThan(0);
    // ⚠ 判别点是**时机**：产出闸在的那一版，鼠一重新抽到 cook 就立刻发现"堆满了"
    //   而放弃（实测 t=2 清进度）；闸被去掉的那一版会一路把这锅烤完才清（实测 t=8）。
    //   所以断言"放弃必须发生在**一重新抽到 cook 的那一拍**"——只跑了两拍就清完。
    //   （终态两种实现都是 meal=40、food=9，因为 t=7 这只鼠自己会吃一口 40→39、
    //     把库存重新压到上限以下，于是"完成"也没突破上限 ⇒ 只有时机能区分。）
    expect(clearedAt - baseTime, '产出闸没立刻拦住：这一锅被烤完了才停（等于没有闸）').toBeLessThanOrEqual(2);
    // (b) 熟食不能超过上限（产出闸真的挡住了）
    expect(s.stockpile[K_STOCK_MEAL], `熟食突破了上限 ${max}（产出闸失效）`).toBeLessThanOrEqual(max);
    // (c) 原料不再被继续扣（放弃后不该再投入）
    expect(s.stockpile[K_STOCK_FOOD], '放弃这一锅后还在继续扣原料').toBeGreaterThanOrEqual(afterPot);
  });

  it('烤制占满真实卡期（cookSec），不是"到火边就秒出一份"（否则会霸占卡池）', () => {
    const s = new Sim({ seed: 6, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    const fire = s.addBuilding('campfire', 0, 0)!;
    p.pos = { x: fire.pos.x, y: fire.pos.y };
    p.path = [];
    s.stockpile[K_STOCK_FOOD] = 5;
    s.stockpile[K_STOCK_MEAL] = 0;
    s.debugForceCard(p.eid, 'cook');
    s.step(1); // 起锅那一拍
    // 还没到 cookSec：绝不能已经出锅（这正是第一版"霸池 30.7%"的形态）
    expect(s.stockpile[K_STOCK_MEAL], '烤制还没到时间就出锅了 = 秒完成（会霸池）').toBe(0);
    s.run(s.tuning.cooking.cookSec); // 烤满
    expect(s.stockpile[K_STOCK_MEAL]).toBe(1); // 这时才出锅
  });

  // ---------------------------------------------------------------- 契约
  it('契约：SER_COOK 与 K_STOCK_MEAL 已登记（否则装配期 validateContracts 直接抛）', () => {
    const s = new Sim({ seed: 1, registry: reg(WITH_COOKING) });
    const card = s.cardById('cook')!;
    expect(card).toBeDefined();
    expect(card.series).toBe(SER_COOK);
    // 全部系列的卡都在登记词表里（契约校验在 mountPacks 时已跑过，这里再确认一次存在性）
    expect(SER_COOK).toBe('cook');
    expect(K_STOCK_MEAL).toBe('meal');
    expect(K_STOCK_MEAL).not.toBe(K_STOCK_FOOD); // 熟食是并列的第二种食物，不是 food
  });

  // ---------------------------------------------------------------- 卸载纪律
  it('卸载 cooking 包：eat 退回纯生食、世界照跑（原则④）', () => {
    const s = new Sim({ seed: 8, registry: reg([needsPack, buildingPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    expect(s.cardById('cook'), '卸载后仍有 cook 卡').toBeUndefined();
    // 存量熟食保留（它是库存事实，不是行为），但没人再生产
    s.stockpile[K_STOCK_MEAL] = 3;
    s.stockpile[K_STOCK_FOOD] = 5;
    p.needs.food = 10;
    s.debugForceCard(p.eid, 'eat');
    s.step(1);
    // eat 仍然优先吃熟食（它是并列食物，卸载的是"生产"不是"消费"）
    expect(s.stockpile[K_STOCK_MEAL]).toBe(2);
    // 核心照跑：跑满一段长局不出错、鼠还活着
    s.run(300);
    expect([...s.pawns()].length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- 存读档
  it('烤制进度随档：中途存档读档后，这一锅能接着烤完（scratch 存档纪律）', () => {
    const a = new Sim({ seed: 9, registry: reg(SOLO), pawnCount: 1 });
    const p = [...a.pawns()][0];
    const fire = a.addBuilding('campfire', 0, 0)!;
    p.pos = { x: fire.pos.x, y: fire.pos.y };
    p.path = [];
    a.stockpile[K_STOCK_FOOD] = 5;
    a.debugForceCard(p.eid, 'cook');
    a.step(1); // 起锅，scratch 里应已记下起锅时刻
    expect(a.scratch['cooking.' + p.eid + '.' + fire.id]).toBeDefined();
    // 存档 → 读档 → 继续跑到烤满
    const resumed = loadSim(JSON.parse(JSON.stringify(snapshotOf(a))), reg(SOLO));
    const key = 'cooking.' + p.eid + '.' + fire.id;
    expect(resumed.scratch[key], '烤制进度没随档（scratch 纪律被破）').toBe(a.scratch[key]);
    const startedAt = resumed.scratch[key]!;
    // 只跑到"刚好出锅"那一拍就停：再多跑几拍，这只鼠会**把自己烤出来的熟食吃掉**
    //（实测 t=8 meal 1→0），那是正确的游戏行为，但会让"库里有 1 份"这种
    // 终态断言误报为"没烤出来"。所以断言的是"这一锅在读档后真的烤完了"，
    // 用出锅那一刻的库存，而不是跑完一长段之后的库存。
    // 逐拍走到"出锅那一刻"为止（多跑会被这只鼠吃掉、或让它起第二锅，见 magnet 测试注释）
    let producedAt = -1;
    let clearedAt = -1;
    for (let i = 0; i < a.tuning.cooking.cookSec + 6 && clearedAt < 0; i++) {
      resumed.step(1);
      if (producedAt < 0 && (resumed.stockpile[K_STOCK_MEAL] ?? 0) > 0) {
        producedAt = resumed.stockpile[K_STOCK_MEAL]!;
      }
      if (resumed.scratch[key] === undefined) clearedAt = resumed.time;
    }
    expect(producedAt, '读档后这一锅烤不完（起锅时刻没随档续上）').toBe(a.tuning.cooking.cookYield);
    expect(clearedAt, '出锅后进度键没被清掉（下一锅会白嫖一次"已烤满"的判定）').toBeGreaterThan(0);
    // 出锅时刻必须**基于读档前的起锅时刻**累加，而不是重新计时：
    // 真正要防的"重复扣原料"就发生在这里（第一版键不带 eid 时的症状）。
    expect(clearedAt - startedAt, '出锅时刻离起锅时刻太近 = 进度被重置重新计时').toBeGreaterThanOrEqual(a.tuning.cooking.cookSec);
    // 原料最多被扣两锅（起锅一次 + 出锅后又起了一锅），绝不能因读档被无限扣
    expect(5 - (resumed.stockpile[K_STOCK_FOOD] ?? 5)).toBeLessThanOrEqual(a.tuning.cooking.cookRawCost * 2);
  });

  // ---------------------------------------------------------------- 自然局统计
  it('自然局：熟食真的在流通（产出≈消耗，不是造出来烂在仓库）', () => {
    // ⚠ 这一条**故意不做 debugForceCard/摆坐标**：card-liveness.test.ts 的文件头说过，
    //   "任何 debugForceCard + 手动摆坐标的测试都在验证假想世界"。
    //   R3-4 的核心风险（熟食大量积压）只有在自然局里才暴露得出来。
    const SEEDS = [42, 7, 2026, 8888];
    let produced = 0;
    let eaten = 0;
    let peak = 0;
    for (const seed of SEEDS) {
      const s = new Sim({ seed, registry: ModRegistry.default() });
      let last = s.stockpile[K_STOCK_MEAL] ?? 0;
      for (let t = 0; t < 900; t++) {
        s.step(1);
        const now = s.stockpile[K_STOCK_MEAL] ?? 0;
        if (now > last) produced += now - last;
        if (now < last) eaten += last - now;
        last = now;
        peak = Math.max(peak, now);
      }
    }
    expect(produced, '900s × 4 seed 一份熟食都没烤出来（cook 是死卡）').toBeGreaterThan(0);
    // 消耗/产出 ≥ 0.5：熟食至少一半真的被吃掉。过低说明造出来在烂。
    // （第一版实测 519/3090 = 0.17，正是这条要抓的形态）
    expect(eaten / produced, `熟食消耗率 ${(eaten / produced).toFixed(2)} 过低：造出来在仓库里烂`).toBeGreaterThanOrEqual(0.5);
    // 峰值不失控：不该堆成一座山（cookRawMaxStock 是产出侧闸门）
    expect(peak, `熟食峰值 ${peak} 远超 cookRawMaxStock=${20}`).toBeLessThanOrEqual(40);
  });

  it('自然局：cook 卡在 10 seed 自然局里被抽中（不是"能 force 但没人抽"的死卡）', () => {
    const SEEDS = [42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080];
    const uses = new Map<string, number>();
    for (const seed of SEEDS) {
      const s = new Sim({ seed, registry: ModRegistry.default() });
      for (let t = 0; t < 900; t++) s.step(1);
      for (const p of s.pawns()) {
        for (const [k, v] of Object.entries(p.uses)) uses.set(k, (uses.get(k) ?? 0) + v);
      }
    }
    expect(uses.get('cook') ?? 0, 'cook 卡在 10 seed 自然局里从未被抽中（死卡）').toBeGreaterThan(0);
  });
});