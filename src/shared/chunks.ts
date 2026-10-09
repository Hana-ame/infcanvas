/**
 * shared/chunks.ts —— 区块（chunk）几何与键编解码：**服务器 / 客户端 / 存档三方唯一事实**。
 *
 * ## 为什么要引入 chunk
 *
 * v3 的 World（src/sim/world.ts）是**纯函数推导 + 哈希**，本来没有 chunk 概念：
 * 无限地图靠 tileAt(x,y) 现场算，所以"地形"永远不需要存储，也就永远不需要同步。
 * 但联机链路（ROADMAP R6 备忘表登记的缺口「服务器 tick 无快照压缩」）卡的不是地形，
 * 而是**落在地上的实体状态**——建筑、敌袭、被采过的特征余量。它们是要随快照走的，
 * 而现有协议每 500ms 全量重发一遍：
 *
 *   delta: hostiles = sim.hostiles().map(clone)      // 每连接、每 500ms、全量
 *          buildings = [...world.buildings.values()] // 每连接、每 500ms、全量
 *
 * 规模一上来，代价是 O(玩家数 × 世界实体数 × 每秒 2 次)。区块化把它压到
 * O(玩家数 × 视口区块数)，并且顺带给模拟侧一个"按区块分帧"的调度单位。
 *
 * ## 尺寸为什么是 64
 *
 * 取自已归档的旧实�� test/src/sim/core/world.ts:24（CHUNK_SIZE=64）——
 * 那份是完整可用的双图层实现，是本设计的可靠参考，不另造一套数字。
 * 64 的意义：视口在 22px/格、1920px 宽时约 40 格 = 0.6 chunk，视野跨度天然落在
 * 1~2 个 chunk 上，边际区块数小；同时 64×64=4096 格，一块 Uint8Array 的生成成本可接受。
 *
 * ## ⚠️ 强纪律：一切 key 解码必须走本文件
 *
 * 旧实现在 2026-08-14 踩过的坑：地块/建筑 key 曾用 `k % width` 这种**内联解码**，
 * 漏改了 17 处 → 表现为"桥不修 / 篝火不迁 / 伤口不疗"这种**沉默的功能级损坏**，
 * 而且是 17 个各自独立的 bug 现场。教训不是"小心点"，而是**让错误无法写出来**：
 * 本文件只导出 chunkKeyToXY / chunkKeyToTileKey 两个解码入口，其余一律不写 `%`。
 * 下方 chunkKeyToXY 的注释记了这个坑的成因（负坐标下 % 是截断余数）。
 */

/** chunk 边长（tile）。DESIGN §370 / 旧实现 test/src/sim/core/world.ts:24 同值。 */
export const CHUNK_SIZE = 64;

/** 每 chunk 的 tile 数（CHUNK_SIZE²）。 */
export const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/**
 * 区块键编码基址与跨度。
 * chunkKey(cx,cy) = (cx + 32768) + (cy + 32768) * 65536
 * —— 与旧实现逐位一致（存档互操作的前提：同一个 key 在新旧两版指向同一块地）。
 * 支持 cx/cy ∈ [-32768, 32767]，即 tile 坐标 ±2M，远超 MAX_TILE 实际探索半径。
 */
export const CHUNK_KEY_BIAS = 32768;
export const CHUNK_KEY_SPAN = 65536;

/**
 * 区块键编码（**唯一**编码入口）。
 *
 * 用加法而非 `cx * 2^16 + cy` 的异或/位或方案：旧实现选加法是因为它对负坐标天然安全
 * （偏置后恒非负），代价是占用 2^32 的整数空间——但 JS number 是 double，
 * 2^32 量级远小于 2^53 精度上限，无精度问题。
 */
export function chunkKey(cx: number, cy: number): number {
  return cx + CHUNK_KEY_BIAS + (cy + CHUNK_KEY_BIAS) * CHUNK_KEY_SPAN;
}

