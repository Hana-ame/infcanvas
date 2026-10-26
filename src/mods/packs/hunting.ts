/**
 * hunting 包 —— 被动动物 + 视野外生成 + 狩猎卡 + 猎物尸体拖回屠宰材料链（R3-3）。
 */
import type { ModPack } from '../pack';
import { K_STOCK_MEAT, K_STOCK_HERB, SER_HUNT } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, Hostile } from '../../sim/types';
import type { Sim } from '../../sim/sim';
import { getSimCameraViewport, spawnWildAnimalOutsideView } from '../../sim/rimworld-ecology-butcher';

export const huntingPack: ModPack = {
  id: 'hunting',
  requires: [],
  apply(m) {
    m.registerEnemy({ id: 'rabbit', name: '野兔', hp: 8, dmg: 0, speed: 5.5, atkCd: 99, passive: true, drops: { [K_STOCK_MEAT]: 1 } });
    m.registerEnemy({ id: 'deer', name: '鹿', hp: 22, dmg: 0, speed: 4.2, atkCd: 99, passive: true, drops: { [K_STOCK_MEAT]: 2, [K_STOCK_HERB]: 1 } });

    m.registerSystemDef({
      id: 'hunting',
      category: 'raid',
      ctor: (ctx: SimContext) => ({
        id: 'hunting',
        update(dt) {
          tickSpawn(ctx, dt);
          const leaving: number[] = [];
          for (const h of ctx.hostiles()) {
            const def = ctx.tuning.enemies[h.kind];
            if (!def?.passive) continue;
            tickAnimal(ctx, h, def, dt, leaving);
          }
          for (const id of leaving) {
            ctx.despawnHostile(id);
            ctx.log('野兽悻悻离去了');
          }
        },
      }),
    });

    m.registerCard({
      id: 'hunt',
      label: '狩猎',
      series: SER_HUNT,
      weight: 6,
      duration: 6,
      condition: (p, ctx) => wantHunt(p, ctx),
      action(p, ctx) {
        hunt(p, ctx);
      },
    });
  },
};

function wantHunt(p: PawnState, ctx: SimContext): boolean {
  const r = ctx.tuning.hunting.huntMagnetRadius;
  return findNearestPassive(p, ctx, r) !== null;
}

function hunt(p: PawnState, ctx: SimContext): void {
  const t = ctx.tuning.hunting;
  const target = findNearestPassive(p, ctx, t.huntMagnetRadius);
  if (!target) {
    ctx.finishCard(p);
    return;
  }
  if (ctx.adjacent(p, target.pos.x, target.pos.y, t.huntWorkRadius)) {
    p.path = [];
    if (p.atkCd <= 0) {
      const mul = ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1;
      ctx.damageHostile(target.id, Math.round(ctx.tuning.pawn.dmg * mul));
      p.atkCd = ctx.tuning.pawn.atkCd;
    }
    return;
  }
  if (!ctx.setPath(p, Math.round(target.pos.x), Math.round(target.pos.y))) {
    ctx.finishCard(p);
  }
}

function tickSpawn(ctx: SimContext, dt: number): void {
  const t = ctx.tuning.hunting;
  let acc = (ctx.scratch['hunting.spawnAcc'] ?? 0) + dt;
  if (acc < t.spawnIntervalSec) {
    ctx.scratch['hunting.spawnAcc'] = acc;
    return;
  }
  acc -= t.spawnIntervalSec;
  let count = 0;
  for (const h of ctx.hostiles()) {
    if (ctx.tuning.enemies[h.kind]?.passive) count++;
  }
  if (count < t.maxAnimals) {
    trySpawnAnimal(ctx);
  }
  ctx.scratch['hunting.spawnAcc'] = acc;
}

