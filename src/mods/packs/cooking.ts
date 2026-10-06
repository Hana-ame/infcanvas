/**
 * cooking 包 —— 篝火烹饪种子（ROADMAP R3-4）：「烹烤」卡 + 熟食这种更划算的食物。
 *
 * 一切皆抽卡（原则①）：本包**没有**"厨师 AI"，也没有"鼠看到生食就去开火"的规则。
 * 烹烤是一张**卡**，进同一个卡池参与抽签；它为什么被抽中？靠权重（见下方 hook）。
 * 没有任何"玩家指令"/策略卡/条件强插（用户 2026-08-21 裁定：干预面仅 move）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 磁铁范式（照抄 social/farming/sleep 的既有正确写法，勿自创）----
 * ---------------------------------------------------------------------------------
 * 本项目已经因为"把硬闸半径当成贴身距离"踩坑 **4 次**（chat / sow_field /
 * harvest_field / sleep）。那 4 次的共同根因：
 *   **卡 condition 是硬闸**——不通过就根本不进候选池，权重再高也没用。
 *   而"需要先靠近才能做"的行为，若**只把靠近写进 condition**（用贴身半径判），
 *   世界上明明有火，鼠却永远抽不到烹烤卡 = 死代码。
 * 所以这里严格拆成**两个半径**：
 *   - condition 用 `tuning.cooking.magnetRadius`（磁铁，24 格）= "看得见，值得走过去"；
 *   - action 里若还没到 `tuning.cooking.workRadius`（火边，2.5 格）内，就 setPath 走过去
 *     并 return（等引擎 moveStep 推进），到位了才真的开烤。
 * 这与 needs.sleep / farming.sow / farming.harvest / social.chat 完全同构。
 * **推翻路径**：若实测导致鼠群长期扎堆在火边（采集半径被压缩），把 magnetRadius 调小即可，
 * 不必改代码结构（与 sleep 的约定一致）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 机制立论（为什么这样才有意义，不是"让数字好看"）----
 * ---------------------------------------------------------------------------------
 * R3-4 种子原文三句：「生食低收益/熟食高收益"、"烹烤"卡需在火旁"、"火的价值再+1"。
 * 第三句是**目的**——要让"火"除了取暖/睡觉之外还多一个用途，而且是个鼠会主动去用的用途。
 * 那就必须满足：**走一趟火边烤熟，比直接啃生食划算**。否则烹烤卡只会被抽中、不会发生，
 * "火的价值+1"就是一句空话。所以本包的平衡判据不是"熟食看起来更好"，而是
 * **熟食的净收益必须 > 生食，且大到能抵消"走过去 + 在火边待着"的成本**
 * （验收项，见 cooking.test.ts 的"熟食净收益 > 生食"断言）。
 *
 * 【为什么"净收益"要按"每单位食物换到的饱食"算】实测（12 seed × 900 tick，dt=1）：
 *   食物**永不稀缺**（库存均值 347、终值 311~945，最低 0 只在 t=0 出现）。
 *   在一个"食物用不完"的世界里，"多烤几份"= 纯浪费的增量，改变不了任何生存曲线；
 *   唯一有真实意义的杠杆是**单位时间饱食吞吐**：熟食每份给更多饱食点 = 吃得少、活得久。
 *   这才是 R3-4 在"无饥饿压力"世界里的正确表达，也决定了 cookYield=1（不做数量）。
 *
 * 卸载语义（原则④）：不挂本包 → 无 cook 卡、无 SER_COOK 系列；tuning.cooking 仍在出厂表
 *   里但 needs.eat 只看 stockpile.meal（恒 undefined）→ 退化成纯生食，核心照跑。
 *   已存在的熟食存量留存（它是库存事实，不是行为），无人继续生产也不报错。
 *
 * 数值：全部读 tuning.cooking / contracts 资源键（原则③），本文件零魔法数。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD, K_STOCK_MEAL, K_TAG_FIRE } from '../contracts';
import { SER_COOK } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState } from '../../sim/types';

/** 烤制进度 scratch 键前缀：键 `"cooking.<鼠eid>.<火堆建筑id>"`，值 = 起锅时刻（秒）。
 *  为什么带鼠 eid：见文件下方 progressKey 的注释——只用火堆 id 会让"半锅进度串锅"
 *  （实测症状：读档后续跑把起锅时刻覆盖、原料被重复扣，见存读档测试）。
 *  随档（scratch 纪律：不进闭包）。 */