/**
 * 区块键解码（**唯一**解码入口，2026-10-06 记：旧实现漏改 17 处内联 `k % width`）。
 *
 * ⚠️ 这里踩过坑，且**是本轮首轮 CI 真炸出来的**，值得把过程完整写下来：
 *
 * 第一版我照着归档旧实现 `serializeChunks` 的写法写了"防御性回拨"：
 *     let cx = key % SPAN; let cy = floor(key / SPAN);
 *     if (cx > SPAN/2) { cx -= SPAN; cy += 1 }   // ← 这一支是错的
 * 初看是"防负余数偏移"，实测 chunkKey(1,1) 解出 {cx:-65535, cy:2}。
 *
 * **根因**：chunkKey 给**两个分量都加了 32768 偏置**，所以 key 恒 ≥ 0，
 * 而 `key % 65536` 对非负 key 恒落在 [0, 65536) —— 也就是说
 * `cx + 32768` 天然就在 [0, 65536) 里，**根本不存在需要回拨的负余数**。
 * 我那个 `cx > SPAN/2` 分支不是防御，是**凭空制造的 bug**：它把合法的
 * cx=1（余数 32769 > 32768）当成"被偏移的负余数"给拉回去了。
 *
 * **教训（比代码本身更重要）**：负坐标的坑不在"要不要回拨"，而在
 * "你的编码是否自带偏置"。带偏置的加法编码里 `%` 恒安全，不需要任何修正；
 * 不带偏置的编码里 `%` 才是截断余数陷阱。**照抄防御代码而不验证它是否
 * 在自己的编码下成立，比不写防御更危险** —— 后者至少是可见的缺口，
 * 前者制造的是"看起来很严谨但恒错"的代码，只有穷举测试能抓住。
 * 所以 chunk-geom.test.ts 里对 7×7 邻域做**穷举**往返，而不是几个手挑样例。
 */
export function chunkKeyToXY(key: number): { cx: number; cy: number } {
  const cx = key % CHUNK_KEY_SPAN; // 非负 key → 余数恒在 [0, SPAN)，无需回拨（见上）
  const cy = Math.floor(key / CHUNK_KEY_SPAN);
  return {
    cx: (cx === 0 ? 0 : cx) - CHUNK_KEY_BIAS, // -0 归一：JS % 对 -SPAN 倍数返回 -0，
    cy: (cy === 0 ? 0 : cy) - CHUNK_KEY_BIAS, //      toEqual 会区分 +0/-0
  };
}

/**
 * chunk 内偏移（tile 坐标 → 0..4095 的线性下标）。**唯一**入口。
 * 行主序：offset = ly * CHUNK_SIZE + lx —— 与旧实现的 Uint8Array 布局一致。
 */
export function chunkOffset(lx: number, ly: number): number {
  return ly * CHUNK_SIZE + lx;
}

/** tile 坐标 → { cx, cy, lx, ly, offset }：热路径上避免重复除法，故合成一次返回 */
export function tileChunk(x: number, y: number): { cx: number; cy: number; lx: number; ly: number; offset: number } {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const lx = x - cx * CHUNK_SIZE;
  const ly = y - cy * CHUNK_SIZE;
  return { cx, cy, lx, ly, offset: chunkOffset(lx, ly) };
}

/** chunk 键 + 偏移（供 Map 索引用的一步到位版本，省一次对象分配——热路径每 tick 调） */
export function tileChunkKey(x: number, y: number): { key: number; offset: number } {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  return { key: chunkKey(cx, cy), offset: chunkOffset(x - cx * CHUNK_SIZE, y - cy * CHUNK_SIZE) };
}

/** 区块在 tile 空间的闭区间包围盒（渲染/空间查询用） */
export function chunkBounds(cx: number, cy: number): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  return { x0, y0, x1: x0 + CHUNK_SIZE - 1, y1: y0 + CHUNK_SIZE - 1 };
}

/** 一批区块的包围盒（可能为 null = 空批） */
export function chunkBoundsOfList(keys: Iterable<number>): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (const k of keys) {
    const { cx, cy } = chunkKeyToXY(k);
    const b = chunkBounds(cx, cy);
    if (!any) {
      any = true;
      x0 = b.x0;
      y0 = b.y0;
      x1 = b.x1;
      y1 = b.y1;
    } else {
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
    }
  }
  return any ? { x0, y0, x1, y1 } : null;
}

// ------------------------------------------------------------------
// 视口区块范围（interest / scope）
// ------------------------------------------------------------------

/** 区块兴趣区：中心 tile + 半径 tile。客户端上行，服务端据此裁剪快照。 */
export interface ChunkInterest {
  x: number;
  y: number;
  /** 半径（tile）。0 = 只要中心所在那一块。 */
  r: number;
}

