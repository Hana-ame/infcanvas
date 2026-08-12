// P1 server 骨架（DESIGN §5/§8）：Node 复用 src/sim 跑权威模拟，WSS 广播快照/事件
// P2 增量：500ms 一轮 diff 只发变化（tick delta）；5s 一次全量兜底对账；新连接先收全量
// 启动：npx tsx src/server/index.ts [port] [seed] [pawns]
// 客户端：?remote=ws://127.0.0.1:8080
import { WebSocketServer, WebSocket } from 'ws';
import { Sim } from '../sim/sim';
import { ModRegistry } from '../sim/mods/registry';
import { loadModsFromDir } from './modManager';
import { makeDummyCardPlanner } from './dummyLlm';
import type { Command } from '../sim/sim';
import { makeLlmProvider } from './llm';
import { buildDelta } from './diff';
import { validateCommand, allowRate, type CmdGuardState } from './cmdValidate';
import type { ClientMsg, ServerMsg, SnapshotMsg, WelcomeMsg, EventMsg } from '../shared/protocol';

const PORT = Number(process.argv[2] ?? 8080);
const SEED = Number(process.argv[3] ?? 20260803);
const PAWNS = Number(process.argv[4] ?? 4);
const TICK_HZ = 20;
const MODS_DIR = process.env.MODS_DIR ?? 'mods'; // 根目录 mods/*.mod.json 包自动挂载
const DELTA_MS = 500;        // 增量轮询
const RECONCILE_MS = 5000;   // 全量对账间隔

// 神谕慢决策层：完全可由随机抽卡替代（默认即启用，零成本零 API）
//  - 默认：feedback 随机抽卡（策略卡 + 科技卡），LLM 组件的完整替代
//  - LLM_DUMMY=random：纯随机抽卡；LLM_DUMMY=feedback：按局面反馈抽卡（默认）
//  - LLM_ENDPOINT：可选真 LLM 事件导演（OpenAI 兼容；不设也能完整运行）
const llmCfg = process.env.LLM_ENDPOINT
  ? { endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY ?? '', model: process.env.LLM_MODEL ?? 'gpt-4o-mini' }
  : null;
const dummyMode = (process.env.LLM_DUMMY === 'random' ? 'random' : 'feedback') as 'random' | 'feedback';

// 权威模拟（零 DOM ✓ tsx 直跑）。
// 注意：llm 预热在 sim 构造前发出首个请求（worldSummary 拿不到 ctx → 用开局提示），
// sim 就绪后后续请求才带真实世界摘要 —— 故 sim 用 let 声明
let sim: Sim;
const llm = llmCfg ? makeLlmProvider(llmCfg, () => sim ?? null) : null;
// 服务端 mod 管理器：先挂载 mods/ 下所有包，再交给 Sim（mod 一致进入卡池/世界/装配表）
const registry = ModRegistry.default();
const modRes = loadModsFromDir(MODS_DIR, registry);
if (!modRes.ok) {
  console.error(`[server] mod 加载失败：\n${modRes.errors.join('\n')}`);
  process.exit(1);
}
sim = new Sim({
  seed: SEED, pawnCount: PAWNS, tickHz: TICK_HZ,
  registry,
  eventProvider: llm?.provider,
});
// 随机抽卡 = LLM 组件的完整替代（默认启用；LLM_ENDPOINT 仅为可选增强）
const dummyPlanner = makeDummyCardPlanner(sim, { mode: dummyMode });
console.log(`[server] seed=${SEED} pawns=${PAWNS} ws://0.0.0.0:${PORT} 神谕抽卡=${dummyMode}${llmCfg ? ` llm=${llmCfg.endpoint}（可选增强）` : '（LLM 已由随机抽卡替代）'}${modRes.mods.length ? ` mods=[${modRes.mods.join(', ')}]` : '（无 mod）'}`);

const wss = new WebSocketServer({ port: PORT });

