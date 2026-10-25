/**
 * npc-bases.ts —— 无限地图成簇矿脉生成（Coherent Vein Generation）与野生 NPC 据点系统（Friendly / Hostile Settlements）。
 *
 * 矿脉与野生草药生成逻辑重构：
 *  1. 矿脉 (`steel_ore` / `gold_ore` / `jade_ore` / `stone_chunk`)：
 *     - 摒弃原先每格独立随机哈希导致的杂色散点；
 *     - 采用 5×5 矿脉簇晶核（Vein Cluster Core）+ 距离衰减与平滑噪声，使同一条矿脉内的相连矿石格保持同一种矿物类型，形成 RimWorld 原版自然的成片矿脉带（3~9 格连片矿床），主要分布在岩体 (`stone`) 与山麓边缘；
 *  2. 野生药草 (`herb_plant`)：
 *     - 按湿度与肥力成簇分布在湿润草地 (`grass` + 高湿度簇)，不再孤立乱刷。
 */
import { hash2 } from './rng';
import type { Eid, Pos } from './types';
import type { Sim } from './sim';
import type { World } from './world';

export type MineralKind = 'steel_ore' | 'gold_ore' | 'jade_ore' | 'stone_chunk' | 'herb_plant';

export interface MineralHit {
  x: number;
  y: number;
  kind: MineralKind;
  name: string;
  yieldItem: 'ore' | 'gold' | 'jade' | 'stone' | 'herb';
  amount: number;
  color: string;
}

export interface NpcBase {
  id: string;
  name: string;
  factionName: string;
  xenotype: 'ratkin' | 'ratkin_vanguard' | 'feral_marauder' | 'baseliner';
  attitude: 'friendly' | 'hostile' | 'neutral';
  reputation: number; // -100..100
  pos: Pos;
  hp: number;
  maxHp: number;
  garrisonCount: number;
  turretCount: number;
  lootStock: Record<string, number>;
  tradeOffers: { giveItem: string; giveQty: number; takeItem: string; takeQty: number; label: string }[];
  defeated: boolean;
}

const SALT_VEIN_SPAWN = 0x6641;
const SALT_VEIN_KIND = 0x6642;
const SALT_VEIN_SHAPE = 0x6643;
const SALT_HERB_PATCH = 0x6644;

const MINERAL_META: Record<
  MineralKind,
  { name: string; yieldItem: MineralHit['yieldItem']; amount: number; color: string }
> = {
  steel_ore: { name: '富集钢铁矿脉 (Compacted Steel)', yieldItem: 'ore', amount: 8, color: '#b57c4e' },
  gold_ore: { name: '原生金矿脉 (Gold Ore)', yieldItem: 'gold', amount: 5, color: '#e6be44' },
  jade_ore: { name: '翡翠晶石矿 (Jade Vein)', yieldItem: 'jade', amount: 4, color: '#45c486' },
  stone_chunk: { name: '花岗岩脉 (Granite Rock)', yieldItem: 'stone', amount: 10, color: '#8d9298' },
  herb_plant: { name: '野生草药丛 (Wild Healroot)', yieldItem: 'herb', amount: 4, color: '#58b89c' },
};

const minedDepleted = new WeakMap<World, Set<string>>();

function getDepletedSet(world: World): Set<string> {
  let s = minedDepleted.get(world);
  if (!s) {
    s = new Set<string>();
    minedDepleted.set(world, s);
  }
  return s;
}

/** 标记指定格的矿物或野生草药已被开采或被建筑替代 */
export function depleteMineralAt(world: World, ix: number, iy: number): void {
  const x = Math.round(ix);
  const y = Math.round(iy);
  getDepletedSet(world).add(`${x},${y}`);
}

/**
 * 查询无限地图坐标 (x, y) 处的矿物或野生药草。
 * 采用 RimWorld 矿脉簇晶核算法：连片矿脉内的矿石格同属一种矿产，自然镶嵌在岩石地貌与山体边缘。
 */