const PROGRESS_PREFIX = 'cooking.';

export const cookingPack: ModPack = {
  id: 'cooking',
  requires: [], // 不依赖任何包：只需要 needs 已登记的卡池 + contracts 的资源键（抽卡池是全局的）
  apply(m) {
    // ---- 权重钩子：让"有火 + 有生食"时更想烤（这是"为什么去烤"的唯一实现处）----
    //
    // 【为什么需要这个钩子，而不是靠权重基数】cook 卡基础权重若给高了，鼠在**远处**
    // 也会反复抽中它、然后每次都卡在"走过去"的路上（白占一整个卡期 = 变相降智）。
    // 但若完全不给它额外权重，熟食的"高收益"就没有推力（鼠不会主动想到去烤）。
    // 这条钩子把两件事一起做：**只在"真的有火可用"时抬权重**，从而让抬高集中在
    // "值得烤"的世界状态上，而不是靠一个永远生效的大基数。
    //
    // 方向性可单测（cooking.test.ts 有断言）：火在磁铁半径内 → 权重更高；无火 → 不抬。
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_COOK) return 1;
      // 抬高系数由 tuning 给（不进包内硬编码，原则③）
      const fire = ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, ctx.tuning.cooking.magnetRadius);
      return fire ? ctx.tuning.cooking.cookWeightNearFire : 1;
    });

    // ---- 卡：烹烤（看见火 + 手里有生食 → 抽上 → 走到火边 → 烤出熟食）----
    m.registerCard({
      id: 'cook',
      label: '烹烤',
      series: SER_COOK,
      // 基础权重 4：刻意**低于**生存卡（gather_berry 10 / chop_tree 9）。
      // 【为什么不是 6】诊断读数（scripts/_cookdiag.mts，12 seed × 900tick）：cook 的
      //   "实际占比/权重应得占比"= **1.02×** ⇒ 它在一次公平的加权轮盘里**按比例**赢，
      //   已经**没有任何机制自锁**（第一版瞬时完成造成的 30.7% 霸池已被 cookSec 修掉）。
      //   所以剩下的是纯粹的**权重高低**问题：基数给多大就直接等于它在卡池里的地位。
      //   第一版 6 × hook 2.0 = 有效 12（压过采集卡）⇒ cook 独占卡池 ~28%，
      //   而"烤"本该是**有余力才做的点缀**（R3-4："火的价值再+1"= 增加一个用途，
      //   不是把主力工作换成做饭）。
      // 【反向代价——这也是不能给高的另一半原因，必须一起看】
      //   cook 权重一高，鼠就**长期待在火边**（磁铁把鼠拽向火堆），
      //   于是 `build_campfire` 的 condition「身边 24 格无火」更难成立 ⇒ **营地不再扩张**。
      //   实测（10 seed × 900 tick）：火堆均值 2.79 → 1.48、终局 3.80 → 1.80、
      //   build_campfire 抽中 28 → 8 次（card-liveness 的 0.2% 下限会红）。
      //   ⇒ cook 的占比存在**上限**，越线就以"少建火堆"为代价。基数 4 是这条实测链的取舍点。
      // 【为什么不把基数放 tuning】registerCard 在挂载期执行、拿不到 ctx；此时读
      //   DEFAULT_TUNING 虽可行，但 **overrideTuning 对已注册的卡无效** ⇒ 那会是一个
      //   "看起来数据驱动、实际改不动"的假入口。故按既有约定（gathering/needs 等包的
      //   卡权重一律写死在包里）写死在这里，把可 A/B 的玩法量（半径/时长/收益）留在 tuning。
      weight: 4,
      condition: (p, ctx) => wantCook(p, ctx),
      action(p, ctx) {
        cook(p, ctx);
      },
    });
  },
};

