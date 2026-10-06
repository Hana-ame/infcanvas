/**
 * card-liveness.test.ts —— **死卡探测器**：把「功能其实不存在」变成会红的断言。
 *
 * ---- 这类缺陷长什么样（先看真实案例，别抽象地理解）----
 *
 * `social` 包的 `chat` 卡（闲聊）**一直是绿的**，但社交功能事实上不存在：
 * 被抽中占比仅 1.5%、condition 失败率 97.0%。为什么没被发现？
 * 因为旧测试（`packs-isolated.test.ts:79-83`）**手动把两只鼠摆到距离 1 格**
 * 再 `debugForceCard`：
 * ```ts
 * a.pos = { x: 0, y: 0 };
 * b.pos = { x: 1, y: 0 };
 * s.debugForceCard(a.eid, 'chat');
 * ```
 * 也就是说，**测试用人工摆位制造了 condition 成立的假前提**——验证的是
 * 「如果世界允许」而不是「世界真的允许」。玩家在真实 900s 局里遇不到这种局面。
 *
 * 一句话教训：
 * > **任何 `debugForceCard` + 手动摆坐标的测试，都在验证假想世界。**
 * > 这类测试必须配一条**无人干预的自然局统计断言**，否则功能可以是死的而测试全绿。
 *
 * ---- 本文件的三条断言 ----
 *
 * ① `每张卡都必须活`：注册的所有卡，在多 seed 自然局里被抽中次数 > 0。
 * ② `关键卡必须达到最低活跃度`：生存/社交/建造类关键卡占抽签总量的下限。
 * ③ `候选池不能塌缩`：平均可抽卡数 ≥ 3.5 张——这条直接对应用户的核心抱怨
 *    「内容不丰富／不结构化」。
 *
 * ---- 关于阈值怎么定的（不许拍脑袋）----
 *
 * 所有阈值都来自 2026-10-06 的实测基线，并写在这里以便复核：
 *   - 修 chat 前：chat 1.5%、候选池 3.08 张、前二卡 61.2%
 *   - 修 chat 后：chat 18.0%、候选池 4.05 张、前二卡 51.5%
 *   - 修科技池后：候选池 ≥3.5 张成立
 * 阈值取在"当前实测值 - 15~25% 余量"处：**既能抓住退化，又不会被正常的平衡
 * 调整误伤**。⚠️ 若某天有人为了转绿直接下调阈值，这条测试就失去意义了——
 * 所以阈值改动必须在 PR 里说明新的实测依据（见下方 THRESHOLDS 注释）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import type { CardDef } from '../sim/cards';

/** 统计用的 seed 集：10 个（不是 4 个）。
 *  ⚠️ 教训（同 survival-loop.test.ts）：**单/少 seed 的统计量就是噪声**。
 *  10 seed × 900 tick 的统计在本地只花约 1.5s，负担可忽略，换来的是稳定的分母。 */
const SEEDS = [42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080];
const TICKS = 900;

/**
 * **结构性稀有**豁免清单：这些卡在 900s 的一局里本就不可达/稀有，不是死代码 bug。
 * 每一条都必须写明**实测依据**（见对应断言），不许"看着像稀有"就塞进来。
 * 新增条目时问自己：它是真的结构性稀有，还是又一只忘了修的死卡？
 */
const STRUCTURALLY_RARE = new Set<string>([
  // build_store：科技门控 storage:store(order=1)，实测 900s 内 0/4 seed 解锁、1800s 3/4。
  // 即"科技树比一局生存循环还长"。详见下方那条专门断言。
  'build_store',
]);

/** 取装配后的全部注册卡（走 registry 的公开面，不伸私有字段）。 */
function allCards(): CardDef[] {
  const sim = new Sim({ seed: 1, registry: ModRegistry.default() });
  const reg = (sim as unknown as { reg: { cards: Map<string, CardDef> } }).reg;
  return [...reg.cards.values()];
}

/** 自然局统计：不做任何 debugForceCard、不摆坐标——**这正是本文件存在的意义**。
 *  返回每张卡的被抽中次数、抽签总数，以及每次抽样时的候选池大小。 */
function survey() {
  const uses = new Map<string, number>();
  let total = 0;
  const poolSizes: number[] = [];
  for (const seed of SEEDS) {
    const sim = new Sim({ seed, registry: ModRegistry.default() });
    // 注意固定 dt=1：变步长会分叉（golden.test.ts 已钉住这条边界），
    // 拿变步长的读数下结论会得到完全错误的世界。
    for (let t = 0; t < TICKS; t++) {
      if (t % 7 === 0) {
        const cards = allCards();
        for (const p of sim.pawns()) {
          let n = 0;
          for (const c of cards) {
            if (typeof c.condition !== 'function') continue;
            try {
              if (c.condition(p, sim)) n++;
            } catch {
              /* condition 抛错视为不通过——与 drawCard 的真实行为一致 */
            }
          }
          poolSizes.push(n);
        }
      }
      sim.step(1);
    }
    for (const p of sim.pawns()) {
      for (const [k, v] of Object.entries(p.uses)) {
        uses.set(k, (uses.get(k) ?? 0) + v);
        total += v;
      }
    }
  }
  return { uses, total, pool: poolSizes };
}

const report = survey();

