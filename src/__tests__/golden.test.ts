/**
 * golden.test.ts —— 确定性 golden-hash 门禁（CI 硬阻断 job `golden`）。
 *
 * ## 这个测试在防什么
 *
 * 本项目的根基是**确定性**（同 seed + 同命令流 = 同历史）。但确定性的破坏是
 * **静默的**：游戏照样能跑、照样能玩通关，只是两条路径（联机 client 重建 /
 * 回放读档续跑）在某个 tick 悄悄分叉。任何"不变量"型单测都抓不到这种分叉 ——
 * core.test.ts 检查的是"关系成立"（比如 needs ∈ 0..100），而分叉的 A 路和 B 路
 * **各自都成立**，只是不相等。所以这里比对的是**逐位相等**：把权威状态压成一个
 * 指纹，与写死的期望常量比。
 *
 * 这就是为什么 CI 的 `golden` job **不能 continue-on-error**：确定性的破坏
 * 静默且致命，必须硬门禁。与 bench/balance 等"报告型" job 性质不同。
 *
 * ## 常量是怎么来的（重要：这是本测试的维护流程）
 *
 * 指纹是**当前玩法基线**的快照，不是人工编的。本项目实际走的就是这条流程
 * （本地 CPU 被占、跑不动 900 tick × 3 seed，故基线由 CI 跑出来）：
 *   1. 首次提交把常量留成占位 `__PENDING__`，CI 红 → 从日志读出**实际指纹**；
 *   2. 把实际值填进下方 `GOLDEN` 常量，同一 commit 注明"建立 golden 基线"；
 *      （本项目实际值 = CI run 37408979742 读回的 fp_b805dce5 / fp_33a3f071 / fp_83e63dd8）
 *   3. 之后每次 CI 绿 = 玩法未变；红了 = 要么故意改玩法（更新常量 + 写理由），
 *      要么是真回归（不更新，修代码）。
 *
 * 判别「故意改玩法 vs 真回归」的完整流程见 docs/DESIGN.md 的
 * 「golden-hash 门禁：故意改行为 vs 真的确定性回归」一节。
 *
 * ## 覆盖的两条性质
 *
 * 1. **同 seed 同 tick 数 → 同指纹**（跨多次重复也必须一致）：
 *    锁住"同输入必同输出"。
 * 2. **存档→读档→继续跑 ≡ 不存档直跑**：这是确定性的"续跑"形态，也是
 *    line/net 联机与回放的基础（server 存档、客户端重建）。对拍的是指纹相等。
 *    （save-load.test.ts 已有逐字段对拍；这里是"跨进程可比的单一摘要"版本，
 *    也是联机做 state_hash 失同步检测时对拍的同一把尺子。）
 */
import { describe, expect, it } from 'vitest';
import { Sim, fingerprint, fingerprintFields, snapshotOf, loadSim } from '../sim';
import { ModRegistry } from '../mods';

/**
 * 固定场景表：3 个 seed × 固定 tick 数（玩法基线，与 balance/bench 的 900s 对齐）。
 *
 * 为什么 ≥3 个 seed：单 seed 只是"这一个地形"的读数。地形由 seed 哈希推导，
 * 不同 seed 的地形/特征/寻路热点完全不同，行为分叉往往只在某类地形上触发。
 * 多 seed = 覆盖多类世界。
 */
const SCENARIOS = [
  { seed: 42, ticks: 900 },
  { seed: 7, ticks: 900 },
  { seed: 2026, ticks: 900 },
] as const;