export function mineralAt(world: World, ix: number, iy: number): MineralHit | null {
  const x = Math.round(ix);
  const y = Math.round(iy);
  if (Math.abs(x - world.spawn.x) <= 6 && Math.abs(y - world.spawn.y) <= 6) return null;
  if (getDepletedSet(world).has(`${x},${y}`)) return null;
  if (world.buildingAt(x, y)) return null;
  if (world.featureAt(x, y) || world.treeBlockAt(x, y)) return null;

  const tile = world.tileAt(x, y);
  if (tile === 'water') return null;
  const z = world.zAt(x, y);
  // 不可通行的深层实心高山内部不刷地表矿点（山麓边缘 z < 3 可刷出露矿脉）
  if (tile === 'stone' && z >= 3) return null;

  // 1. 矿脉晶核簇判定（以 5×5 区块为晶核网格，计算到最近矿脉中心的椭球距离）
  const cellSize = 5;
  const gx = Math.floor(x / cellSize);
  const gy = Math.floor(y / cellSize);
  const veinRoll = hash2(gx, gy, SALT_VEIN_SPAWN);
  const kindRoll = hash2(gx, gy, SALT_VEIN_KIND);
  const shapeJitter = hash2(x, y, SALT_VEIN_SHAPE);

  // 晶核中心在 5×5 网格内的偏移
  const centerX = gx * cellSize + 1 + Math.floor(hash2(gx, gy, 0x6645) * 3);
  const centerY = gy * cellSize + 1 + Math.floor(hash2(gx, gy, 0x6646) * 3);
  const dx = x - centerX;
  const dy = y - centerY;
  // 沿矿脉走向拉伸的椭球距离
  const angle = hash2(gx, gy, 0x6647) * Math.PI;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const rx = dx * cosA + dy * sinA;
  const ry = -dx * sinA + dy * cosA;
  const veinDist = Math.hypot(rx * 0.72, ry * 1.18) + (shapeJitter - 0.5) * 0.65;

  const nearMountain =
    (world.tileAt(x + 1, y) === 'stone' && world.zAt(x + 1, y) >= 3) ||
    (world.tileAt(x - 1, y) === 'stone' && world.zAt(x - 1, y) >= 3) ||
    (world.tileAt(x, y + 1) === 'stone' && world.zAt(x, y + 1) >= 3) ||
    (world.tileAt(x, y - 1) === 'stone' && world.zAt(x, y - 1) >= 3);

  if (tile === 'stone' || nearMountain) {
    // 岩石地层或山体脚下：按矿脉晶核生成连片同质矿床
    const radius = veinRoll < 0.42 ? 2.45 : veinRoll < 0.72 ? 1.75 : 0;
    if (radius > 0 && veinDist <= radius) {
      const kind: MineralKind =
        kindRoll < 0.48
          ? 'steel_ore'
          : kindRoll < 0.76
            ? 'stone_chunk'
            : kindRoll < 0.91
              ? 'gold_ore'
              : 'jade_ore';
      const meta = MINERAL_META[kind];
      return { x, y, kind, ...meta };
    }
  } else if (tile === 'dirt') {
    // 裸露旱土层：仅在稀有富矿晶核中心生成小型紧凑钢铁/金矿露头（2~4格连片，绝不单格乱撒）
    if (veinRoll < 0.16 && veinDist <= 1.35) {
      const kind: MineralKind = kindRoll < 0.78 ? 'steel_ore' : 'gold_ore';
      const meta = MINERAL_META[kind];
      return { x, y, kind, ...meta };
    }
  } else if (tile === 'grass') {
    // 湿润肥沃草地：野生草药丛按生态群落（6×6 药草园簇）成片生长
    const hx = Math.floor(x / 6);
    const hy = Math.floor(y / 6);
    const patchRoll = hash2(hx, hy, SALT_HERB_PATCH);
    const moist = world.moist(x, y);
    if (patchRoll < 0.34 && moist > 0.42 && shapeJitter < 0.16) {
      const meta = MINERAL_META.herb_plant;
      return { x, y, kind: 'herb_plant', ...meta };
    }
  }
  return null;
}