/**
 * 尝试刷一只野生小动物：
 *  - 在 RimWorld 模式（或存在活跃视口）下，强制在玩家视野与摄像机视口之外生成（小动物要在视野外生成），随后漫步进入草场；
 *  - 在传统基线测试模式下保持原算法以确保 golden 指纹一致。
 */
function trySpawnAnimal(ctx: SimContext): boolean {
  const maybeSim = ctx as Partial<Sim>;
  if (maybeSim.playerRimWorldMode || (maybeSim.world && getSimCameraViewport(maybeSim as Sim) !== null)) {
    return spawnWildAnimalOutsideView(maybeSim as Sim) !== null;
  }

  const t = ctx.tuning.hunting;
  const camp = campAnchor(ctx);
  if (!camp) return false;
  const ang = ctx.rng() * Math.PI * 2;
  const dist = t.spawnRadius * (0.5 + ctx.rng() * 0.5);
  let sx = Math.round(camp.x + Math.cos(ang) * dist);
  let sy = Math.round(camp.y + Math.sin(ang) * dist);
  for (let r = 0; r <= 40 && !ctx.passable(sx, sy); r++) {
    for (let dy = -r; dy <= r && !ctx.passable(sx, sy); dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (ctx.passable(sx + dx, sy + dy)) {
          sx += dx;
          sy += dy;
          break;
        }
      }
    }
  }
  if (!ctx.passable(sx, sy)) return false;
  const kinds = ['rabbit', 'deer'];
  const kind = kinds[Math.floor(ctx.rng() * kinds.length)];
  ctx.spawnHostile(kind, sx, sy);
  return true;
}

function tickAnimal(ctx: SimContext, h: Hostile, def: { name: string; speed: number; passive?: boolean }, dt: number, leaving: number[]): void {
  const t = ctx.tuning.hunting;
  const lastHp = ctx.scratch[`hunting.lastHp.${h.id}`] ?? h.maxHp;
  if (h.hp < lastHp) {
    ctx.scratch[`hunting.fleeDist.${h.id}`] = 0;
  }
  ctx.scratch[`hunting.lastHp.${h.id}`] = h.hp;

  const fleeDist = ctx.scratch[`hunting.fleeDist.${h.id}`] ?? 0;
  if (fleeDist < t.fleeRadius) {
    const nearPawn = nearestPawn(ctx, h);
    if (nearPawn) {
      const remaining = t.fleeRadius - fleeDist;
      const budget = Math.min(def.speed * dt, remaining);
      const dx = h.pos.x - nearPawn.pos.x;
      const dy = h.pos.y - nearPawn.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = h.pos.x + (dx / d) * budget;
      const ny = h.pos.y + (dy / d) * budget;
      if (ctx.passable(Math.round(nx), Math.round(ny))) {
        h.pos.x = nx;
        h.pos.y = ny;
        ctx.scratch[`hunting.fleeDist.${h.id}`] = fleeDist + budget;
      } else {
        const sx = (dx / d) * budget;
        const sy = (dy / d) * budget;
        if (ctx.passable(Math.round(h.pos.x + sx), Math.round(h.pos.y))) {
          h.pos.x += sx;
          ctx.scratch[`hunting.fleeDist.${h.id}`] = fleeDist + Math.abs(sx);
        } else if (ctx.passable(Math.round(h.pos.x), Math.round(h.pos.y + sy))) {
          h.pos.y += sy;
          ctx.scratch[`hunting.fleeDist.${h.id}`] = fleeDist + Math.abs(sy);
        }
      }
    } else {
      ctx.scratch[`hunting.fleeDist.${h.id}`] = t.fleeRadius;
    }
  }
  if ((ctx.scratch[`hunting.fleeDist.${h.id}`] ?? 0) >= t.fleeRadius) {
    wanderStep(ctx, h, def, dt);
  }

  const camp = campAnchor(ctx);
  if (camp) {
    const distToCamp = Math.hypot(h.pos.x - camp.x, h.pos.y - camp.y);
    const maybeSim = ctx as Partial<Sim>;
    const maxLeaveR = maybeSim.playerRimWorldMode ? Math.max(t.leaveRadius, 56) : t.leaveRadius;
    if (distToCamp > maxLeaveR) {
      let ratNearby = false;
      for (const p of ctx.pawns()) {
        if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= t.huntMagnetRadius) {
          ratNearby = true;
          break;
        }
      }
      if (!ratNearby) {
        leaving.push(h.id);
        delete ctx.scratch[`hunting.lastHp.${h.id}`];
        delete ctx.scratch[`hunting.fleeDist.${h.id}`];
      }
    }
  }
}