/**
 * golden 常量表：key = `${seed}@${ticks}`，value = 该场景跑完后的权威状态指纹。
 *
 * ⚠ 本表是**玩法基线的快照**。改玩法（tuning / 抽卡 / 系统逻辑）导致指纹变化时，
 *   必须在**同一个 commit** 更新本表，并在 commit message 里写明"为什么变"。
 *   只改玩法不改本表 = CI 红 = 这正是门禁的意义（防止静默的行为漂移）。
 *   详见 docs/DESIGN.md「golden-hash 门禁」一节。
 *
 * 基线来源：CI run 37408979742（job `golden`）——本地 CPU 被占跑不了 900 tick × 3 seed，
 *   按 DESIGN.md 的建基线流程，让 CI 跑一次并从失败日志读回真实指纹。
 *   交叉验证：`test (node 22)` 同一 commit 独立跑出**逐位相同**的三条指纹
 *   （node 20 同样一致）—— 说明指纹跨 node 版本稳定（node 只影响执行引擎，
 *   不影响整数权威态的逐位结果）。
 *
 * ⚠ 2026-10-06 基线换血 #2（修 `world.featureAt` 不取整的键口径缺陷之后）：
 *   换血原因：`featureAt` 原先用**未取整** x,y 拼键查 featureLeft/harvestCd，
 *   而 `takeOne` 一定取整 ⇒ 读写两张表用了两套坐标口径。实测后果：
 *     ① **再生冷却可被小数位查询绕过**（900s 后 36 个冷却格中 2 个 = 5.6%），
 *        卡 condition 拿到"这里可采"的假前提，takeOne 再拒绝 → 空转一轮；
 *     ② `fullAmount` 的 hash2(x,y) 在 **66.6%** 的坐标上给出不同的树余量。
 *   属**故意的正确性修复**（改的是"读到的真相"，不是随机数流），
 *   按约定同 commit 换血基线并写明原因。门禁逐字段 diff 佐证：建筑/鼠/库存全变，
 *   而 time/rngState 等无关字段语义正常，不是非确定性故障。
 *   修复后 12 seed × 900s 实测：平均存活 3.50/4，**12 个 seed 全部 ≥3**（门槛安全）。
 *
 * - 2026-10-06 第 4 次换血 —— `chat` 卡从"硬闸"改成"磁铁"（社交曾是死代码）：
 *     原写法 `condition: neighborOf(p, ctx) !== null` 用 chatRadius=2.5 找同伴，
 *     而实测鼠群两两距离平均 **46.4** 格、≤2.5 的只有 **1.1%** ⇒ 闲聊卡条件失败率
 *     **97.0%**、被抽中占比仅 1.5%，社交功能事实上不存在。**它一直是绿的**，
 *     因为旧测试手动把两只鼠摆到距离 1（人工摆位制造了假前提）。
 *     修法：拆两个半径同一张卡内完成"走过去 + 开口"（approachRadius 磁铁 26 格 /
 *     chatRadius 开口 2.5 格），沿用 gathering 的 workFeature 走路模式，
 *     不碰抽卡引擎语义。
 *     实测效果：chat 占比 1.5% → **18.0%**；候选池平均 3.08 → **4.05** 张；
 *     前二张卡合计 61.2% → 51.5%；6 seed 存活 **全部 4/4**（原为 3.50/4）。
 *
 * - 2026-10-06 第 5 次换血 —— 科技池 `chance` 0.55 → 0.8（原注释的算术是错的）：
 *     旧注释声称「期望 ~218s 一块碎片 ⇒ 首个科技 3 块 ≈ 11 分钟 < 900s，玩家能看到
 *     科技真的来了」。这个算术**只数了总碎片数**，漏了「碎片要落在正确的那一项上」
 *     ——4 项科技时 rank0 抽中权重 4/10 = 40%，不是必中。
 *     实测：900s 内 4 seed 合计仅 8 块碎片（每 seed 2 块），**4 个 seed 只有 1 个
 *     解锁了任何科技**，其中 3 个跑到 1800s 仍零解锁 ⇒ 整棵科技树在一整局里基本不存在，
 *     `build_store` 卡 condition 失败率 **100.0%**（它被 storage:store 门控）。
 *     改后：900s 内 4 seed 平均解锁 **0.25 → 0.75 项**，存活 6 seed 全部 ≥3（CI 门槛安全）。
 *
 * - 2026-10-06 第 6 次换血 —— 农耕与睡眠的**磁铁半径**修复（`line/cards` 0f82b7e）：
 *     ① `farming.senseRadius=12` 被 condition（进候选池）与到位判定**共用**，而实测
 *        「到最近熟田距离」中位 31.0 格、≤12 的只有 18.2% ⇒ 熟田**烂在地里**。
 *        拆成 `workRadius=1.5`（到位）+ `magnetRadius=30`（候选池）。
 *     ② `needs` 的 sleep 写死 `nearestBuildingByTag('fire',…, 8)`：火在 8格外时
 *        fire=null ⇒ 走 else「野外打盹」且**永不尝试走过去**。Lead 独立实测
 *        （4 seed×900 tick，不采信提交里的数字）：睡眠 600 tick 里
 *        **火在 8 格内 8.8%、贴到火边 8.5%、睡时到最近火中位 16.6 格**
 *        ⇒ `sleepRestNearFire`/`sleepSanNearFire`/棚屋回心情三条常年享受不到。
 *        新增 `needs.sleepMagnetRadius=24`。
 *     ③ 顺带修了 `sow()`/`harvest()` **忽略 setPath 返回值**导致磁铁圈内恒定空转。
 *     **注意**：sleep 的 **condition（rest<70）没有动**——rest 悬在 70 上下是衰减率与
 *     恢复率调出的平衡点，失败率 82% 是正确行为。变的是"睡的时候到底在不在火边"。
 *     实测：10 seed 存活 39/40 → **40/40**；stockFood 698 → 733（+5.0%，多收熟田的
 *     收益盖过赶路成本）；候选池 5.40 → 5.19（门禁下限 3.5 有大量余量）。
 *
 * - 2026-10-06 第 7 次换血 —— 科技池 `intervalSec` 120→90 + `chance` 0.8→1.0（R3-6）：
 *     **上一轮我判断错了瓶颈**，这次逐量 A/B 才发现。10 seed × 900s 实测平均解锁项数：
 *         0.8/120（改前）→ 0.70 项 | 0.8/90 → 0.70 项（只降 interval 几乎没用）
 *         **1.0/90（本次选定）→ 1.40 项** | 0.9/60 → 2.10 项（超标，留作上界参照）
 *     命中既定目标区间「1~2 项：看得见但不白给」。
 *     ⚠️ 顺带证伪 `tech-pool.ts:70-71` 的注释「n=4 时靠前的期望约 2.6 块就先攒齐」：
 *     rank0 实际是 3 块 ÷ 40% = **期望 7.5 块**，不是 2.6。而我上一轮打算换的
 *     **几何权重是错的药**——8/4/2/1 会让 rank3 期望从 50 块涨到 **75 块**，
 *     靠后的科技更抽不到，而那正是"往后抽卡"要留的渐进感。
 *     ⇒ **真瓶颈是碎片供给总量**：全树需 3+4+4+5 = **16 块**，900s 原本最多发约 6 块。
 *     ⚠️ **build_store 仍保留豁免，且这里钉住了原因**：改后 `storage:store` 在
 *     10 seed 里解锁 2 次（改前 1 次），但 seed 101 解锁于 **900s——正是局长最后一 tick**，
 *     余 0 秒可建造 ⇒ 科技"能解锁"与"能来得及用"是两件事，后者才是它仍不可达的原因。
 *     实测：平均存活 3.90/4、候选池 5.07 张（门禁下限 3.5 有余量）。
 */
