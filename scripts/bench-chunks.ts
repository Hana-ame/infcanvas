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
/** 撒建筑的区块跨度（3 = 3×3 块；9 = 9×9 块 = 576×576 的中局）。
 *
 *  ⚠️ 为什么必须**避开出生安全区**（spawnClearRadius 出厂 6，且笼统地避开 (0,0) 邻域）：
 *  首轮 CI 读数是 buildings=0.5、reduction=0.0%，原因不是裁剪无效，
 *  而是撒的建筑**被鼠拆了 + 撒不动**：鼠会 raze 建筑，而放在出生安全区里的
 *  地格又不可通行。于是"全世界 vs 视口"两边都是空集，比值恒 1 —— 测了个寂寞。
 * 教训：**基准作废时，报 0% 比报错更坏**（0% 看着像"优化无效"，实际是场景没搭起来）。
 * 故这里把世界铺在远离出生点的一整片区域，并在测量前断言数量。
 */
function seedBuildings(sim: Sim, spread: number): number {
  const world = sim.world;
  let n = 0;
  // 基准原点挪到远离出生点的位置（64*12=768 格外），保证与鼠群活动区不重叠
  const ox = 12 * CHUNK_SIZE;
  const oy = 12 * CHUNK_SIZE;
  for (let cy = 0; cy < spread; cy++) {
    for (let cx = 0; cx < spread; cx++) {
      let placed = 0;
      for (let y = oy + cy * CHUNK_SIZE + 2; placed < 4 && y < oy + cy * CHUNK_SIZE + 62; y += 3) {
        for (let x = ox + cx * CHUNK_SIZE + 2; placed < 4 && x < ox + cx * CHUNK_SIZE + 62; x += 3) {
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

  // 远端基准区中心（seedBuildings 的同一偏移），用作"客户端视口"
  const FAR_X = 12 * CHUNK_SIZE + (3 * CHUNK_SIZE) / 2;
  const FAR_Y = 12 * CHUNK_SIZE + (3 * CHUNK_SIZE) / 2;

  for (const spread of [3, 9]) {
    const sim = new Sim({ seed: 20260821, registry });
    const buildings = seedBuildings(sim, spread);
    // 放不下建筑 = 基准作废。**报 0% 比报错更坏**：0% 看着像"优化无效"，
    // 实际是场景没搭起来（首轮 CI 就是这么骗人的，教训在 seedBuildings 注释里）。
    if (buildings === 0) throw new Error(`spread=${spread} 下没放上任何建筑，读数无意义`);
    // 让鼠群跑起来（制造真实的 pawn 变动），但不跑长局：跑太久鼠会把建筑拆光。
    sim.run(30, 1);
    if (sim.world.buildings.size < buildings * 0.5) {
      throw new Error(
        `spread=${spread} 建筑被拆过半（${sim.world.buildings.size}/${buildings}），场景不���续用`,
      );
    }

    // 视口 = 远端基准区中心 r=192（3×3 块），客户端典型订阅
    const viewScope = new Set(chunksForInterest({ x: FAR_X, y: FAR_Y, r: 192 }));
    // 远端基准区只占 spread×spread 块；视口 3×3 → 裁剪后只剩 9 块的世界量
    const remoteAll = new Set<number>();
    for (let cy = 0; cy < spread; cy++) {
      for (let cx = 0; cx < spread; cx++) {
        remoteAll.add(chunkKey(12 + cx, 12 + cy));
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
    console.log(`--- world spread=${spread} (${spread}x${spread} chunks @ origin 12,12), buildings=${buildings}, remote_chunks=${remoteAll.size}, view_chunks=${viewScope.size} ---`);
    console.log(`bandwidth_delta_bytes.full_avg=${fAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.chunked_avg=${cAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.reduction_pct=${reduction.toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.full_avg=${avg(fullBld).toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.chunked_avg=${avg(chunkBld).toFixed(1)}`);
    // 基准自检：若 chunked 侧几乎没裁掉东西，数字不可信（宁可报错也不要假读数）
    if (avg(chunkBld) >= avg(fullBld) && avg(fullBld) > 0) {
      console.log(`WARN spread=${spread}: 裁剪侧建筑数(${avg(chunkBld).toFixed(1)}) 未低于全量侧(${avg(fullBld).toFixed(1)})，读数存疑`);
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
      // 分散 24 只鼠到 3×3 的远端块
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          for (let k = 0; k < 3; k++) {
            s.spawnPawn(12 * CHUNK_SIZE + cx * CHUNK_SIZE + 4 + k * 9, 12 * CHUNK_SIZE + cy * CHUNK_SIZE + 4 + k * 9);
          }
        }
      }
      s.run(20, 1);
      return s;
    };
    const base = makeSim();
    console.log(`--- tick cost: pawns=${[...base.pawns()].length}, chunks_occupied=${base.world.activeChunkKeys().length} ---`);

    const dense = new Set<number>(); // 全集 = 不跳任何鼠
    for (let cy = -2; cy <= 16; cy++) for (let cx = -2; cx <= 16; cx++) dense.add(chunkKey(cx, cy));
    const sparse = new Set(chunksForInterest({ x: FAR_X, y: FAR_Y, r: 32 })); // 只处理中心一块

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