function wanderStep(ctx: SimContext, h: Hostile, def: { speed: number }, dt: number): void {
  const t = ctx.tuning.hunting;
  const ang = ctx.rng() * Math.PI * 2;
  const dist = t.wanderStepMin + ctx.rng() * (t.wanderStepMax - t.wanderStepMin);
  let tx = h.pos.x + Math.cos(ang) * dist;
  let ty = h.pos.y + Math.sin(ang) * dist;

  // 在 RimWorld 模式下，视野外生成的野生动物会自然向水草丰美的营地外围漫步迁徙
  const maybeSim = ctx as Partial<Sim>;
  if (maybeSim.playerRimWorldMode) {
    const camp = campAnchor(ctx);
    if (camp) {
      const dCamp = Math.hypot(camp.x - h.pos.x, camp.y - h.pos.y);
      if (dCamp > 20) {
        tx += ((camp.x - h.pos.x) / dCamp) * 1.2;
        ty += ((camp.y - h.pos.y) / dCamp) * 1.2;
      }
    }
  }

  stepTowardPassable(ctx, h.pos, { x: tx, y: ty }, def.speed * dt);
}

function stepTowardPassable(ctx: SimContext, pos: { x: number; y: number }, to: { x: number; y: number }, budget: number): void {
  const dx = to.x - pos.x;
  const dy = to.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return;
  const t = Math.min(1, budget / d);
  const nx = pos.x + dx * t;
  const ny = pos.y + dy * t;
  if (ctx.passable(Math.round(nx), Math.round(ny))) {
    pos.x = nx;
    pos.y = ny;
    return;
  }
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const stepX = sx * Math.min(Math.abs(dx), budget);
  const stepY = sy * Math.min(Math.abs(dy), budget);
  if (stepX !== 0 && ctx.passable(Math.round(pos.x + stepX), Math.round(pos.y))) {
    pos.x += stepX;
  } else if (stepY !== 0 && ctx.passable(Math.round(pos.x), Math.round(pos.y + stepY))) {
    pos.y += stepY;
  }
}

function findNearestPassive(p: PawnState, ctx: SimContext, maxR: number): Hostile | null {
  let best: Hostile | null = null;
  let bestD = maxR;
  for (const h of ctx.hostiles()) {
    if (!ctx.tuning.enemies[h.kind]?.passive) continue;
    const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
    if (d <= bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

function nearestPawn(ctx: SimContext, h: Hostile): PawnState | null {
  let best: PawnState | null = null;
  let bestD = Infinity;
  for (const p of ctx.pawns()) {
    const d = Math.hypot(p.pos.x - h.pos.x, p.pos.y - h.pos.y);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function campAnchor(ctx: SimContext): { x: number; y: number } | null {
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const p of ctx.pawns()) {
    cx += p.pos.x;
    cy += p.pos.y;
    n++;
  }
  if (n === 0) {
    for (const b of ctx.buildingsAll()) {
      if (b.defId === 'campfire') return { x: b.pos.x, y: b.pos.y };
    }
    return null;
  }
  cx /= n;
  cy /= n;
  const fire = ctx.nearestBuildingByTag('fire', cx, cy);
  return fire ? { x: fire.pos.x, y: fire.pos.y } : { x: cx, y: cy };
}