let nextClient = 1;
const clients = new Map<number, WebSocket>();

function sendTo(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg): void {
  for (const ws of clients.values()) sendTo(ws, msg);
}

// 全量广播：同时把它作为 diff 基线（广播出去的快照 = 所有 client 的共同真实状态）
function broadcastSnapshot(): SnapshotMsg {
  lastSnap = buildSnapshot();
  broadcast(lastSnap);
  return lastSnap;
}

// tile 增量：采集/事件改地形 → 立即推送（不占快照带宽）
sim.addTileListener((x, y, tileId) => {
  const msg: EventMsg = { type: 'event', t: sim.time, events: [{ kind: 'tileChanged', x, y, tileId }] };
  broadcast(msg);
});

function buildWelcome(clientId: number): WelcomeMsg {
  const w = sim.world;
  const tiles: WelcomeMsg['tiles'] = {};
  for (const [id, d] of Object.entries(sim.mods.tiles)) {
    tiles[id] = { id, color: d.color, passable: d.passable, buildable: d.buildable, emoji: d.emoji, sprite: d.sprite };
  }
  const buildings: WelcomeMsg['buildings'] = {};
  for (const [id, d] of Object.entries(sim.mods.buildings)) {
    buildings[id] = { id, name: d.name, size: d.size, color: d.color, emoji: d.emoji, passable: d.passable, hp: d.hp, costWood: d.costWood, costOre: d.costOre };
  }
  const items: WelcomeMsg['items'] = {};
  for (const [id, d] of Object.entries(sim.mods.items)) items[id] = { id, name: d.name };
  const t = sim.tuning;
  return {
    type: 'welcome', you: clientId, seed: SEED, tickHz: TICK_HZ, dayLength: sim.dayLength,
    tuning: {
      needs: { foodMoodLow: t.needs.foodMoodLow },
      faction: { unitCapChurch: t.faction.unitCapChurch, unitCapCampfire: t.faction.unitCapCampfire },
      env: { dayLength: t.env.dayLength, baseTemp: t.env.baseTemp },
    },
    world: { width: w.width, height: w.height },
    tiles, buildings, items,
    tileGrid: w.serializeTiles(),
  };
}

function buildSnapshot(): SnapshotMsg {
  const w = sim.world;
  const pawns: SnapshotMsg['pawns'] = [];
  for (const eid of sim.pawns) {
    const p = sim.pawnProfile(eid);
    const pos = sim.pawnPositions.get(eid);
    const hk = sim.healthOf(eid);
    if (!p || !pos) continue;
    pawns.push({
      eid,
      x: pos.x, y: pos.y,
      hp: hk?.hp ?? 0, maxHp: hk?.maxHp ?? 1,
      job: p.job, assignedJob: p.assignedJob,
      needs: p.needs ?? undefined,
      faith: p.faith,
      attrs: {
        str: p.dna.str, con: p.dna.con, siz: p.dna.siz, dex: p.dna.dex,
        int: p.dna.int, pow: p.dna.pow, app: p.dna.app, edu: p.dna.edu,
      },
      skills: { ...p.skills },
      traits: p.dna.traits,
      maxSlots: p.dna.maxSlots,
      slots: p.slots.filter((c) => c !== null).map((c) => ({ id: c!.id, name: c!.name })),
      desires: p.desires,
      lastDecision: p.lastDecision ? { drawn: p.lastDecision.drawn, picked: p.lastDecision.picked, time: p.lastDecision.time } : undefined,
    });
  }
  const hostiles: SnapshotMsg['hostiles'] = sim.hostiles.map((h, i) => ({
    i, enemyId: h.enemyId, x: h.x, y: h.y, hp: h.hp, maxHp: h.maxHp, faction: h.faction,
  }));
  const buildings: SnapshotMsg['buildings'] = [];
  for (const [key, b] of w.buildings) {
    const x = key % w.width;
    const y = Math.floor(key / w.width);
    buildings.push({
      defId: b.def.id, x, y, hp: Math.round(b.hp), maxHp: b.def.hp, faction: b.faction,
      footprint: w.footprintOf(x, y).map((f) => ({ x: f.x, y: f.y })),
    });
  }
  return {
    type: 'snapshot', t: sim.time, paused: sim.paused, speed: sim.speed, isNight: sim.isNight(),
    day: Math.floor(sim.time / sim.dayLength) + 1,
    weather: { raining: sim.env.raining, temperature: sim.env.temperature },
    stockpile: { ...sim.stockpile },
    pawns, hostiles, buildings,
    buildQueue: sim.buildQueueItems.map((b) => ({ x: b.x, y: b.y, defId: b.defId })),
    buildingVersion: w.buildingVersion,
  };
}

