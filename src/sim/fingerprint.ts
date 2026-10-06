/**
 * fingerprint.ts —— 权威状态的确定性摘要（golden-hash 门禁的"测量"那一半）。
 *
 * ## 目的
 *
 * 本项目的核心承诺是**确定性**：同 seed + 同命令流 = 同历史。这是联机（server 权威 +
 * 客户端纯函数重建）与回放的基础。但**确定性的破坏是静默的**：游戏照样能跑、照样
 * 能通关，只是两条路径在某个 tick 悄悄分叉（联机对不上、回放读档续不上）。
 * 任何"不变量"型单测都抓不到这种分叉 —— 它们检查的是"关系成立"，不是"逐位相同"。
 *
 * 所以这里做的是一把**逐位比较的尺子**：把权威状态压成一个短字符串（hash），
 * 交给 `golden.test.ts` 与写死的期望常量比对。外面的做法参考知识库
 * `facts-infcanvas-external-design-references.md` 条目 5（open-atomic-bomberman-97 的
 * 「整数仿真 + 每 tick state_hash + golden 常量冻结」）。
 *
 * ## 喂什么（只喂"权威状态"）
 *
 * 权威 = 决定下一 tick 历史的一切。必须进指纹，否则"漏测一条路径"：
 *   - 时钟与随机源：time / rngState / nextEid / nextHostileId（续跑的分叉源头）
 *   - 世界增量：buildings / featureLeft（被采余量）/ harvestCd（再生冷却）
 *   - 实体：小人全套权威字段（pos/needs/hp/card/uses/mastery/avoidFeat…）、
 *           敌袭全套字段
 *   - 经济与进度：stockpile / 已解锁科技 / 科技碎片 / scratch（玩法包运行态）
 *   - 决策面：卡池构成（已注册卡的 id+series+weight），卡池变了会改抽卡分布
 *
 * 刻意**不喂**：
 *   - 表现层浮点：渲染坐标、插值(interp)量、相机、视口——它们随机器/帧率抖动，
 *     喂进去指纹就不跨机稳定了。表现层数据在 client/，不进 Sim 权威面。
 *   - `world.events` 的文本：日志文本是叙事（会因改文案而变，不必然是玩法分叉）。
 *     只喂 `events.length`（事件条数变了 = 故事线变了 = 实质变化）。
 *   - tuning 表本体：tuning 是"配方"，不是"这一局的状态"。把 tuning 喂进去会让
 *     任何一次调数值都变成指纹变化（噪音淹没信号）；配方变了应该由"玩法改动
 *     的 commit 自己更新 golden 常量"来体现，而不是靠指纹自动报警。
 *
 * ## 怎么保证"跨进程/跨机器稳定"（六条纪律，逐条都有代价理由）
 *
 * 1. **不用 Object 键序**。JS 对象键序 = 插入序（整数键按升序），跨执行可能不同。
 *    凡是 Record（stockpile / scratch / techFragments / mastery / uses）都
 *    **先取 key 排序**再喂。
 * 2. **不用随机数、不用时间**。指纹函数本身是纯的：同 Sim 状态 → 同字符串。
 * 3. **不用浮点原值直接拼串**。权威侧确实有浮点（pos、needs、hp），但它们是
 *    整数运算 + 定点速率推进的结果。为防止浮点末位在跨平台/libm 上的 ±ulp 抖动
 *    误报分叉，一律先**定点量化**（`q(n, 精度)` 缩放到整数）再喂整数。
 *    精度选 1e-3：远细于任何玩法最小刻度（需求/血量按 1 秒 × 速率，最小变化 ≫0.001），
 *    又粗到能吸收 ±ulp。注意：这**不是**把浮点改成整数（不改玩法），只是让
 *    "比较尺"对末位噪声不敏感。
 * 4. **不用平台相关的字符串化**。不 `JSON.stringify`（浮点表示/键序），
 *    改为**显式逐字段喂**一个 32 位流式哈希。
 * 5. **哈希碰撞概率**。FNV-1a 32 位在 ~10^5 量级字段流下碰撞概率可忽略；
 *    且哈希**不等于**黄金常量里唯一的东西 —— 测试同时打印**逐字段摘要**
 *    （见 fingerprintFields）以便碰撞时人工对账。其实 SHA 更强，但 32 位
 *    FNV 足够"门禁"用途且零依赖、跨环境行为可预测（无 BigInt、无平台差异）。
 * 6. **整数一律规范化 -0**。`Math.round`/`Math.trunc` 会产 -0，
 *    而 `-0 >>> 0 === 0` 虽相等，但 `Object.is` 类比较与某些下游不同；
 *    统一 `| 0` 或 `>>> 0` 抹平（存档层 `zeroNorm` 是同款坑的另一半）。
 *
 * ## 命名边界
 *
 * 函数命名与 `scripts/bench.ts` 里的 `fingerprintOf` 刻意区分：bench 那份是
 * 「性能基准自检用的一组聚合玩法指标」（丢给 BENCH_JSON 对比）；本文件是
 * 「逐位状态摘要」。两者关注点不同，不要合并 —— bench 的聚合会掩盖单个字段分叉，
 * 这里的逐位摘要正好补上那个盲区。
 */