/**
 * 兴趣区 → 覆盖区块键集合。
 *
 * 返回的是**中心距升序**的数组，不是 Set：tick 预算调度（Sim.sweepChunkBudget）
 * 按这个顺序消费，玩家眼前的区块总是先被处理——远处的地形被延迟处理，
 * 而玩家看不到延迟（可见即优先），这就是分帧调度能藏住延迟的原因。
 */
export function chunksForInterest(interest: ChunkInterest): number[] {
  const cx0 = Math.floor((interest.x - interest.r) / CHUNK_SIZE);
  const cx1 = Math.floor((interest.x + interest.r) / CHUNK_SIZE);
  const cy0 = Math.floor((interest.y - interest.r) / CHUNK_SIZE);
  const cy1 = Math.floor((interest.y + interest.r) / CHUNK_SIZE);
  const out: { key: number; d2: number }[] = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      // 中心 → 区块中心的距离（tile）；同距离的并列，不影响正确性只影响调度顺序
      const bx = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
      const by = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
      const dx = bx - interest.x;
      const dy = by - interest.y;
      out.push({ key: chunkKey(cx, cy), d2: dx * dx + dy * dy });
    }
  }
  out.sort((a, b) => a.d2 - b.d2 || a.key - b.key); // key 兜底：保证顺序确定（测试与确定性）
  return out.map((o) => o.key);
}

/** 一组区块键的紧凑坐标表示（进协议用：cx/cy 比裸 key 可读且便于日志排查） */
export interface ChunkCoord {
  cx: number;
  cy: number;
}

/** chunkKey[] → ChunkCoord[]（**解码只走 chunkKeyToXY**，见文件头纪律段） */
export function toChunkCoords(keys: Iterable<number>): ChunkCoord[] {
  return [...keys].map((k) => {
    const { cx, cy } = chunkKeyToXY(k);
    return { cx, cy };
  });
}

/** ChunkCoord[] → chunkKey[]（客户端侧反变换） */
export function fromChunkCoords(coords: Iterable<ChunkCoord>): number[] {
  return [...coords].map((c) => chunkKey(c.cx, c.cy));
}

// ------------------------------------------------------------------
// "x,y" 字符串键（World 内部给 featureLeft / harvestCd 用的键）解析
// ------------------------------------------------------------------

/**
 * "x,y" → {x, y}。**唯一**解析入口（2026-10-06）。
 *
 * 为什么值得单独立一个函数：v3 World 用模板串 `${x},${y}` 做键（archive 参考实现
 * 用的是数字编码，但两者等价且字符串版可读性更好）。要按区块筛这些键就必须能把
 * 字符串解析回坐标，而 `k.split(',')` 这种写法一旦散落到多处，又会变成
 * "17 处各自实现"的老问题——所以收口。
 *
 * 注意负坐标：`-3,7` 解析出 x=-3（不是 3），split(',') 天然正确，
 * 但**不能用 `Number(k)` 或 `k % width`** 之类的捷径，那才是旧坑。
 */
export function parseTileKey(key: string): { x: number; y: number } {
  const i = key.indexOf(',');
  if (i < 0) return { x: 0, y: 0 };
  const x = Number(key.slice(0, i));
  const y = Number(key.slice(i + 1));
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/** 坐标 → "x,y"（与 parseTileKey 配对的唯一编码入口） */
export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * "x,y" 字符串键 → 它所属的 chunkKey（唯一入口）。
 *
 * 为什么值得单独立一个函数（2026-10-08 chunk 维度拆分）：这个组合此前藏在
 * world.ts 的两个私有函数里（`featureChunksKeyOf` / `harvestChunksKeyOf`，后者
 * 只是前者的转发），属于**区块几何**而不是世界状态。区块索引模块（sim/chunk-index.ts）
 * 也需要它，若各写一份就回到"每处一份解码"的老坑（本文件头部已记录 17 处内联
 * `%` 各自出错的教训）。收口成唯一入口后，`parseTileKey` + `tileChunkKey` 的组合
 * 只存在一处。
 */
export function tileKeyChunk(tileKeyStr: string): number {
  const { x, y } = parseTileKey(tileKeyStr);
  return tileChunkKey(x, y).key;
}