describe('死卡探测器（功能不存在但测试全绿的那一类缺陷）', () => {
  it('候选池不能塌缩：平均可抽卡数 ≥ 3.5 张（直接对应"内容不丰富"的抱怨）', () => {
    const avg = report.pool.reduce((a, b) => a + b, 0) / report.pool.length;
    // 基线：修 chat 前 3.08（→ 本测试会红，正确）；修 chat 后 4.05。
    // 取 3.5：低于修复前的 3.08、高于修复后的 4.05 留 14% 余量。
    expect(
      avg,
      `平均候选池 ${avg.toFixed(2)} 张 < 3.5：可抽的卡太少 ⇒ 行为趋同，"内容不丰富"。` +
        `若这是有意的设计调整，请先看 docs/DESIGN.md 的多样性章节再改阈值。`,
    ).toBeGreaterThanOrEqual(3.5);
  });

  it('没有任何一张注册卡在自然局里从未被抽中（0 活跃 = 死代码）', () => {
    const cards = allCards();
    const dead = cards
      .map((c) => ({ id: c.id, n: report.uses.get(c.id) ?? 0 }))
      .filter((x) => x.n === 0)
      .filter((x) => !STRUCTURALLY_RARE.has(x.id))
      .map((x) => x.id);
    expect(
      dead,
      `这些卡在 ${SEEDS.length} seed × ${TICKS} tick 的自然局里一次都没被抽中（= 死代码）：` +
        `${dead.join(', ')}。常见成因：condition 指向永远不成立的世界状态` +
        `（需要先靠近/先攒够/先解锁科技，而没把"靠近"写进卡里）。` +
        `修法见 src/mods/packs/social.ts 头部的"硬闸改磁铁"范式。` +
        `若确实是"设计上就该稀有"，请加进 STRUCTURALLY_RARE 并写明实测依据。`,
    ).toEqual([]);
  });

  it('【豁免】build_store 在 900s 内不可达：科技树比一局还长（有实测依据）', () => {
    // 这张卡被 STRUCTURALLY_RARE 豁免，**理由必须可复核**，所以在这里单列一条断言
    // 把"它到底什么时候才活"钉住。若哪天科技节奏变了，这条会红，届时该
    // 把它移出豁免清单（而不是放宽别的阈值）。
    //
    // 实测（2026-10-06，4 seed）：木料不是瓶颈——木料 ≥8 的 tick 占比 85~96%。
    // 真正的门是**科技顺序解锁**：build_store 被 `storage:store` 门控，而它 order=1，
    // 必须等 order=0 的 `craft:tool`（3 块碎片）先解锁。
    //   900s  → storage:store 解锁的 seed：**0 个**
    //   1800s → 3 个（42/99/2026）
    //   2700s → 4 个
    // ⇒ **科技树（~1800s+）比一局生存循环（900s）还长**，build_store 在局内必然是死的。
    // 这不是 bug，是"科技树比游戏长"的内容设计事实；真正的解法是重排 TECH_ORDER
    // 或压缩碎片数（属内容线立项），不是在这里放宽断言。
    const n = report.uses.get('build_store') ?? 0;
    expect(n, `build_store 活跃 ${n} 次：若科技节奏已变（storage:store 可在 900s 内解锁），` +
      `应把它移出 STRUCTURALLY_RARE 豁免清单并纳入活跃度下限`).toBe(0);
  });

  it('关键卡活跃度下限：抽签占比（阈值见文件头 THRESHOLDS 说明）', () => {
    // 生存底线：吃喝睡 + 两种采集 = 游戏的根本。低于这些说明鼠快活不下去了，
    // 或者（更可能）采集卡 condition 恒真把别的卡挤没了。
    // build_campfire 是"营地能否重建"的机制入口，chat 是社交包唯一的卡——
    // 它死过一次（97% 失败率），必须盯住。
    const FLOOR: Record<string, number> = {
      eat: 0.02,
      sleep: 0.005,
      gather_berry: 0.05,
      chop_tree: 0.05,
      build_campfire: 0.002,
      chat: 0.05,
    };
    const bad: string[] = [];
    const lines: string[] = [];
    for (const [id, floor] of Object.entries(FLOOR)) {
      const n = report.uses.get(id) ?? 0;
      const share = report.total === 0 ? 0 : n / report.total;
      lines.push(`${id}=${(share * 100).toFixed(2)}%(下限 ${(floor * 100).toFixed(1)}%)`);
      if (share < floor) bad.push(`${id} ${(share * 100).toFixed(2)}% < ${(floor * 100).toFixed(1)}%`);
    }
    expect(bad, `关键卡活跃度不足 → ${bad.join('; ')}\n实测：${lines.join('  ')}`).toEqual([]);
  });

  it('【豁免清单】稀有卡不设活跃度下限：fight / flee 依赖敌袭按局推进', () => {
    // fight 的 condition 需要"附近有敌"，敌袭按 pressurePerSec≈0.55 累积到 100 才来
    // ≈ 每 180s 一波，且只在那一瞬间附近才有猫 ⇒ fight/flee 天然稀有。
    // 对这类卡设活跃度下限是**错的**：会逼着人去改数值把战斗变成常驻，
    // 而"大多数时候在干活、被咬时才拔刀"正是战或逃该有的样子。
    // 所以这里断言的是它们的**占比存在一个合理上界**——防止哪天改成常驻打架。
    const fightShare = (report.uses.get('fight') ?? 0) / report.total;
    const fleeShare = (report.uses.get('flee') ?? 0) / report.total;
    // 上界 10%：实测 fight 0.9% / flee 0.6%。若超过 10%，说明战斗变成了日常，
    // "战或逃"的触发时机（被袭击时）被稀释了。
    expect(fightShare, `fight 占比 ${(fightShare * 100).toFixed(2)}% 过高：战斗变成常驻了`).toBeLessThan(0.1);
    expect(fleeShare, `flee 占比 ${(fleeShare * 100).toFixed(2)}% 过高：逃跑变成常驻了`).toBeLessThan(0.1);
  });
});