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
/** 撒建筑的区块跨度（3 = 3×3 块 = 192×192 tile 的小世界；9 = 576×576 的中局） */
function seedBuildings(sim: Sim, spread: number): number {
  const world = sim.world;
  let n = 0;
  for (let cy = 0; cy < spread; cy++) {
    for (let cx = 0; cx < spread; cx++) {
      // 每块放 4 座。**必须遍历找可落格而不是写死坐标**：addBuilding 遇地形
      // 不可通行返回 null，写死坐标等于赌那格是草地——首轮 CI 就因为这个
      // 报出"放不下"，而报错信息完全指不到真因（见 chunk-index.test.ts 同款注释）。
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

  for (const spread of [3, 9]) {
    const sim = new Sim({ seed: 20260821, registry });
    const buildings = seedBuildings(sim, spread);
    // 放不下建筑 = 基准作废（裁剪率会显示成 0%，比报错更坏：假数据）。
    // 教训来自 line/perf 那轮"首轮 CI 六组读数其实是同一组"的事故。
    if (buildings === 0) throw new Error(`spread=${spread} 下没放上任何建筑，读数无意义`);
    // 跑一段让世界"活起来"（有鼠在动、有敌袭），否则 delta 全是静态
    sim.run(120, 1);

    // 视口 = 出生点附近 r=192（3×3 块），这是真实客户端的典型订阅
    const viewScope = new Set(chunksForInterest({ x: 0, y: 0, r: 192 }));

    // --- 带宽：跑 30 帧 delta，取平均字节 ---
    const fullBytes: number[] = [];
    const chunkedBytes: number[] = [];
    const fullBld: number[] = [];
    const chunkBld: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      sim.step(0.1);
      fullBytes.push(measureDelta(sim, null, new Map()).bytes);
      chunkedBytes.push(measureDelta(sim, viewScope, new Map()).bytes);
      fullBld.push(measureDelta(sim, null, new Map()).buildings);
      chunkBld.push(measureDelta(sim, viewScope, new Map()).buildings);
    }

    const fAvg = avg(fullBytes);
    const cAvg = avg(chunkedBytes);
    const reduction = fAvg > 0 ? (1 - cAvg / fAvg) * 100 : 0;
    console.log(`bandwidth_delta_bytes.full_avg=${fAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.chunked_avg=${cAvg.toFixed(1)}`);
    console.log(`bandwidth_delta_bytes.reduction_pct=${reduction.toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.full_avg=${avg(fullBld).toFixed(1)}`);
    console.log(`bandwidth_delta_buildings.chunked_avg=${avg(chunkBld).toFixed(1)}`);
  }

  // --- tick 耗时：admitted 全集 vs 稀疏 ---
  {
    const sim = new Sim({ seed: 20260821, registry });
    seedBuildings(sim, 9);
    sim.run(60, 1);
    const dense = new Set<number>(); // 全集 = 不跳
    for (let cy = -16; cy <= 16; cy++) for (let cx = -16; cx <= 16; cx++) dense.add(chunkKey(cx, cy));
    const sparse = new Set(chunksForInterest({ x: 0, y: 0, r: 64 })); // 小视口

    const timeIt = (admitted: Set<number> | null, ticks: number): number => {
      const s = new Sim({ seed: 20260821, registry });
      seedBuildings(s, 9);
      s.run(60, 1);
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