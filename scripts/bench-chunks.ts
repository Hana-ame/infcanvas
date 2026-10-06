/**
 * scripts/bench-chunks.ts —— 分区块同步的**实测读数**（line/net 2026-10-06）。
 *
 * 为什么要有这个脚本：本轮的性能声明（"带宽降了 X%"）必须有可复现的数字，
 * 而本地 CPU 被别的任务占用、不能跑长基准。所以把它做成**远端 CI job**
 * （.github/workflows/ci.yml 的 bench-chunks job），每次推送都出一份读数。
 *
 * 测什么（两个维度，都给绝对值，不只给百分比）：
 *  1. **带宽**：同一世界规模下，chunked 与非 chunked 的 delta 字节数对比。
 *     做法：不跑真网络，而是用真实的 game-server 下发逻辑算出消息 JSON 长度——
 *     因为带宽的决定因素是**消息大小**（ws 帧头差异对结论无影响），
 *     且这样能排除网络抖动，测的是"协议本身省了多少"。
 *  2. **tick 耗时**：admitted=全集 vs admitted=稀疏集合的每 tick 耗时。
 *     这是分帧模拟侧的收益证据。
 *
 * 输出格式刻意做成 CI 友好的 `key=value` 行（既能被人读，也能被 grep 断言）。
 */
import { Sim } from '../src/sim/index';
import { ModRegistry } from '../src/mods/index';
import { CHUNK_SIZE, chunkKey, chunksForInterest } from '../src/shared/chunks';

// ------------------------------------------------------------------
// 世界规模：把建筑撒在多远的范围里，决定了"全世界 vs 视口"的差距
// ------------------------------------------------------------------
/**
 * 撒建筑的区块跨度（3 = 3×3 块；9 = 9×9 块 = 576×576 的中局）。
 *
 * ⚠️ 这段被 CI 实测推翻过两次，值得把过程留着：
 *
 * **第一版（撒在出生点附近）**：读数 buildings=0.5、reduction=0.0%。
 * 真因不是裁剪无效，而是撒的建筑**几乎全被拆了** —— `building` 玩法包里有
 * 「木材耗尽就烧建筑当燃料」的逻辑（packs/building.ts:86-90，取第一个
 * 带 fuelSec 的建筑拆掉）。世界里篝火越多，鼠越倾向于拆篝火，烧完 30s 只剩 0.5 座。
 * 报错还指不到真因（"放不下"/"放上了又没了"都像地形问题）。
 *
 * **第二版（撒在远处 (12,12) 区块）**：更糟 —— 直接撞上守卫断言
 * 「建筑被拆过半（3/36）」。远不等于安全：**鼠群会去捡燃料**，而篝火
 * 在整个世界里都是同一种可烧目标，藏到哪都可能被拆。
 *
 * **所以最终版：基准不跑带玩法的世界。**
 * 分块收益的本质是「实体数 × 同步范围」的乘积，与玩法无关；
 * 把玩法（拆建筑、采集）掺进基准，测到的就是玩法的时间噪声，不是裁剪率。
 * 故这里**不调 sim.run()**：只 step 一小段产生 pawn 移动，建筑保持静态。
 * 这不是"回避现实"——现实里 delta 的 buildings 字段本来就是每帧重发的
 * **当前**列表，玩法不会让它变小，只会让整份存档在两个跑之间不可比。
 */
function seedBuildings(sim: Sim, spread: number): number {
  const world = sim.world;
  let n = 0;
  // 以出生点为原点向外铺：与真实局地一致（玩家在自己周围盖东西）
  for (let cy = 0; cy < spread; cy++) {
    for (let cx = 0; cx < spread; cx++) {
      let placed = 0;
      for (let y = cy * CHUNK_SIZE + 2; placed < 4 && y < cy * CHUNK_SIZE + 62; y += 3) {
        for (let x = cx * CHUNK_SIZE + 2; placed < 4 && x < cx * CHUNK_SIZE + 62; x += 3) {
          if (world.addBuilding('campfire', x, y)) placed++;
        }
      }
      n += placed;
    }
  }
  return n;
}

interface BandwidthSample {
  bytes: number;
  buildings: number;
  pawns: number;
}

/**
 * 造一条 delta 消息，量它的字节数。
 *
 * 这里**直接复刻 game-server 里 deltaTimer 的组装逻辑**（同一套裁剪函数），
 * 而不是起真服务器——理由：带宽取决于消息大小，起 socket 只会引入噪声。
 * 但为避免"复刻一份、日后漂移"，裁剪取自 world 的同一批 API
 * （buildingsInChunks），组装形状与 game-server delta 的字段顺序一致。
 */