const GOLDEN: Record<string, string> = {
  '42@900': 'fp_3f763ba5',
  '7@900': 'fp_035f942a',
  '2026@900': 'fp_55d9db08',
};

/** 跑一个场景：固定 seed 跑固定 tick 数，返回指纹（不存档直跑）。 */
function runStraight(seed: number, ticks: number): Sim {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  sim.run(ticks);
  return sim;
}

describe('golden-hash 门禁（确定性基线）', () => {
  for (const { seed, ticks } of SCENARIOS) {
    const key = `${seed}@${ticks}`;

    it(`指纹基线：seed ${seed} 跑 ${ticks} tick ≡ golden 常量`, () => {
      const sim = runStraight(seed, ticks);
      const fp = fingerprint(sim);
      // 期望值取自下方 GOLDEN 表。首次建立门禁时会先失败并把实际值打进
      // 控制台/CI 日志 —— 这就是"从日志读回真实指纹"的来源。
      // 失败信息里额外打逐字段摘要：万一 32 位哈希万一碰撞，可人工对账定位字段。
      expect(fp, `seed=${seed} ${ticks}tick 指纹与 golden 不一致。逐字段：\n${JSON.stringify(fingerprintFields(sim), null, 2)}`).toBe(
        GOLDEN[key],
      );
    });

    it(`重复跑（同 seed 同 tick）指纹必须一致：seed ${seed}（确定性不变量）`, () => {
      // 同一进程内跑两遍。模拟必须无隐藏的跨局残留/时钟/随机态。
      const a = fingerprint(runStraight(seed, ticks));
      const b = fingerprint(runStraight(seed, ticks));
      expect(a).toBe(b);
    });
  }

  it('存档→读档→继续跑 ≡ 不存档直跑（指纹相等，续跑确定性）', () => {
    const seed = 42;
    const ticks = 900;
    // 直跑 900
    const straight = runStraight(seed, ticks);
    // 分段：跑 300 → 存档 → 读档 → 续 600
    const split = new Sim({ seed, registry: ModRegistry.default() });
    split.run(300);
    const saved = snapshotOf(split);
    // 经 JSON 往返（模拟真实落盘/读盘）再读档
    const restored = loadSim(JSON.parse(JSON.stringify(saved)), ModRegistry.default());
    restored.run(ticks - 300);

    expect(fingerprint(restored), `seed=${seed} 存档续跑与直跑指纹分叉。逐字段：\n${JSON.stringify(fingerprintFields(restored), null, 2)}`).toBe(
      fingerprint(straight),
    );
  });

  it('多次存档/读档（存档次数不改变结果）：连续 3 次存取后与直跑一致', () => {
    const seed = 7;
    const ticks = 900;
    const straight = runStraight(seed, ticks);

    // 反复存取：每一段都读档重建 Sim（模拟频繁保存），
    // 验证"存档本身"不引入任何状态漂移（rng/nextEid/scratch 全随档）。
    let cur = new Sim({ seed, registry: ModRegistry.default() });
    let done = 0;
    for (const seg of [150, 300, 450]) {
      cur.run(seg - done);
      done = seg;
      cur = loadSim(JSON.parse(JSON.stringify(snapshotOf(cur))), ModRegistry.default());
    }
    cur.run(ticks - done);

    expect(fingerprint(cur)).toBe(fingerprint(straight));
  });
});
/**
 * 步长不变性：**本项目保证的确定性到哪一步为止**（2026-10-06 实测厘清）。
 *
 * ## 背景：为什么要专门问这个问题
 *
 * golden 门禁证明的是「**同 seed + 同 tick 数** → 同指纹」。但玩家/服务器调用
 * `step(dt)` 时 dt 是可以变的（本项目 `run(seconds, dt = 1)` 直接暴露 dt 参数，
 * 客户端也有 1×/3×/8× 三档速度）。于是有个从没被问过的问题：
 * **同 seed、同样推进 600 秒，step(1) 与 step(25) 会不会得到同一个世界？**
 *
 * ## 实测结论：不会，而且**这不是 bug，是浮点运动积分的固有性质**
 *
 * 三 seed 实测（step(1)×600 vs step(25)×24）：
 *   seed 42  fp_990e2b99 vs fp_488e1881  ❌
 *   seed 7   fp_596a569c vs fp_c0dd9a6d  ❌
 *   seed 99  fp_1b924432 vs fp_e16fa2fa  ❌
 *
 * 根因在 `sim.moveStep`（`src/sim/sim.ts:358-374`）：移动用 `speed * dt` 作为
 * 路程预算，按浮点把鼠推向路径节点。dt=1 时鼠**恰好落在每个节点上**；
 * dt=25 时一步跨过多个节点、且斜向切角，落点变成非整数坐标。
 * 而世界是**基于坐标哈希**的（`featureKind`/`fullAmount` 都按 `Math.round` 取整位
 * 推导），落点一变 ⇒ 脚下是哪一格变了 ⇒ 采收/建造的位置全变 ⇒ 整局分叉。
 * 这是「浮点运动 + 哈希世界」的必然结果，不是某处写错。
 *
 * ## 所以本测试断言的是**真实的契约**，不是假装 dt 无关
 *
 * 契约两条：
 *  1. **固定步长下确定性成立**（golden 门禁已覆盖，这里再钉一次防回归）；
 *  2. **固定步长下结果与「跑法」无关** —— step(1)×600 与
 *     step(1)×600 分成 6 段 run(100, 1) 跑，必须逐位相同。
 *     这才是实际会被用到的性质（分帧跑 ≠ 改变步长）。
 *
 * 3. **变步长不保证相同**，且这是**有意不修**的：把它变成保证要么固定内部步长
 *     （改变服务器/客户端的现有行为，属于玩法改动），要么把移动改成整数格推进
 *     （改变寻路与移动手感，属于玩法改动）。两者都要单独立项 + 重采平衡，
 *     不该由一条"补测试"的提交顺手决定。
 */