/** 开采指定坐标处的矿物或药草并入库 */
export function mineMineralAt(sim: Sim, eid: Eid | null, x: number, y: number): { ok: boolean; item?: string; gained?: number; name?: string } {
  const m = mineralAt(sim.world, x, y);
  if (!m) return { ok: false };
  getDepletedSet(sim.world).add(`${m.x},${m.y}`);
  const pawn = eid !== null ? sim.pawn(eid) : undefined;
  const skillBoost = pawn?.skills?.find((s) => s.id === 'mining_construct')?.level ?? 6;
  const gained = Math.max(1, Math.round(m.amount * (0.8 + skillBoost / 25)));
  sim.stockpile[m.yieldItem] = (sim.stockpile[m.yieldItem] ?? 0) + gained;
  sim.log(`⛏ ${pawn ? pawn.name : '殖民地'} 开采了 ${m.name}：+${gained} ${m.yieldItem}`);
  return { ok: true, item: m.yieldItem, gained, name: m.name };
}

const simBasesMap = new WeakMap<Sim, Map<string, NpcBase>>();

/** 获取或初始化当前世界的野生 NPC 据点表（含 Friendly 与 Hostile 据点） */
export function getNpcBases(sim: Sim): Map<string, NpcBase> {
  let map = simBasesMap.get(sim);
  if (map) return map;
  map = new Map<string, NpcBase>();
  simBasesMap.set(sim, map);

  const initialBases: NpcBase[] = [
    {
      id: 'base_acorn_bazaar',
      name: '橡果鼠鼠集市 (Acorn Ratkin Bazaar)',
      factionName: '橡果商盟 (Acorn Trade Guild)',
      xenotype: 'ratkin',
      attitude: 'friendly',
      reputation: 65,
      pos: { x: 28, y: -22 },
      hp: 450,
      maxHp: 450,
      garrisonCount: 6,
      turretCount: 2,
      lootStock: { food: 40, meal: 25, herb: 18, wood: 50, ore: 20, gold: 15 },
      tradeOffers: [
        { giveItem: 'wood', giveQty: 10, takeItem: 'meal', takeQty: 6, label: '10 木材 → 6 精致熟食' },
        { giveItem: 'ore', giveQty: 8, takeItem: 'herb', takeQty: 6, label: '8 钢铁矿 → 6 草药包' },
        { giveItem: 'gold', giveQty: 4, takeItem: 'components', takeQty: 4, label: '4 黄金 → 4 精密零件' },
      ],
      defeated: false,
    },
    {
      id: 'base_birch_sanctuary',
      name: '白桦林鼠卫据点 (Birchvale Vanguard Outpost)',
      factionName: '白桦皇家鼠卫 (Birchvale Order)',
      xenotype: 'ratkin_vanguard',
      attitude: 'friendly',
      reputation: 45,
      pos: { x: -32, y: 26 },
      hp: 600,
      maxHp: 600,
      garrisonCount: 8,
      turretCount: 3,
      lootStock: { meal: 30, herb: 24, ore: 35, components: 10 },
      tradeOffers: [
        { giveItem: 'food', giveQty: 12, takeItem: 'ore', takeQty: 8, label: '12 浆果 → 8 钢铁矿' },
        { giveItem: 'wood', giveQty: 15, takeItem: 'herb', takeQty: 8, label: '15 木材 → 8 草药包' },
      ],
      defeated: false,
    },
    {
      id: 'base_redclaw_camp',
      name: '赤爪掠夺者营地 (Redclaw Marauder Camp)',
      factionName: '赤爪狂鼠帮 (Redclaw Raiders)',
      xenotype: 'feral_marauder',
      attitude: 'hostile',
      reputation: -75,
      pos: { x: 36, y: 30 },
      hp: 380,
      maxHp: 380,
      garrisonCount: 5,
      turretCount: 1,
      lootStock: { ore: 30, gold: 18, meal: 16, herb: 10, wood: 25 },
      tradeOffers: [],
      defeated: false,
    },
    {
      id: 'base_rustfang_fort',
      name: '锈牙海盗要塞 (Rustfang Pirate Stronghold)',
      factionName: '锈牙荒野海盗 (Rustfang Pirates)',
      xenotype: 'feral_marauder',
      attitude: 'hostile',
      reputation: -90,
      pos: { x: -38, y: -34 },
      hp: 550,
      maxHp: 550,
      garrisonCount: 7,
      turretCount: 3,
      lootStock: { ore: 45, gold: 32, components: 12, meal: 24, herb: 15 },
      tradeOffers: [],
      defeated: false,
    },
  ];

  for (const b of initialBases) {
    map.set(b.id, b);
    sim.world.clearFeaturesInRect(b.pos.x - 2, b.pos.y - 2, b.pos.x + 2, b.pos.y + 2);
  }
  return map;
}

