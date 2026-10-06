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
 */
const GOLDEN: Record<string, string> = {
  '42@900': 'fp_54915155',
  '7@900': 'fp_127c67d1',
  '2026@900': 'fp_64110beb',
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