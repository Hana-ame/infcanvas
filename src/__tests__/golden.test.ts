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
 *
 * - 2026-10-06 第 8 次换血 —— **接入 R3-4 烹饪包**（`src/mods/packs/cooking.ts`，
 *   新增 `cook` 烹烤卡 + `K_STOCK_MEAL` 熟食键 + `SER_COOK` 系列）：
 *     指纹必然变：卡池里**多了一张卡**，`drawCard` 的加权轮盘与 RNG 消耗序列整体前移。
 *     这不是"平衡漂移"，是内容变更——就像第 4 次换血（`chat` 改磁铁）一样。
 *     **变的是什么**：`needs.ts` 的 `eat` 卡新增了"熟食优先"取值分支；
 *     新增 `tuning.cooking` 8 个字段（只被 cook 卡读，不影响别的卡的权重）。
 *     **没变的是什么**（逐项实测钉住，防止"顺手改坏了别的"）：
 *       - 科技节奏：平均解锁 **1.40 项（基线）→ 1.20 项**，方向是**更少**；
 *         `storage:store` 在 10 seed 里解锁 **2/10（基线也是 2/10，seed 99@450s、
 *         2026@900s）** ⇒ 碎片落点抖动，不是节奏变快。
 *       - 营地扩张：`build_campfire` 抽签占比 0.292%（基线）→ **0.233%**，仍在 0.2% 门禁之上。
 *       - 存活：10 seed × 4 鼠 = **40/40 全存活**；候选池 5.08 → 5.3 上下，门禁 3.5 有余量。
 *     ⚠️ **这一轮踩到的真机制冲突（记录下来，因为推翻路径会用到）**：
 *     烹饪包与营地扩张**争夺同一批鼠**——`cook` 的磁铁把鼠拽向火堆，而
 *     `build_campfire` 的 condition 恰恰是「身边 24 格无火」。第一版照抄
 *     `needs.sleepMagnetRadius(24)`，实测直接把火堆均值从 2.79 压到 **1.48**、
 *     `build_campfire` 打到 0.086%（**红**）。A/B（scripts/_sweep*.mts）证明根因是
 *     **磁铁半径**而不是权重，最后定在 6 格（≈1.3 秒路程，只在"本来就贴着火"时才烤）。
 *     ⚠️ 我**没有**为了让门禁变绿去放宽 `build_campfire` 的 0.2% 阈值——那条断言测的是
 *     真实性质，降到它就等于把回归藏起来。详见 `tuning.cooking.magnetRadius` 的注释。
 *
 * - 2026-10-06 第 9 次换血 —— **有限范围 A* + 标志位导航**（用户架构指令：
 *   「使用有限范围的 A* 为了无限地图支撑。地图上会设置大坐标标志位置点」）：
 *     `setPath` 长距（>24 格）时**不再先试 8000 迭代直连 A***，而是默认走
 *     `planRoute` 标志位分段导航（起点→最近火堆锚点→…→目标，每段 1500 迭代）。
 *     **只有 seed 7 的指纹变**（`fp_85456929`）：该 seed 的 900s 局里存在长距路径
 *     且绕了标志位（分段最优 ≠ 全局直连最优）；seed 42/2026 的路径多为短距
 *     （≤24 格走直连），指纹不变 —— 与「架构变更只影响长距」的预期一致。
 *     **收益**：长距 setPath 1.6ms → 0.96ms（−40%）；128 鼠 × 600 tick 27.6s → 21.6s
 *     （−22%）；4/64 鼠持平。**为无限地图支撑**：长距搜索不再依赖地图尺寸
 *     （8000 迭代上限 → 固定 1500/段），只依赖标志位网络密度。
 * - 2026-10-07 第 10 次换血 —— **R4-GEN 种子轮首个合并：events 事件包**
 *   （`src/mods/packs/events.ts`，5 事件谓词+效果表 + `EventSeedDef.effects` 扩容）：
 *     指纹必然变：事件系统每 `checkSec` 扫一次局面并**改写世界状态**
 *     （`stock` 加减 / `hpDelta` 全体扣血 / `spawnPawn` 出生新鼠），
 *     RNG 消耗序列与实体集合同时位移。与第 4/8 次换血同源（内容变更，非平衡漂移）。
 *     **为什么允许换血**：换血的理由永远是「世界状态变了」而不是「指纹对不上就改常量」。
 *     本包的设计纪律已验证：所有阈值进 `tuning.events.thresholds`（零魔法数）、
 *     冷却走 scratch（随档）、`tempShift` 读 `scratch['env.temp']` 用 `!== undefined`
 *     判空（env 包未挂载时静默跳过）、只有 `{log}` 的旧 seed 形状仍触发不报错（向后兼容）。
 *     **卸载验证已做**：不挂 events 时 eventSeeds 为空、无事件 log、世界照跑；
 *     挂 env 不挂 events 时 `env.temp` 不受 tempShift 影响。
 *     ⚠️ 换血纪律：本表每次换血都必须能说出「变的是什么」+「没变的是什么」。
 *     本轮只合 events 一个包，其余 6 条种子线（hunting/env/medicine/fortify/combat/
 *     factions）合并时若指纹再变，须各自单独换血并注明，不允许一次批量换血掩盖问题。
 * - 2026-10-07 第 11 次换血 —— **R4-GEN 剩余 6 条种子线全量合并**
 *   （combat / hunting / env / medicine / factions / fortify，一次全装配 8 包）：
 *   指纹必然变——6 个新包 = 6 个新 RNG 消费者 + 6 个新系统类别执行序插点，
 *   下游整条抽卡序列 / 敌袭判定 / 科技碎片落点 / 贸易声望全部位移。
 *   与第 4/8/10 次换血同源：**内容变更导致世界状态不同**，不是平衡漂移、
 *   不是确定性受损。
 *
 *   ⚠️ 本轮换血里修掉的三个**真实缺陷**（不是为了让指纹对上而改的）：
 *   ① `sim.ts setPath` 引用共享缺陷（fortify 线定位）：`p.path = path` 把
 *      `planRoute` 的**缓存数组本身**挂给小人，`moveStep` 靠 `shift()` 推进，
 *      走一趟就把 routeCache 那条路线掏空成 `[]`——同起终点下次命中缓存拿到空数组，
 *      `ok=false`，**可达路线被判不可达**，小人原地 `finishCard` 空转。
 *      `routeCache` 是私有字段不进存档，读档后重建出空缓存、毒化条目随档消失，
 *      所以只有「多次存档/读档 ≡ 直跑」这条不变量能抓到（seed 7 边界
 *      [150,300,450]：tick 558 逐字段全等、559 分叉）。fortify 只是暴露者
 *      （塔挂 K_TAG_WAYPOINT，而只有 planRoute 的结果进缓存）。修法 `path.slice()`。
 *      顺带修掉一个真玩法缺陷：原代码会让可达路线被判不可达、鼠空转。
 *   ② `factions` 的 `trade` 卡 condition 纯度缺陷：`wantTrade` 调 `tradeTargetOf`，
 *      后者会写 `ctx.scratch` 锁定贸易目标——**condition 是谓词，不该有副作用**
 *      （scratch 进指纹也进存档）。后果：drawCard 光是构建候选集就改了世界，
 *      card-liveness 的候选池采样把 build_store 读数从 4 抬高到 6。拆出纯查询
 *      `findTradeTarget` 给 condition，锁定留在 action（doTrade）。修完 26 张卡的
 *      condition 全部纯化（逐个比对指纹验证）。
 *   ③ `fingerprint.ts` harvestCd 规范化：`World.featureAt` 的读路径对到期条目做
 *      惰性清除（`harvestCd.delete` + 出桶），使指纹对「清理做到哪一步」敏感。
 *      改为喂指纹前丢掉 `readyAt <= sim.time` 的条目。语义无操作（到期即已可采），
 *      只让指纹 canonical；chop_tree 的 condition 因此也变纯。
 *
 *   ⚠️ **没变的**（三条不变量断言仍全绿，这是本次换血唯一该被信任的部分）：
 *     - 步长不变性：`run(100,1)×6 ≡ run(600)` 逐位相同 ✅
 *     - 存档续跑一致：多次 snapshot/load ≡ 不存档直跑 ✅
 *     - 重复跑一致：连跑两轮三 seed 指纹逐位相同 ✅
 *   所以指纹变了、确定性没变：变的只是「同一 seed 下的世界长什么样」，
 *   不是「同一种子是否总产生同一个世界」。
   * - 2026-10-07 第 12 次换血 —— **社交层去死端：关系自强化 + 速率重定**
  *   （`social.ts` chat action + `tuning.social`）：
  *   指纹必然变——关系值进指纹，而闲聊对关系的写入量改了。
  *   与第 4/8/10/11 次换血同源：**内容变更导致世界状态不同**，不是确定性受损。
  *
  *   ⚠️ 本次换血修的是一个**死端**，不是调平衡：
  *   实测（4 seed × 1200 tick）发现关系值全库**唯一写入方**是闲聊，
  *   而 `ctx.relation()` 的唯一读取方是一个测试断言——**零生产消费者**。
  *   即：写了不改任何事。加上出厂速率让 20 分钟模拟时间只积累到 6/100，
  *   10 seed 里 0 对达到 ±30。种子句承诺「人际关系」，这一层当时事实上是死代码。
  *   修两件事：
  *   ① `social.ts` 加 **关系自强化**（`aff = clamp(1 + relation/affinityDenom, 0, 2)`）：
  *     朋友聊得更来劲（正反馈，滚成挚友）、仇敌聊了白聊且更易翻脸（负反馈），
  *     口角走对称的 `2 - aff`（挚友 aff=2 → 口角率 0）。关系由此接回行为面。
  *     关键细节：乘子必须用闲聊**前**的关系值，否则这一轮自己写进去的增量会
  *     反馈给自己。
  *   ② `tuning.social.chatRelGain` 2→6，A/B 扫（10 seed × 1200 tick）：
  *     gain=2 → max 17.2，0/10 有 ≥30 友谊（不可见）；gain=6 → max 59.4，2/10；
  *     gain=12 → max 100（顶到上限饱和）。取 6 是余量最合理的档。
  *   ⚠️ **没变的**：三条不变量断言仍全绿——步长不变性、存档续跑一致、
  *   重复跑一致。变的只是世界长什么样，不是「同一种子是否总产生同一个世界」。
  *   ⚠️ 附带效应（诚实记录）：自强化让口角变稀有——pair 聊着聊着变挚友，
  *     `2-aff→0`。packs-isolated 的口角测试因此要显式把关系拉回 0 来隔离这个正反馈，
  *     否则测的就不再是「低心情 × 概率」这个局面谓词本身了。
  *     负值侧全程 0/10：口角需要心情 < lowMoodQuarrelAt(30)，而食物永不稀缺
  *     所以心情常年很高，仇怨路径自然不触发——安逸的营地不打架，这是自洽后果。
  * - 2026-10-07 第 13 次换血 —— **阵营声望漂移：打破"永不为敌"的数学死锁**
  *   （`factions.ts driftReputation` + `tuning.factions.repMeanRev/repDriftMag`）：
  *
  *   ⚠️ 换血理由：改动前声望的**唯一写入方**是 trade（+4）与 raid（-12），
  *   而 raid 的触发条件是 `rep < hostileThresh(-25)`——「必须先敌对才能掠夺」。
  *   所以声望**只升不降**：repInit(35) > friendlyThresh(30) ⇒ 开局可贸易 ⇒
  *   声望单调升到 +100，掠夺门槛 -25 **数学上永远到不了**。种子句承诺的
  *   「背叛与战争」这半个系统永久关着。
  *   修法：每 check 拍对每对派系施加 `(repInit - rep) * repMeanRev + rng*±repDriftMag`。
  *   漂移是声望向**敌对侧**游走的唯一新通道。
  *
  *   ⚠️ **只变了两条，2026 没变**——这是本轮最有信息量的一点：
  *     42: fp_3ff56c4a → fp_666964e1   7: fp_96047f5c → fp_a12a340b
  *     2026: fp_3382999d **不变**
  *   原因：`driftReputation` 只在「有派系对」时才跑，而 seed 2026 在 900 tick
  *   内**只有 1 个派系**（1 座篝火）⇒ 漂移空转、不消耗 `ctx.rng()` ⇒
  *   指纹逐位不变。这同时是本轮的负面发现：**多数 seed 只有 1 个篝火**
  *   （18 seed 扫测 14 seed ≤1 座），所以「掠夺罕见」主要是**篝火稀缺**
  *   （build_campfire 权重 0.47%）造成的，不是漂移太弱。详见 tuning 注释。
  *
  *   ⚠️ **没变的**：三条不变量断言仍全绿——步长不变性、存档续跑一致、
  *   重复跑一致。变的只是世界长什么样，不是「同一种子是否总产生同一个世界」。
  *   ⚠️ 附带效应：factions 的两个掠夺测试断言了「声望恰好降 repLossRaid」的
  *     精确值，被每拍 ±10 的漂移噪声打散。给 `twoFactionSim` 加了 `noDrift`
  *     开关关掉漂移以隔离掠夺谓词本身——同第 12 次换血里口角测试的处理方式。
  
  * - 2026-10-07 第 14 次换血 —— **寒潮级联修复：cooldownSec 60→120**
  *   （`tuning.events.cooldownSec`）：
  *
  *   ⚠️ 换血理由（一个**静默的无限循环**）：coldsnap 的 `durationSec=60` 而
  *   `cooldownSec=60`，两者**严格相等** ⇒ 每次寒潮到期回退（`env.tempMod: -12→0`）
  *   与下一场寒潮触发（`env.tempMod: 0→-12`）落在**同一个 check 窗口**内
  *   （冷却判定 `time - last < cooldownSec` 在差值恰好等于冷却期时放行）。
  *   于是 `env.tempMod` **永久卡在 -12**，回退窗口归零。实测：35.8% 的 tick
  *   处于冻死温度（`env.temp < coldThreshold(2)`），84% 的死因变成冻伤。
  *   取 120 = 2× durationSec ⇒ 60s 寒潮 + 60s 恢复窗口，低温占比降到 20.2%。
  *
  *   ⚠️ **三条全变了**（上一轮漂移只变了 2 条）：
  *     42: fp_666964e1 → fp_37d01c94
  *     7:  fp_a12a340b  → fp_2be98c3c
  *     2026: fp_3382999d → fp_a4cee9a0
  *   原因：寒潮冷却改变了事件时序，而事件触发时刻消耗 `ctx.rng()`，
  *   整条轨迹平移。与第 13 次不同——2026 这次**也变了**，说明它的
  *   6000 tick 内确实有寒潮在跑（上一轮漂移只在派系对存在时才消耗 rng，
  *   而 2026 只有 1 个派系，所以漂移空转）。
  *
  *   ⚠️ **没变的**：三条不变量断言仍全绿——步长不变性、存档续跑一致、
  *   重复跑一致。变的只是世界长什么样，不是「同一种子是否总产生同一个世界」。
  *
  *   ⚠️ 附带修的两处注释（诚实记录）：
  *     ① `tuning.env.coldThreshold` 的注释写「默认局够不到，需 override 才触发」——
  *        这是**错的**。昼夜曲线 [10,18] 确实够不到 2，但 events 包的 coldsnap
  *        写 `env.tempMod=-12` 会让合成温度落到 -2，所以默认局**会**触发冻伤。
  *     ② `tuning.events.cooldownSec` 的注释补上了硬约束：
  *        **cooldownSec 必须严格大于任何事件的 durationSec**，否则持续型事件级联。
  *
  *   ⚠️ 新增测试锁住这个不变量（events.test.ts「寒潮不级联」）：
  *     谓词**恒真**（无火堆 ⇒ coldsnap.when 直接 return true），所以寒潮持续触发。
  *     这正好是上面那条「余波过期」测试**刻意规避**的场景——它加篝火掐断了条件，
  *     所以从未覆盖过「条件恒真 + 冷却=持续」的级联路径。断言恢复窗口存在
  *     （不是「不触发」——那样是冷却本身失效）。
  *
  * - 2026-10-07 第 19 次换血 —— **stockMul 效果类型首个消费者：丰饶雨季事件**
  *   （`events.ts` fecund-season + `tuning.events.thresholds.fecundFoodAbove`）：
  *
  *   ⚠️ 换血理由：`stockMul` 是 `applyEffects` 里已实现但长期**零消费者**的效果类型
  *   （与旧 tech-pool 无消费者同构：引擎支持但无种子使用 = 死代码）。本事件给它
  *   一个真实消费者：雨天 + 粮食尚可时库存 ×1.3。
  *
  *   条件读 `env.rain`（env 包在场时有效）：与 tempShift 读 `env.temp` 同款能力探测——
  *   env 未挂载时 `env.rain` 不存在，条件为 false，静默跳过，不报错。
  *
  *   ⚠️ **只变了两条，7 没变**——seed 7 在 900 tick 内未触发该事件（rain + food>50
  *   的条件在该轨迹上未同时满足），指纹逐位不变。42 和 2026 都触发了。
  *
  *   ⚠️ **没变的**：三条不变量断言仍全绿——步长不变性、存档续跑一致、
  *   重复跑一致。变的只是世界长什么样，不是「同一种子是否总产生同一个世界」。
  */