function measureDelta(
  sim: Sim,
  scope: Set<number> | null,
  prevPawnJson: Map<string, string>,
): BandwidthSample {
  const changedPawns: unknown[] = [];
  const currentIds = new Set<string>();
  for (const p of sim.pawns()) {
    const id = String(p.eid);
    currentIds.add(id);
    if (scope !== null && !scope.has(chunkKeyOf(p.pos.x, p.pos.y)) && !sim.selected.includes(p.eid)) {
      prevPawnJson.delete(id);
      continue;
    }
    const json = JSON.stringify(p);
    if (prevPawnJson.get(id) === json) continue;
    prevPawnJson.set(id, json);
    changedPawns.push(p);
  }
  const removedPawns: number[] = [];
  for (const id of [...prevPawnJson.keys()]) {
    if (!currentIds.has(id)) removedPawns.push(Number(id));
    prevPawnJson.delete(id);
  }
  const hostiles =
    scope === null ? sim.hostiles() : sim.hostiles().filter((h) => scope.has(chunkKeyOf(h.pos.x, h.pos.y)));
  const buildings = scope === null ? [...sim.world.buildings.values()] : sim.world.buildingsInChunks(scope);
  const msg = {
    t: 'delta',
    d: {
      time: sim.time,
      stockpile: { ...sim.stockpile },
      pawns: changedPawns,
      removedPawns,
      hostiles,
      buildings,
      newEvents: [],
    },
  };
  return { bytes: JSON.stringify(msg).length, buildings: buildings.length, pawns: changedPawns.length };
}