import type { Sim } from './sim';

/** FNV-1a 32 位流式哈希器（零依赖、整数运算、跨环境可预测）。
 *
 * 为什么不用 SHA/MD5：要"跨机器稳定 + 零依赖 + 无 BigInt"，32 位 FNV 全满足。
 * 门禁场景下碰撞可忽略，且真的碰撞了还能靠 `fingerprintFields` 人工对账。
 */
class Hasher {
  private h = 0x811c9dc5; // FNV offset basis
  /** 喂一个 32 位整数（字符串先按字节喂，见 feedString）。 */
  int(v: number): void {
    let x = v | 0; // 抹平 -0 与小数尾巴
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
      x >>>= 8;
    }
  }
  /** 喂一个定点量化后的整数（量化已在 q() 完成，这里只规范 -0）。 */
  intNorm(v: number): void {
    this.int(v === 0 ? 0 : v);
  }
  /** 喂一个字符串：按 UTF-16 码元逐字节喂 + 喂长度（防 "ab"+"c" 与 "a"+"bc" 碰撞）。 */
  feedString(s: string): void {
    this.int(s.length);
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
      const hi = s.charCodeAt(i) >>> 8;
      this.h ^= hi & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  /** 喂一个布尔。 */
  bool(b: boolean): void {
    this.int(b ? 1 : 0);
  }
  /** 取出 32 位无符号结果。 */
  digest(): number {
    return this.h >>> 0;
  }
}

/**
 * 定点量化：把权威侧浮点缩放到整数，吸收浮点末位 ±ulp 噪声。
 * 精度 1e-3 —— 远细于玩法最小刻度，粗到能吸收 libm 差异。返回整数（-0 归 0）。
 *
 * 为什么不是"整数仿真"改造：那是玩法线的事，本文件只做"比较尺"。
 */
const QUANT = 1000;
function q(n: number): number {
  // 非有限值兜底：NaN/Infinity 若混进权威态（不该发生，但一旦发生也不能让
  // 指纹悄悄变成 NaN 的字符串化），统一编码成一个可区分的哨兵值。
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 0x7fffffff : 0x7ffffffe;
  const r = Math.round(n * QUANT);
  return r === 0 ? 0 : r;
}

/** 喂一个「键排序后」的 Record<string,number>（纪律 1：不用 Object 键序）。 */
function feedNumRecord(h: Hasher, rec: Record<string, number> | undefined): void {
  if (!rec) {
    h.int(0);
    return;
  }
  const keys = Object.keys(rec).sort();
  h.int(keys.length);
  for (const k of keys) {
    h.feedString(k);
    h.intNorm(q(rec[k]));
  }
}