/**
 * 开烤意愿（= cook 卡的 condition 硬闸）：
 *   ① 磁铁半径内有火（看得见，值得走过去）——**大半径**；
 *   ② 生食库存够一次烹烤的原料 —— 原料不足时这张卡纯死代码。
 *
 * 【为什么两个条件都要在 condition 而不是 action】condition 是"本轮该不该抽它"，
 * 不满足就不进候选池（硬闸）；而"走过去"属于"做得到吗"，属于 action 的磁铁逻辑。
 * 把 ①② 放 condition 是因为它们**都不需要位置配合**（有没有火/有没有料是全局事实）。
 */
function wantCook(p: PawnState, ctx: SimContext): boolean {
  const c = ctx.tuning.cooking;
  const fire = ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, c.magnetRadius);
  if (!fire) return false; // 没有值得为一顿跑过去的火
  if ((ctx.stockpile[K_STOCK_FOOD] ?? 0) < c.cookRawCost) return false; // 没原料：这张卡是死的
  // 【熟食存量闸（cookRawMaxStock）】—— 这是一道**实测出来的**霸池防线，不是拍脑袋的数：
  //   第一版 cook 是"到火边即 finishCard"（瞬时完成），实测 12 seed × 900tick：
  //     cook 抽中占比 **30.7%**（霸占整个卡池）、condition 失败率只有 **2.5%**、
  //     熟食产出 **3090** 份但只被吃 **519** 份（库存峰值 335）⇒ **绝大多数熟食在仓库里烂掉**。
  //   根因是机制性的：食物永不稀缺 ⇒ 鼠并不需要烤那么多才够吃；而"瞬时完成"让 cook
  //     几乎不占用卡期 ⇒ 抽到火边→秒完成→立刻重抽→又抽中 cook，自锁成一台烤不完的机器。
  //   **只调权重治不了**（占比是自锁的结果，不是权重的后果）。
  //   所以约束放在**产出侧**：熟食已经堆到上限就不值得再烤。这写在 condition 里，
  //     仍是抽卡硬闸而非 if-else 强制（原则①：抽不到就忍着，与抽不到 eat 卡同构）。
  if ((ctx.stockpile[K_STOCK_MEAL] ?? 0) >= c.cookRawMaxStock) return false; // 熟食已堆够
  return (ctx.stockpile[K_STOCK_FOOD] ?? 0) >= c.rawStockMin;
}

/**
 * 烹烤动作（磁铁范式 + 真实工作量）：
 *   - 不在火边（> workRadius）→ **走过去**，return（等引擎 moveStep 推进），路上不开烤；
 *   - 在火边 → **起锅**（扣原料、记进度）→ 烤满 cookSec 秒 → 出锅 + finishCard。
 *
 * 【为什么必须给它真实烤制时长（cookSec），不能"到火边就出一份"】见 wantCook 里
 *   cookRawMaxStock 注释的实测（cook 霸占卡池 30.7%、熟食大量烂在仓库）。
 *   对照 gathering：采野果/砍树都是"每 tick 收一份、占满 duration 6~8s"的**持续劳作**；
 *   cook 若瞬时完成，就比所有采集卡"便宜"一个数量级 ⇒ 必然霸池（自锁）。
 *   给它真实烤制时长后，cook 与采集卡在同一量纲上争抽签，占比由权重决定、
 *   而不再由"秒完成"决定。
 * 【进度状态必须进 scratch（存档纪律：不进闭包）】"这锅烤到哪了"是跨 tick 状态，
 *   键 "cooking.<火堆id>"，值 = 起锅时刻；键不存在 = 还没起锅。
 * 【不可达的处理】火被水/岩隔断 → setPath 返回 false → finishCard 收工重抽，
 *  否则"看得见却永远到不了"会原地空转到 duration 结束（与 sleep/sow/harvest 同款防线）。
 */