/** 按区块探索动态发现远方野生 NPC 据点（无限地图扩展） */
export function discoverChunkOutposts(sim: Sim, cx: number, cy: number): NpcBase | null {
  if (Math.abs(cx) <= 1 && Math.abs(cy) <= 1) return null;
  const bases = getNpcBases(sim);
  const id = `base_chunk_${cx}_${cy}`;
  if (bases.has(id)) return bases.get(id)!;
  const h = hash2(cx, cy, 0x8844);
  if (h > 0.18) return null;
  const friendly = hash2(cx, cy, 0x8845) < 0.5;
  const bx = cx * 64 + 32;
  const by = cy * 64 + 32;
  const base: NpcBase = {
    id,
    name: friendly ? `远征鼠鼠驿站 (${cx},${cy})` : `荒野匪鼠前哨 (${cx},${cy})`,
    factionName: friendly ? '自由鼠商团' : '荒野劫掠团',
    xenotype: friendly ? 'ratkin' : 'feral_marauder',
    attitude: friendly ? 'friendly' : 'hostile',
    reputation: friendly ? 50 : -70,
    pos: { x: bx, y: by },
    hp: 400,
    maxHp: 400,
    garrisonCount: friendly ? 5 : 4,
    turretCount: 1,
    lootStock: { ore: 25, gold: 12, meal: 15, herb: 10 },
    tradeOffers: friendly
      ? [{ giveItem: 'wood', giveQty: 10, takeItem: 'meal', takeQty: 6, label: '10 木材 → 6 熟食' }]
      : [],
    defeated: false,
  };
  bases.set(id, base);
  return base;
}

/** 与友好 NPC 据点进行贸易 */
export function tradeWithNpcBase(
  sim: Sim,
  baseId: string,
  offerIndex = 0,
): { ok: boolean; message: string } {
  const bases = getNpcBases(sim);
  const b = bases.get(baseId);
  if (!b) return { ok: false, message: '未找到指定据点' };
  if (b.attitude === 'hostile') return { ok: false, message: `${b.name} 处于敌对状态，拒绝贸易！` };
  const offer = b.tradeOffers[offerIndex] ?? b.tradeOffers[0];
  if (!offer) return { ok: false, message: '该据点暂无可用贸易订单' };
  if ((sim.stockpile[offer.giveItem] ?? 0) < offer.giveQty) {
    return { ok: false, message: `库存不足：需要 ${offer.giveQty} ${offer.giveItem}` };
  }
  sim.stockpile[offer.giveItem] -= offer.giveQty;
  sim.stockpile[offer.takeItem] = (sim.stockpile[offer.takeItem] ?? 0) + offer.takeQty;
  b.reputation = Math.min(100, b.reputation + 5);
  const msg = `🤝 与【${b.name}】完成贸易：交付 ${offer.giveQty} ${offer.giveItem}，换得 ${offer.takeQty} ${offer.takeItem}（声望 ${b.reputation}）`;
  sim.log(msg);
  return { ok: true, message: msg };
}

