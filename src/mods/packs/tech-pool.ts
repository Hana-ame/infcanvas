/**
 * tech-pool 包 —— 科技 = 独立抽卡池（碎片制）。ROADMAP R2-1。
 *
 * 设计出处与红线（用户 2026-08-13/14 两次定案 + 阶段⑤）：
 *  - "科技是要抽卡"、"科技是另外的池子"、"神谕不能降下科技"
 *    → 科技有自己的独立抽卡池，玩家碰不到它（干预面仅 move，见 AGENTS.md 用户裁定）。
 *  - "每个科技都有碎片，碎片攒齐了才能组成科技，也是抽卡"
 *    → 抽卡池每次只发**一块碎片**；攒满 fragments 自动解锁整卡并发事件。
 *  - "往后抽卡"渐进解锁：权重按 TECH_ORDER 顺序**线性递减**（rank 0 权重最高），
 *    所以靠前的科技先攒满先解锁，但**不保证**——仍是抽卡，不是顺序解锁表。
 *  - "重复可开出"（2026-08-15 裁决）：候选池含已解锁科技，抽到 = 重复卡，碎片不累计
 *    （Sim.grantTechFragment 返回 'dup'）。重复稀释新科技获取期望 = 渐进节奏更缓。
 *
 * 卸载语义（原则④"卸载不破坏核心"）：不挂本包 → 没有任何系统发碎片 →
 * tuning.techs 为空 → building 包的 tech 门控自动放行（Sim.techSatisfied），
 * 建造照常。永无科技，但核心跑得动。
 *
 * 运行态：抽卡计时器走 ctx.scratch（键 "tech-pool.acc"）——
 * 跨 tick 状态进闭包会导致读档后发碎片节奏分叉（阶段④存档纪律）。
 */
import type { ModPack } from '../pack';
import type { SimContext } from '../../sim/context';

/** 抽卡计时器的 scratch 键（随档；键格式 "<包>.<名>" 见 context.ts 约定） */
const ACC_KEY = 'tech-pool.acc';

export const techPoolPack: ModPack = {
  id: 'tech-pool',
  requires: [],
  apply(m) {
    // ---- 科技数据表（种子；碎片数与顺序位全在 tuning.techs，改数值不用改代码）----
    // order 0/1/2/3 = 抽卡权重递减位（权重 = TECH_ORDER.length - rank）。
    // 为什么 hut/store 有门控而 campfire 没有：篝火是 bootstrap 开局引导的落脚点，
    // 加科技门控会让"新营地连火都生不起来" = 死锁开局（世界模型里没有地牢传送）。
    m.registerTech({ id: 'craft:tool', name: '简易工具', fragments: 3, order: 0, unlocks: [], cardSeriesMul: { gather: 1.3 } });
    m.registerTech({ id: 'storage:store', name: '仓储术', fragments: 4, order: 1, unlocks: ['store'] });
    m.registerTech({ id: 'fire:ring', name: '火塘改良', fragments: 4, order: 2, unlocks: [], cardSeriesMul: { build: 1.2 } });
    m.registerTech({ id: 'craft:toolkit', name: '精工工具', fragments: 5, order: 3, unlocks: [] });

    // ---- 系统：科技抽卡池（类别 world：进度类，与战斗无关但也不是社会行为）----
    m.registerSystemDef({
      id: 'tech-pool',
      category: 'world',
      ctor: (ctx: SimContext) => ({
        id: 'tech-pool',
        update(dt) {
          const t = ctx.tuning.techPool;
          const order = ctx.techOrder();
          // 全解锁 → 抽无可抽：直接停表（否则永远空转刷 scratch）
          if (order.every((id) => ctx.techUnlocked().has(id))) return;
          let acc = (ctx.scratch[ACC_KEY] ?? 0) + dt;
          if (acc < t.intervalSec) {
            ctx.scratch[ACC_KEY] = acc;
            return;
          }
          acc -= t.intervalSec; // 保留余量（长 dt 不丢进度；不是取模是防长步长雪崩）
          ctx.scratch[ACC_KEY] = acc;
          if (ctx.rng() >= t.chance) return; // 本轮空抽：制造"科技不来"的节奏
          drawTechFragment(ctx, order);
        },
      }),
    });

    // ---- 权重钩子：解锁科技 = 技能提升，让相关系列卡更常抽中 ----
    // 与 traits.seriesMul 同构：每个已解锁科技对其 cardSeriesMul 中的系列施加乘数。
    // 不填 cardSeriesMul 的科技（如 storage:store）不参与权重调制——它们的效应是
    // 解锁建筑门控（unlocks），不是行为倾向。
    m.registerHook('cardWeight', (p, card, ctx) => {
      let mul = 1;
      for (const techId of ctx.techUnlocked()) {
        mul *= ctx.tuning.techs[techId]?.cardSeriesMul?.[card.series] ?? 1;
      }
      return mul;
    });
  },
};

/**
 * 抽一块碎片：候选池 = 全部科技（含已解锁 = 重复卡），
 * 权重按 TECH_ORDER 线性递减（rank 0 = n，rank n-1 = 1）。
 *
 * ⚠️ 2026-10-06 修正本注释里被证伪的算术（本文件**连续两轮**各证伪一条注释算术，
 *    ——手算概率注释必须先按真实权重算一遍再写）：
 *    旧注释写「n=4 时权重 4/3/2/1，靠前的期望约 2.6 块就先攒齐」。
 *    实测：rank0 抽中概率 = 4/(4+3+2+1) = **40%**，攒齐 3 块要
 *    **3 ÷ 0.4 = 期望 7.5 块**（负二项分布均值 k/p），不是 2.6 块。
 *    「2.6」的错误来源：把「4 块里 40% 是 rank0 ⇒ 约 1.6 块」和「要 3 块」
 *    揉在一起心算，漏了「每块都要先命中 rank0 才算数」。
 *    顺带：几何/幂次（如 8/4/2/1）会让 rank3 期望从 50 块涨到 75 块——靠后科技
 *    更抽不到，那正是「往后抽卡」要留的渐进感，所以不要改成幂次（R3-6 实测结论，
 *    见 tuning.techPool 与 docs/PROGRESS.md 的 R3-6 行）。
 *
 * 线性：n=4 时权重 4/3/2/1 —— 靠前的期望 7.5 块先攒齐，靠后的要等前面的解锁完
 * 才轮得到，「往后抽卡」的渐进感够用且看得懂（概率表能心算）。
 */
function drawTechFragment(ctx: SimContext, order: readonly string[]): void {
  const n = order.length;
  if (n === 0) return;
  let total = 0;
  for (let rank = 0; rank < n; rank++) total += n - rank; // n + (n-1) + … + 1
  let r = ctx.rng() * total;
  for (let rank = 0; rank < n; rank++) {
    r -= n - rank;
    if (r <= 0) {
      const id = order[rank];
      const def = ctx.tuning.techs[id];
      const res = ctx.grantTechFragment(id);
      if (res === 'dup') {
        // 重复卡也给玩家看一眼（否则"抽到重复"完全静默，玩家不知道池子在动）
        ctx.log(`🔩 又抽到一张 ${def?.name ?? id}（重复，碎片不累计）`);
      } else if (res === 'progress') {
        const got = ctx.techFragmentsOf(id);
        ctx.log(`🔩 科技碎片：${def?.name ?? id} ${got}/${def?.fragments ?? '?'}`);
      }
      // 'unlocked' 的事件由 Sim.grantTechFragment 统一记（解锁是重要事实，单点出口）
      return;
    }
  }
}