function chunkKeyOf(x: number, y: number): number {
  return chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------
function main(): void {
  const registry = ModRegistry.default();
  console.log('=== bench: 分区块同步（line/net）===');

  // 视口中心 = 出生点。r=192 是**半径（tile）**，换算成块是 ceil(192/64)=3 格半径
  // → 实测覆盖 7×7=49 块。
  //
  // ⚠️ 坑记在这里：第一版注释写"r=192 → 3×3 块"，**是我算错了**。
  // 读数里 view_chunks=49 当场把它纠正。后果：小世界（3×3=9 块）整个落在
  // 视口内，裁剪率必然 0% —— 那个 0.0% 不是"裁剪无效"，而是**视口比世界还大，
  // 本来就无可裁**。这个 0.0% 保留下来作为读数（它正好说明了收益取决于
  // 视口/世界之比），但必须在读数旁写清楚，否则会被误读成"优化没用"。

  for (const spread of [3, 9]) {
    const sim = new Sim({ seed: 20260821, registry });
    const buildings = seedBuildings(sim, spread);
    // 放不下建筑 = 基准作废。**报 0% 比报错更坏**：0% 看着像"优化无效"，
    // 实际是场景没搭起来（首轮 CI 就是这么骗人的，教训在 seedBuildings 注释里）。
    if (buildings === 0) throw new Error(`spread=${spread} 下没放上任何建筑，读数无意义`);
    // 只 step 不 run：见 seedBuildings 的注释（玩法会拆建筑，掺进来测的是噪声）。
    // 建筑数此时**必然稳定**，无需再断言存活比例 —— 上一版的存活断言正是因为
    // 跑错了 sim.run 才需要，它是症状不是防线，删掉免得误导后人。

    // 视口 r=192（实测 7×7=49 块，见上方换算坑记）
    const viewScope = new Set(chunksForInterest({ x: 0, y: 0, r: 192 }));
    const remoteAll = new Set<number>();
    for (let cy = 0; cy < spread; cy++) {
      for (let cx = 0; cx < spread; cx++) {
        remoteAll.add(chunkKey(cx, cy));
      }
    }

    // --- 带宽：30 帧 delta 平均字节 ---
    // 每条"连接"各持一份 pawn 基准（这就是真实语义：prevPawnJson 是 per-ctx 的）。
    const fullBase = new Map<string, string>();
    const chunkBase = new Map<string, string>();
    const fullBytes: number[] = [];
    const chunkedBytes: number[] = [];
    const fullBld: number[] = [];
    const chunkBld: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      sim.step(0.1);
      const f = measureDelta(sim, null, fullBase);
      const c = measureDelta(sim, viewScope, chunkBase);
      fullBytes.push(f.bytes);
      chunkedBytes.push(c.bytes);
      fullBld.push(f.buildings);
      chunkBld.push(c.buildings);
    }

    const fAvg = avg(fullBytes);
    const cAvg = avg(chunkedBytes);
    const reduction = fAvg > 0 ? (1 - cAvg / fAvg) * 100 : 0;
    console.log(`--- world spread=${spread} (${spread}x${spread} chunks @ origin), buildings=${buildings}, view_chunks=${viewScope.size} ---`);
    console.log(`bandwidth_delta_bytes.full_avg=${fAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.chunked_avg=${cAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.reduction_pct=${reduction.toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.full_avg=${avg(fullBld).toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.chunked_avg=${avg(chunkBld).toFixed(1)}`);
    // 可解释性检查：裁剪侧不小于全量侧，只有在**视口覆盖了整个世界**时才正常。
    // 分开报而不是笼统 WARN，因为这两种情况含义完全相反：
    //  · 视口 ⊇ 世界 → 0% 是**正确读数**（无可裁），不是缺陷；
    //  · 视口 ⊂ 世界仍 0% → 基准失真（要么 scope 没生效，要么两边都空）。
    const coversAll = viewScope.size >= remoteAll.size;
    console.log(`bandwidth_view_covers_world=${coversAll ? 1 : 0}`);
    if (!coversAll && avg(chunkBld) >= avg(fullBld) && avg(fullBld) > 0) {
      console.log(
        `WARN spread=${spread}: 视口未覆盖全世界(${viewScope.size}<${remoteAll.size}) 但裁剪侧建筑数` +
          `(${avg(chunkBld).toFixed(1)}) 未低于全量侧(${avg(fullBld).toFixed(1)}) —— 基准失真，读数不可信`,
      );
    }
  }

  // --- tick 耗时：admitted 全集 vs 稀疏 ---
  //
  // ⚠️ 首轮读数是 sparse(0.0275) > null(0.0247) —— **分片反而"更慢"**。
  // 原因诚实记录：当时世界里只有出生点 4 只鼠（一个区块内），而 dense 集合
  // 用 -16..16 的方框正好覆盖它们，所以"跳过的块"里**一只鼠都没有**，
  // 分片每 tick 只多付了一次 Set 查表的常数开销 → 必然略慢。
  // 结论：分片的收益只与"被跳过的区块里有多少实体"成正比，与实体数无关。
  //
  // 所以这里的场景必须把鼠**分散**到多块，否则测的仍是常数开销而非真实收益。
  // 做法：直接 spawnPawn 到远端各块（不走玩法引导，纯粹构造分布）。
  {
    const makeSim = (): Sim => {
      const s = new Sim({ seed: 20260821, registry });
      // 分散 24 只鼠到 3×3 的 9 个块（出生点为心，避开安全区那一块）
      let n = 0;
      for (let cy = 1; cy <= 3; cy++) {
        for (let cx = 1; cx <= 3; cx++) {
          for (let k = 0; k < 3 && n < 24; k++) {
            s.spawnPawn(cx * CHUNK_SIZE + 4 + k * 9, cy * CHUNK_SIZE + 4 + k * 9);
            n++;
          }
        }
      }
      // 同样不调 run()：分片收益与玩法无关，掺进玩法只会加噪声
      s.step(0.1);
      return s;
    };
    const base = makeSim();
    console.log(`--- tick cost: pawns=${[...base.pawns()].length} ---`);

    const dense = new Set<number>(); // 全集 = 不跳任何鼠
    for (let cy = -2; cy <= 6; cy++) for (let cx = -2; cx <= 6; cx++) dense.add(chunkKey(cx, cy));
    const sparse = new Set(chunksForInterest({ x: 0, y: 0, r: 32 })); // 只处理中心一块

    const timeIt = (admitted: Set<number> | null, ticks: number): number => {
      const s = makeSim();
      const t0 = performance.now();
      for (let i = 0; i < ticks; i++) s.stepChunked(0.1, admitted);
      return (performance.now() - t0) / ticks;
    };
    const denseMs = timeIt(dense, 200);
    const sparseMs = timeIt(sparse, 200);
    const nullMs = timeIt(null, 200);
    console.log('--- tick cost (ms/tick, 200 ticks) ---');
    console.log(`tick_ms.dense_admitted=${denseMs.toFixed(4)}`);
    console.log(`tick_ms.sparse_admitted=${sparseMs.toFixed(4)}`);
    console.log(`tick_ms.null_admitted=${nullMs.toFixed(4)}`);
    const speedup = denseMs > 0 ? denseMs / Math.max(sparseMs, 1e-9) : 0;
    console.log(`tick_ms.sparse_speedup_x=${speedup.toFixed(2)}`);
  }

  console.log('=== bench done ===');
}

main();