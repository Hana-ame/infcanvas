// 快照 diff（P2 tick delta）：对比相邻两份全量快照 → 产出最小变化 DeltaMsg
// 纯函数、零 DOM，可单测。身份对齐：pawn 按 eid、建筑按 key（y*width+x）。
// 比较原则：标量/小对象（needs/faith/desires/skills/slots/全局）变了整体带；
// hostiles 数量少整体覆盖；buildQueue/stockpile 小对象整体覆盖。
import type { SnapshotMsg, DeltaMsg } from '../shared/protocol';

const sameNum = (a: number | undefined, b: number | undefined): boolean => a === b || (a === undefined && b === undefined) || (Number.isNaN(a) && Number.isNaN(b));

export function buildDelta(prev: SnapshotMsg | null, cur: SnapshotMsg): DeltaMsg | null {
  if (!prev) return fullDelta(cur);
  const d: DeltaMsg = { type: 'delta', t: cur.t };
  let any = false;

  const setGlobal = (k: 'paused' | 'speed' | 'isNight' | 'day', v: unknown): void => {
    if ((prev as unknown as Record<string, unknown>)[k] !== v) { (d as unknown as Record<string, unknown>)[k] = v; any = true; }
  };
  setGlobal('paused', cur.paused);
  setGlobal('speed', cur.speed);
  setGlobal('isNight', cur.isNight);
  setGlobal('day', cur.day);
  if (prev.weather.raining !== cur.weather.raining || prev.weather.temperature !== cur.weather.temperature) { d.weather = cur.weather; any = true; }
  if (!sameObj(prev.stockpile, cur.stockpile)) { d.stockpile = cur.stockpile; any = true; }

  // ---- pawns：按 eid 对齐，逐字段 diff ----
  const prevPawns = new Map(prev.pawns.map((p) => [p.eid, p]));
  const curPawns = new Map(cur.pawns.map((p) => [p.eid, p]));
  const pawns: NonNullable<DeltaMsg['pawns']> = [];
  for (const p of cur.pawns) {
    const old = prevPawns.get(p.eid);
    if (!old) { pawns.push({ eid: p.eid, x: p.x, y: p.y, attrs: p.attrs, hp: p.hp, maxHp: p.maxHp, job: p.job, needs: p.needs, faith: p.faith, skills: p.skills, traits: p.traits, maxSlots: p.maxSlots, slots: p.slots, desires: p.desires, lastDecision: p.lastDecision }); any = true; continue; }
    const pd: NonNullable<DeltaMsg['pawns']>[number] = { eid: p.eid };
    let ch = false;
    if (old.x !== p.x || old.y !== p.y) { pd.x = p.x; pd.y = p.y; ch = true; }
    if (!sameNum(old.hp, p.hp)) { pd.hp = p.hp; ch = true; }
    if (!sameNum(old.maxHp, p.maxHp)) { pd.maxHp = p.maxHp; ch = true; }
    if (old.job !== p.job) { pd.job = p.job; ch = true; }
    if (old.assignedJob !== p.assignedJob) { pd.assignedJob = p.assignedJob; ch = true; }
    if (!sameObj(old.needs, p.needs)) { pd.needs = p.needs; ch = true; }
    if (!sameNum(old.faith, p.faith)) { pd.faith = p.faith; ch = true; }
    if (!sameObj(old.skills, p.skills)) { pd.skills = p.skills; ch = true; }
    if (!sameArr(old.traits, p.traits)) { pd.traits = p.traits; ch = true; }
    if (!sameNum(old.maxSlots, p.maxSlots)) { pd.maxSlots = p.maxSlots; ch = true; }
    if (!sameArr(old.slots, p.slots)) { pd.slots = p.slots; ch = true; }
    if (!sameObj(old.desires, p.desires)) { pd.desires = p.desires; ch = true; }
    if (!sameObj(old.lastDecision, p.lastDecision)) { pd.lastDecision = p.lastDecision; ch = true; }
    if (ch) { pawns.push(pd); any = true; }
  }
  for (const eid of prevPawns.keys()) {
    if (!curPawns.has(eid)) { pawns.push({ eid, removed: true }); any = true; }
  }
  if (pawns.length) { d.pawns = pawns; any = true; }
  const listChanged = prev.pawns.length !== cur.pawns.length || prev.pawns.some((p, i) => p.eid !== cur.pawns[i]?.eid);
  if (listChanged) { d.pawnList = cur.pawns.map((p) => p.eid); any = true; }

  // ---- hostiles：整体覆盖（数量少）----
  if (!sameArr(prev.hostiles, cur.hostiles)) { d.hostiles = cur.hostiles; any = true; }

  // ---- buildings：按 key 对齐 diff hp；增删整条 ----
  // 建筑身份 key = x + y*1000000（世界尺寸远小于 1000000，保证唯一；与协议/客户端 key 语义一致）
  const prevB = new Map(prev.buildings.map((b) => [b.x + b.y * 1000000, b]));
  const curB = new Map(cur.buildings.map((b) => [b.x + b.y * 1000000, b]));
  const bds: NonNullable<DeltaMsg['buildings']> = [];
  for (const [key, b] of curB) {
    const old = prevB.get(key);
    if (!old) { bds.push({ key, defId: b.defId, hp: b.hp, maxHp: b.maxHp, faction: b.faction, footprint: b.footprint }); any = true; }
    else if (old.hp !== b.hp || old.defId !== b.defId || old.faction !== b.faction) { bds.push({ key, defId: b.defId, hp: b.hp, maxHp: b.maxHp, faction: b.faction, footprint: b.footprint }); any = true; }
  }
  for (const key of prevB.keys()) {
    if (!curB.has(key)) { bds.push({ key, defId: '', hp: 0, maxHp: 0, faction: '', footprint: [], removed: true }); any = true; }
  }
  if (bds.length) { d.buildings = bds; any = true; }
  if (prev.buildingVersion !== cur.buildingVersion) { d.buildingVersion = cur.buildingVersion; any = true; }
  if (!sameArrKey(prev.buildQueue, cur.buildQueue)) { d.buildQueue = cur.buildQueue; any = true; }

  return any ? d : null;
}

// 首份快照（无 prev）：整份作为 delta 发出（client 端按 delta 应用也能收敛）
function fullDelta(s: SnapshotMsg): DeltaMsg {
  const d: DeltaMsg = { type: 'delta', t: s.t };
  for (const k of ['paused', 'speed', 'isNight', 'day'] as const) (d as unknown as Record<string, unknown>)[k] = s[k];
  d.weather = s.weather;
  d.stockpile = s.stockpile;
  d.pawns = s.pawns.map((p) => ({ ...p, attrs: p.attrs }));
  d.pawnList = s.pawns.map((p) => p.eid);
  d.hostiles = s.hostiles;
  d.buildings = s.buildings.map((b) => ({ key: b.x + b.y * 1000000, defId: b.defId, hp: b.hp, maxHp: b.maxHp, faction: b.faction, footprint: b.footprint })); // key 同 buildDelta：x + y*1000000
  d.buildingVersion = s.buildingVersion;
  d.buildQueue = s.buildQueue;
  return d;
}

function sameObj(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}
function sameArr(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const A = a as unknown[];
  const B = b as unknown[];
  if (A.length !== B.length) return false;
  return A.every((v, i) => sameObj(v, B[i]));
}
function sameArrKey(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify((a as unknown[]).map((v) => JSON.stringify(v))) === JSON.stringify((b as unknown[]).map((v) => JSON.stringify(v)));
}