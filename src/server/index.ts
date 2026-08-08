// P1 server 骨架（DESIGN §5/§8）：Node 复用 src/sim 跑权威模拟，WSS 广播快照/事件
// 启动：npx tsx src/server/index.ts [port] [seed] [pawns]
// 客户端：?remote=ws://127.0.0.1:8080
import { WebSocketServer, WebSocket } from 'ws';
import { Sim } from '../sim/sim';
import type { Command } from '../sim/sim';
import { makeLlmProvider } from './llm';
import type { ClientMsg, ServerMsg, SnapshotMsg, WelcomeMsg, EventMsg } from '../shared/protocol';

const PORT = Number(process.argv[2] ?? 8080);
const SEED = Number(process.argv[3] ?? 20260803);
const PAWNS = Number(process.argv[4] ?? 4);
const TICK_HZ = 20;

// LLM 慢决策层（P1）：设 LLM_ENDPOINT 即启用（OpenAI 兼容 chat completions），否则确定性脚本
const llmCfg = process.env.LLM_ENDPOINT
  ? { endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY ?? '', model: process.env.LLM_MODEL ?? 'gpt-4o-mini' }
  : null;

// 权威模拟（零 DOM ✓ tsx 直跑）。
// 注意：llm 预热在 sim 构造前发出首个请求（worldSummary 拿不到 ctx → 用开局提示），
// sim 就绪后后续请求才带真实世界摘要 —— 故 sim 用 let 声明
let sim: Sim;
const llm = llmCfg ? makeLlmProvider(llmCfg, () => sim ?? null) : null;
sim = new Sim({
  seed: SEED, pawnCount: PAWNS, tickHz: TICK_HZ,
  eventProvider: llm?.provider,
});
console.log(`[server] seed=${SEED} pawns=${PAWNS} ws://0.0.0.0:${PORT}${llmCfg ? ` llm=${llmCfg.endpoint}` : '（无 LLM，确定性事件）'}`);

const wss = new WebSocketServer({ port: PORT });

let nextClient = 1;
const clients = new Map<number, WebSocket>();

function sendTo(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg): void {
  for (const ws of clients.values()) sendTo(ws, msg);
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
  return {
    type: 'welcome', you: clientId, seed: SEED, tickHz: TICK_HZ,
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
  console.log(`[server] +client #${clientId} (${req.socket.remoteAddress})`);
  sendTo(ws, buildWelcome(clientId));

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === 'cmd' && looksLikeCommand(msg.cmd)) {
      try {
        sim.issueCommand(msg.cmd);
        console.log('[server] cmd', msg.cmd);
      } catch (e) { console.warn('[server] cmd rejected:', (e as Error).message); }
    }
  });
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[server] - #${clientId}`);
  });
});

function looksLikeCommand(c: unknown): c is Command {
  return typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string';
}

// 主循环：固定步进（accumulator，不随帧率漂移）+ 2Hz 快照 + feed 增量推送
const tickMs = 1000 / TICK_HZ;
let acc = 0;
let last = Date.now();
let lastFeedCount = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(100, now - last);
  last = now;
  acc += dt;
  while (acc >= tickMs) {
    sim.step(tickMs / 1000);
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
  if (now % 500 < 20) broadcast(buildSnapshot());
}, 10);

process.on('SIGINT', () => { console.log('\n[server] bye'); process.exit(0); });