const GOLDEN: Record<string, string> = {
  // ⚠ 第 22 次换血（R3 审计 P1#1+P1#2：heal 预留按秒量纲 + 失败降级不派卡）：
  //   改前 heal 的预留是 herbCost×duration（秒）、消费是「每 tick 1 份」——生产 step(0.25)
  //   下 8 秒卡期 = 32 tick，预留 8 份只够前 8 tick，其余 24 tick 空转，卡期回血覆盖率
  //   只有 25%。改成 herbCost×dt 后 8 份正好覆盖 8 秒，覆盖率回到 ~97%。heal 的实际生效
  //   时长被拉长，伤员康复时刻与后续抽卡/事件时序整条平移，三个 seed 全变：
  //     42: fp_557aa1bc → fp_cc302d2f ｜ 7: fp_24bc2f7c → fp_ee09f7b8
  //     2026: fp_6c0c44a0 → fp_122ecc8d
  // ⚠ 第 21 次换血（Round 57，healRequireHerb 闸）：heal 的 condition 新增「库存
  //   草药 ≥ herbCost」硬闸，修掉 condition 不判自己原料的不纯（对照 build_bed 判木料）。
  //   12 seed×900 tick A/B：卡回血 231→236hp（+2%，医疗未牺牲）、木料 305→848（+178%）、
  //   人口 61→66、空转 3854→301（−92%）、持卡 tick 6642→371。释放的卡期流向 chop_tree
  //   +284 / gather_berry +252 / cook +160 / sow_field +166。这是**行为**变更，指纹必变；
  //   同批三个 seed 全部重算（42 dc5d01ea→557aa1bc、7 cbe944db→24bc2f7c、
  //   2026 f3788afa→6c0c44a0），无一保持不变。
  '42@900': 'fp_cc302d2f',
  '7@900': 'fp_ee09f7b8',
  '2026@900': 'fp_122ecc8d',
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