describe('步长不变性（确定性保证的边界）', () => {
  it('固定步长下：分帧 run(100,1)×6 ≡ 一次跑 600 tick（逐位相同）', () => {
    const a = new Sim({ seed: 42, registry: ModRegistry.default() });
    a.run(600, 1);
    const b = new Sim({ seed: 42, registry: ModRegistry.default() });
    for (let i = 0; i < 6; i++) b.run(100, 1); // 同样的 step(1)，只是分成 6 次调用
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('固定步长下：中途存档再续跑 ≡ 一次跑完（已在 golden 覆盖，此处钉住不变式）', () => {
    const a = new Sim({ seed: 7, registry: ModRegistry.default() });
    a.run(400, 1);
    const b = new Sim({ seed: 7, registry: ModRegistry.default() });
    b.run(200, 1);
    // 走公开存档面（snapshotOf/loadSim），不伸进 Sim 的私有字段
    const resumed = loadSim(JSON.parse(JSON.stringify(snapshotOf(b))), ModRegistry.default());
    resumed.run(200, 1);
    expect(fingerprint(resumed)).toBe(fingerprint(a));
  });

  it('变步长会分叉 —— 记录当前真实行为，防止有人误以为它已修（若这条转绿，说明有人改了积分方式，应同步改文档）', () => {
    const a = new Sim({ seed: 42, registry: ModRegistry.default() });
    a.run(600, 1);
    const b = new Sim({ seed: 42, registry: ModRegistry.default() });
    b.run(600, 25); // 同样 600 秒，但步长 25
    // 断言"不同"而不是"相同"：这是一条**记录现状**的测试。
    // 若将来决定支持变步长，这条会转绿，届时应把它改成相等断言并更新本文件头。
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });
});