function cook(p: PawnState, ctx: SimContext): void {
  const c = ctx.tuning.cooking;
  const fire = ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, c.magnetRadius);
  if (!fire) {
    ctx.finishCard(p); // 火灭了/走出磁铁圈：收工重抽
    return;
  }
  if (!ctx.adjacent(p, fire.pos.x, fire.pos.y, c.workRadius)) {
    // 还不够近——**走过去**（这一步是本包全部的"磁铁"含义）。走路不推进烤制进度。
    if (p.path.length === 0 && !ctx.setPath(p, fire.pos.x, fire.pos.y)) {
      ctx.finishCard(p); // 不可达：收工重抽，防恒真空转
    }
    return;
  }
  // ---- 到火边了：起锅 / 烤制中 / 出锅 ----
  p.path = []; // 停在火边别乱走
  const key = progressKey(p, fire.id);
  const raw = ctx.stockpile[K_STOCK_FOOD] ?? 0;
  const meals = ctx.stockpile[K_STOCK_MEAL] ?? 0;
  // ⚠ 清进度时必须**成对**清掉这只鼠在这堆火上的所有进度键（下面的 abandonCook 辅助）：
  //   早期版本用 `delete scratch[key]` 会漏掉"鼠中途换了目标火"的情况 ⇒ 残留键。
  if (raw < c.cookRawCost || meals >= c.cookRawMaxStock) {
    abandonCook(ctx, p); // 原料没了 / 熟食堆够：放弃这一锅（清进度，防半吊子残留）
    ctx.finishCard(p);
    return;
  }
  const startedAt = ctx.scratch[key];
  if (startedAt === undefined) {
    // 起锅：记下起锅时刻并**立刻扣原料**——生产要先投入，不能白嫖
    //（否则烤到一半被打断 = 凭空产出熟食，净收益就成了假的）
    ctx.scratch[key] = ctx.time;
    ctx.stockpile[K_STOCK_FOOD] = raw - c.cookRawCost;
    return; // 这一拍只起锅，还没烤好
  }
  if (ctx.time - startedAt < c.cookSec) return; // 还在烤：下一 tick 继续（不 finishCard，占满卡期）
  // 出锅
  ctx.stockpile[K_STOCK_MEAL] = meals + c.cookYield;
  delete ctx.scratch[key]; // 这一锅完成 → 进度清空（下一锅可另起）
  ctx.log(`🍖 在火边烤出了一份熟食`);
  ctx.finishCard(p);
}

/**
 * 烤制进度 scratch 键：`"cooking.<鼠eid>.<火堆id>"`。
 *
 * ⚠【为什么必须带鼠 eid，不能只用火堆 id —— 这是本包实测抓到的一个真缺陷】
 *   第一版键是 `cooking.<火堆id>`（"一口锅属于一堆火，多只鼠围着同一堆火起锅"）。
 *   缺陷现象（存读档测试抓到的）：读档续跑后，这一锅**重新起锅**，
 *   `scratch["cooking.b1"]` 从 1 被覆盖成 9（=续跑时刻），原料被扣了第二次。
 *   缺陷根因：键只按火堆寻址 ⇒ 一只鼠**中断**（卡到期/被别的事打断/存档读档）
 *   留下的半锅进度，会被**另一只鼠**（或读档后的同一只鼠）当成"自己的锅已烤到一半"
 *   而直接续烤 ⇒ 进度错位 + 原料被重复扣除 ⇒ **凭空多扣食物**（净收益变假）。
 *   （对照 farming：`farming.<建筑id>` 之所以安全，是因为田**同一时刻只能被一只鼠**耕种：
 *    它是"这块田的状态"而不是"谁在耕"的状态。cook 的锅允许多鼠并行，才必须带 eid。）
 * 【代价与取舍】带 eid 后"多鼠同火各起各的锅"是**允许且正确**的（一堆火可以同时被用多次，
 *   没有任何理由禁止）；真正要保证的是**每只鼠自己的锅**进度不串。随档（scratch）。
 */
function progressKey(p: PawnState, fireId: string): string {
  return `${PROGRESS_PREFIX}${p.eid}.${fireId}`;
}

/** 放弃这只鼠当前所有在烤的锅（清进度键）。带 eid 的键无法枚举，故按前缀扫。 */
function abandonCook(ctx: SimContext, p: PawnState): void {
  const prefix = `${PROGRESS_PREFIX}${p.eid}.`;
  for (const k of Object.keys(ctx.scratch)) {
    if (k.startsWith(prefix)) delete ctx.scratch[k];
  }
}