wss.on('connection', (ws, req) => {
  const clientId = nextClient++;
  clients.set(clientId, ws);
  // 命令频率守卫（每 client 独立令牌桶）
  const guard: CmdGuardState = { lastCmdAt: Date.now(), budget: 30 };
  console.log(`[server] +client #${clientId} (${req.socket.remoteAddress})`);
  sendTo(ws, buildWelcome(clientId));
  // 新连接：先收全量底（welcome 只含 defs/tile，动态世界靠这份快照）
  const snap = lastSnap ?? buildSnapshot();
  lastSnap = snap;
  sendTo(ws, snap);

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type !== 'cmd') return;
    // 权威校验（形状/范围/pawnId/频率）：非法命令丢弃（记录），不踢连接
    const v = validateCommand(sim, msg.cmd, guard, Date.now());
    if (!v.ok) {
      console.warn(`[server] cmd rejected (#${clientId}): ${v.reason}`);
      return;
    }
    try {
      sim.issueCommand(msg.cmd);
      console.log('[server] cmd', msg.cmd);
    } catch (e) { console.warn('[server] cmd rejected:', (e as Error).message); }
  });
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[server] - #${clientId}`);
  });
});

// 主循环：固定步进（accumulator，不随帧率漂移）+ tick delta 增量 + 定期全量对账 + feed 增量推送
// 轮询间隔 10ms：实际步进节奏由 tickMs accumulator 决定（与轮询频率解耦）；无 client 在线时仅跑 sim 不广播
const tickMs = 1000 / TICK_HZ;
let acc = 0;
let last = Date.now();
let lastFeedCount = 0;
let lastSnap: SnapshotMsg | null = null;
let lastDeltaAt = Date.now();
let lastReconcile = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(100, now - last);
  last = now;
  acc += dt;
  while (acc >= tickMs) {
    sim.step(tickMs / 1000);
    dummyPlanner?.tick(tickMs / 1000); // dummy 印卡（LLM 慢决策占位）
    acc -= tickMs;
  }
  if (clients.size === 0) return;
  // feed 增量（logEvent 文本流，含 LLM 事件叙述）
  if (sim.events.length > lastFeedCount) {
    const fresh = sim.events.slice(lastFeedCount);
    lastFeedCount = sim.events.length;
    const msg: EventMsg = { type: 'event', t: sim.time, events: fresh.map((e) => ({ kind: 'feed', text: e.text })) };
    broadcast(msg);
  }
  // 增量：500ms 一轮，只发变化
  if (now - lastDeltaAt >= DELTA_MS) {
    const cur = buildSnapshot();
    const delta = buildDelta(lastSnap, cur);
    lastSnap = cur;
    lastDeltaAt = now;
    if (delta) broadcast(delta);
  }
  // 全量对账：5s 一次，防增量丢失/相消累积偏差
  if (now - lastReconcile >= RECONCILE_MS) {
    lastReconcile = now;
    broadcastSnapshot();
  }
}, 10);

process.on('SIGINT', () => { console.log('\n[server] bye'); process.exit(0); });