/** 喂一个「键排序后」的 mastery（值是 {v,t}，都量化）。 */
function feedMastery(h: Hasher, rec: Record<string, { v: number; t: number }>): void {
  const keys = Object.keys(rec).sort();
  h.int(keys.length);
  for (const k of keys) {
    h.feedString(k);
    const e = rec[k];
    h.intNorm(q(e.v));
    h.intNorm(q(e.t));
  }
}

/**
 * 主入口：把 Sim 的权威状态压成一个短确定性字符串。
 *
 * 返回形如 `fp_1a2b3c4d`（固定前缀 + 8 位十六进制 = 32 位摘要，恒定 11 字符）。
 * 短是为了能直接贴进 CI 日志、commit message 与本汇报。
 *
 * 遍历顺序全部**写死且有语义分组**（时钟/随机 → 世界 → 实体 → 经济/进度/决策面），
 * 顺序变更 = 指纹语义变更，属"故意改行为"，必须同 commit 更新 golden 常量。
 */
export function fingerprint(sim: Sim): string {
  const h = new Hasher();
  // ---- 组 1：时钟与随机源（续跑的分叉源头）----
  h.intNorm(q(sim.time));
  h.intNorm(sim.rngState());
  h.intNorm(sim.nextEidValue());
  h.intNorm(sim.nextHostileIdValue());

  // ---- 组 2：世界增量层（buildings / 被采余量 / 再生冷却）----
  // buildings 是 Map：按 id 排序喂，避免插入序影响。
  const buildings = [...sim.world.buildings.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  h.int(buildings.length);
  for (const b of buildings) {
    h.feedString(b.id);
    h.feedString(b.defId);
    h.intNorm(q(b.pos.x));
    h.intNorm(q(b.pos.y));
    h.intNorm(q(b.hp));
  }
  // featureLeft / harvestCd 是 World 的私有增量表，经 exportState 出口读（只读面）。
  const ws = sim.world.exportState();
  const feedPairs = (pairs: [string, number][]): void => {
    const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    h.int(sorted.length);
    for (const [k, v] of sorted) {
      h.feedString(k);
      h.intNorm(q(v));
    }
  };
  feedPairs(ws.featureLeft);
  feedPairs(ws.harvestCd);
  h.intNorm(ws.nextBuildingId);

  // ---- 组 3：小人与敌袭实体（全部权威字段；按 eid/id 排序）----
  const pawns = [...sim.pawns()].sort((a, b) => a.eid - b.eid);
  h.int(pawns.length);
  for (const p of pawns) {
    h.intNorm(p.eid);
    h.feedString(p.name);
    h.intNorm(q(p.pos.x));
    h.intNorm(q(p.pos.y));
    h.intNorm(q(p.needs.food));
    h.intNorm(q(p.needs.rest));
    h.intNorm(q(p.needs.mood));
    h.intNorm(q(p.needs.san));
    h.intNorm(q(p.hp));
    h.intNorm(q(p.maxHp));
    h.intNorm(q(p.climb));
    h.feedString(p.trait);
    // cardId 可为 null → 用哨兵 0 区分"没卡"与"卡 id 恰好是空串"
    h.intNorm(p.cardId === null ? 0 : 1);
    if (p.cardId !== null) h.feedString(p.cardId);
    h.intNorm(q(p.busyUntil));
    h.intNorm(q(p.holdUntil));
    h.intNorm(q(p.atkCd));
    // path 是权威的（下一步要走的路径，moveStep 消费）：按序喂长度 + 每个点。
    h.int(p.path.length);
    for (const pt of p.path) {
      h.intNorm(q(pt.x));
      h.intNorm(q(pt.y));
    }
    feedMastery(h, p.mastery);
    feedNumRecord(h, p.uses);
    // avoidFeat 可选（旧档兼容）；用哨兵区分"无避让目标"与"有目标但坐标为0"。
    h.int(p.avoidFeat === undefined ? 0 : 1);
    if (p.avoidFeat !== undefined) {
      h.intNorm(q(p.avoidFeat.x));
      h.intNorm(q(p.avoidFeat.y));
      h.intNorm(q(p.avoidFeat.until));
    }
  }
  const hostiles = [...sim.hostiles()].sort((a, b) => a.id - b.id);
  h.int(hostiles.length);
  for (const x of hostiles) {
    h.intNorm(x.id);
    h.feedString(x.kind);
    h.intNorm(q(x.pos.x));
    h.intNorm(q(x.pos.y));
    h.intNorm(q(x.hp));
    h.intNorm(q(x.maxHp));
    h.intNorm(q(x.atkCd));
  }

  // ---- 组 4：关系（小人之间的关系值，影响社交决策）----
  const relations = [...sim.exportRelations()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  h.int(relations.length);
  for (const [k, v] of relations) {
    h.feedString(k);
    h.intNorm(q(v));
  }

  // ---- 组 5：经济与进度 ----
  feedNumRecord(h, sim.stockpile);
  // 已解锁科技是集合：排序喂（Set 插入序不可靠）。
  const techs = [...sim.techUnlocked()].sort();
  h.int(techs.length);
  for (const t of techs) h.feedString(t);
  feedNumRecord(h, sim.techFragments);
  // scratch 是玩法包运行态（敌袭压力/农耕进度/科技累积器…）：键排序喂。
  feedNumRecord(h, sim.scratch);

  // ---- 组 6：决策面（卡池构成）与事件条数 ----
  // 卡池 id+series+weight：改卡池会改抽卡分布 → 是"玩法变更"的指纹信号。
  const cards = [...sim.cards()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  h.int(cards.length);
  for (const c of cards) {
    h.feedString(c.id);
    h.feedString(c.series);
    h.intNorm(q(c.weight));
  }
  h.int(sim.events.length); // 只取条数，不取文本（叙事改文案 ≠ 玩法分叉）

  const hex = h.digest().toString(16).padStart(8, '0');
  return `fp_${hex}`;
}

/**
 * 辅助：把指纹拆成逐字段的"人类可读摘要"（不进断言，只在哈希万一碰撞时人工对账，
 * 或写"故意改行为"的 commit message 时说明"到底哪个字段变了"）。
 *
 * 与 bench.ts 的 BENCH_JSON 聚合指标互补：本函数给的是**逐字段**，
 * 所以任一权威字段分叉都能定位到具体字段，而不是只知道"一个数变了"。
 */
export function fingerprintFields(sim: Sim): Record<string, string> {
  const buildings = [...sim.world.buildings.values()].map((b) => `${b.id}@${b.defId}:${b.pos.x},${b.pos.y}:${b.hp}`);
  const pawns = [...sim.pawns()].sort((a, b) => a.eid - b.eid).map((p) => `${p.name}:${p.hp.toFixed(2)}:${p.needs.food.toFixed(2)}:${p.cardId ?? '-'}`);
  const hostiles = [...sim.hostiles()].map((x) => `${x.kind}#${x.id}:${x.hp.toFixed(2)}`);
  let uses = 0;
  for (const p of sim.pawns()) for (const n of Object.values(p.uses)) uses += n;
  return {
    time: String(sim.time),
    rngState: String(sim.rngState()),
    buildings: buildings.join('|'),
    pawns: pawns.join('|'),
    hostiles: hostiles.join('|'),
    usesTotal: String(uses),
    stockFood: String(sim.stockpile['food'] ?? 0),
    stockWood: String(sim.stockpile['wood'] ?? 0),
    techs: [...sim.techUnlocked()].sort().join(','),
    events: String(sim.events.length),
    cards: sim.cards().length + '',
  };
}