/** 向 NPC 据点赠送礼物提升派系好感 */
export function giftNpcBase(
  sim: Sim,
  baseId: string,
  giftItem = 'wood',
  giftQty = 10,
): { ok: boolean; message: string } {
  const b = getNpcBases(sim).get(baseId);
  if (!b) return { ok: false, message: '未找到指定据点' };
  if ((sim.stockpile[giftItem] ?? 0) < giftQty) {
    return { ok: false, message: `赠送失败：需要 ${giftQty} ${giftItem}` };
  }
  sim.stockpile[giftItem] -= giftQty;
  b.reputation = Math.min(100, b.reputation + 18);
  if (b.reputation >= 15 && b.attitude === 'hostile') {
    b.attitude = 'friendly';
    b.tradeOffers = [{ giveItem: 'wood', giveQty: 10, takeItem: 'meal', takeQty: 6, label: '10 木材 → 6 熟食' }];
  }
  const msg = `🎁 向【${b.name}】赠送 ${giftQty} ${giftItem}，声望升至 ${b.reputation}（当前态度：${b.attitude}）`;
  sim.log(msg);
  return { ok: true, message: msg };
}

/** 呼叫友好据点的皇家鼠卫援军空投助战 */
export function requestAllyReinforcements(sim: Sim, baseId: string): { ok: boolean; message: string } {
  const b = getNpcBases(sim).get(baseId);
  if (!b) return { ok: false, message: '未找到指定据点' };
  if (b.attitude !== 'friendly' || b.reputation < 30) {
    return { ok: false, message: `需要与【${b.name}】保持友好且声望 ≥ 30 才能呼叫援军` };
  }
  b.reputation -= 15;
  for (const h of [...sim.hostiles()]) {
    sim.damageHostile(h.id, 35);
  }
  sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + 6;
  sim.stockpile['herb'] = (sim.stockpile['herb'] ?? 0) + 4;
  const msg = `🎺 【${b.name}】派遣鼠卫火枪队空投驰援！对全场敌军造成 35 点火力压制并空投 +6 熟食 +4 草药`;
  sim.log(msg);
  return { ok: true, message: msg };
}

/** 组织远征队进攻敌对据点，攻克后缴获全套丰厚战利品 */
export function assaultNpcBase(sim: Sim, baseId: string): { ok: boolean; defeated: boolean; message: string } {
  const b = getNpcBases(sim).get(baseId);
  if (!b) return { ok: false, defeated: false, message: '未找到指定据点' };
  if (b.defeated) return { ok: false, defeated: true, message: `${b.name} 已被攻克` };

  b.attitude = 'hostile';
  b.reputation = -100;
  const pawnPower = Math.max(1, [...sim.pawns()].length) * 28;
  b.hp = Math.max(0, b.hp - pawnPower);

  if (b.hp <= 0) {
    b.defeated = true;
    b.garrisonCount = 0;
    const lootSummary: string[] = [];
    for (const [k, v] of Object.entries(b.lootStock)) {
      sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
      lootSummary.push(`+${v} ${k}`);
    }
    const msg = `🏆 攻克敌对据点【${b.name}】！缴获战利品：${lootSummary.join(' ')}`;
    sim.log(msg);
    return { ok: true, defeated: true, message: msg };
  }

  const msg = `⚔ 远征猛攻【${b.name}】造成 ${pawnPower} 伤害（据点剩余城防 ${b.hp}/${b.maxHp}）`;
  sim.log(msg);
  return { ok: true, defeated: false, message: msg };
}
