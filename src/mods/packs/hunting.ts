/**
 * hunting 包 —— 被动动物 + 狩猎卡 + 肉/草药材料链（R3-3）。
 *
 * 一切皆抽卡（原则①）：本包**没有**"猎人 AI"，也没有"鼠看到兔子就去追"的规则。
 * 狩猎是一张**卡**，进同一个卡池参与抽签；它为什么被抽中？靠 condition（附近有被动动物）
 * 和权重（6，与 cook 同量级）。没有任何"玩家指令"/策略卡/条件强插。
 *
 * 被动动物自驱 AI（系统，非卡）：
 *   动物不是抽卡驱动——它们没有卡池。它们的游荡/逃跑/出生/离场由本包注册的系统驱动，
 *   与 raid 包的 tickCats 同构。这不是"行为树"——它是最简动物智能（漫游 + 受击逃跑），
 *   不违反"一切皆抽卡"红线（红线约束的是鼠的行为，动物是环境元素）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 磁铁范式（照抄 social/farming/sleep/cooking 的既有正确写法，勿自创）----
 * ---------------------------------------------------------------------------------
 * hunt 卡的 condition 用 huntMagnetRadius（24 格）= "看得见，值得走过去"；
 * action 里若还没到 huntWorkRadius（2.0 格）内，就 setPath 走过去并 return。
 * ⚠ 与普通磁铁范式的关键区别：动物**会跑**，所以 action 必须**每 tick 重算路径**
 *   （不要只在 p.path 为空时算）——否则路径过时，鼠追不上。
 *   这是第 6 次踩坑的预判：前 5 次（chat/sow/harvest/sleep/cook）都是静态目标，
 *   路径一次算对就够；hunt 是唯一一个动态目标，必须每 tick 重算。
 *
 * 卸载语义（原则④）：不挂本包 → 无 rabbit/deer 敌人、无 hunt 卡、无 SER_HUNT 系列；
 *   tuning.hunting 仍在出厂表里但 needs.eat 用 ?? 0 访问 meatGain → 退化成纯生食，核心照跑。
 *
 * 数值：全部读 tuning.hunting / contracts 资源键（原则③），本文件零魔法数。
 */
import type { ModPack } from '../pack';
import { K_STOCK_MEAT, K_STOCK_HERB, SER_HUNT } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, Hostile } from '../../sim/types';

export const huntingPack: ModPack = {
  id: 'hunting',
  requires: [], // 不依赖任何包：只需要 needs 已登记的卡池 + contracts 的资源键
  apply(m) {
    // ---- 敌人数据表 ----
    // 野兔：快、脆、只掉肉。速度 5.5 > 鼠 4.5 = 单鼠追不上，需要多鼠配合或陷阱。
    // 鹿：慢、耐打、掉肉+草药——创造"狩猎→取草药→医疗"材料链（零内核改动）。
    m.registerEnemy({ id: 'rabbit', name: '野兔', hp: 8, dmg: 0, speed: 5.5, atkCd: 99, passive: true, drops: { [K_STOCK_MEAT]: 1 } });
    m.registerEnemy({ id: 'deer', name: '鹿', hp: 22, dmg: 0, speed: 4.2, atkCd: 99, passive: true, drops: { [K_STOCK_MEAT]: 2, [K_STOCK_HERB]: 1 } });

    // ---- 系统：被动动物自驱 AI（类别 raid，与 raid.tickCats 同层）----
    // 所有跨 tick 状态走 ctx.scratch（随档），键约定 "hunting.<名>"。
    // raid.tickCats 已跳过 passive 敌人（内核已扩展），本系统专管被动动物。
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
            if (!def?.passive) continue; // 掠食者由 raid.tickCats 管
            tickAnimal(ctx, h, def, dt, leaving);
          }
          for (const id of leaving) {
            ctx.despawnHostile(id);
            ctx.log('野兽悻悻离去了');
          }
        },
      }),
    });

    // ---- 卡：狩猎（磁铁范式 + 每 tick 重算路径）----
    // 基础权重 6：与 cook 同量级——狩猎是"有猎物时值得做"的事，不是日常。
    // duration 6：与 cook(6s)/砍树(6s) 同量纲，保证"追一段+打几拳"在卡期内完成。
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

/** 狩猎卡 condition：磁铁半径内有被动动物 = "看得见，值得走过去"。
 *  为什么用 magnetRadius 而非 workRadius：见文件头磁铁范式注释——
 *  用 workRadius(2.0) 会让 condition 常年 false（动物实际距离 >> 2 格），
 *  鼠永远抽不到 hunt 卡 = 死代码。 */
function wantHunt(p: PawnState, ctx: SimContext): boolean {
  const r = ctx.tuning.hunting.huntMagnetRadius;
  return findNearestPassive(p, ctx, r) !== null;
}

/** 狩猎卡 action：找最近被动动物 → 到位则打伤害 → 未到位则每 tick 重算路径。
 *
 *  ⚠ 每 tick 重算路径（动物在跑，不要只在 path 空时算）：
 *  普通磁铁范式（cook/sow/sleep）只在 path 为空时算一次路径，因为目标静止。
 *  但动物**每 tick 都在移动**——如果只在 path 空时算，路径会指向动物
 *  几秒前的位置，鼠追的是"幻影"。必须每 tick 重算，让路径始终指向动物当前位置。
 *
 *  找不到目标（被别的鼠杀了/跑远了）→ finishCard 收工，防恒真空转。 */
function hunt(p: PawnState, ctx: SimContext): void {
  const t = ctx.tuning.hunting;
  const target = findNearestPassive(p, ctx, t.huntMagnetRadius);
  if (!target) {
    ctx.finishCard(p);
    return;
  }
  // 到位：打伤害（用 tuning.pawn.dmg，与 fight 卡同量级）
  if (ctx.adjacent(p, target.pos.x, target.pos.y, t.huntWorkRadius)) {
    p.path = []; // 贴脸停走
    if (p.atkCd <= 0) {
      const mul = ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1;
      ctx.damageHostile(target.id, Math.round(ctx.tuning.pawn.dmg * mul));
      p.atkCd = ctx.tuning.pawn.atkCd;
    }
    return;
  }
  // 未到位：每 tick 重算路径（动物在跑）
  if (!ctx.setPath(p, Math.round(target.pos.x), Math.round(target.pos.y))) {
    ctx.finishCard(p); // 不可达：收工
  }
}

/** 动物出生：每隔 spawnIntervalSec 在营地外围 spawnRadius 内随机取落点刷一只。
 *  上限 maxAnimals 只限不刷——防止长局里动物堆积成"必死雪球"（与 raid 离场阀同理）。
 *  落点校验：只查 passable（与 raid.trySpawnCat 同策略），找不到就放弃本次。 */
function tickSpawn(ctx: SimContext, dt: number): void {
  const t = ctx.tuning.hunting;
  let acc = (ctx.scratch['hunting.spawnAcc'] ?? 0) + dt;
  if (acc < t.spawnIntervalSec) {
    ctx.scratch['hunting.spawnAcc'] = acc;
    return;
  }
  acc -= t.spawnIntervalSec;
  // 检查场上被动动物数量
  let count = 0;
  for (const h of ctx.hostiles()) {
    if (ctx.tuning.enemies[h.kind]?.passive) count++;
  }
  if (count < t.maxAnimals) {
    trySpawnAnimal(ctx);
  }
  ctx.scratch['hunting.spawnAcc'] = acc;
}

/** 尝试刷一只动物：在营地锚点外围 spawnRadius 内随机取落点。
 *  随机 kind：兔/鹿各半——鹿掉草药（材料链），兔纯肉（低门槛）。 */
function trySpawnAnimal(ctx: SimContext): boolean {
  const t = ctx.tuning.hunting;
  // 营地锚点 = 鼠群质心附近的火堆（与 raid.trySpawnCat 同款锚定逻辑）
  const camp = campAnchor(ctx);
  if (!camp) return false;
  const ang = ctx.rng() * Math.PI * 2;
  // 在 [spawnRadius*0.5, spawnRadius] 环带内取点：太近会被鼠直接踩到
  const dist = t.spawnRadius * (0.5 + ctx.rng() * 0.5);
  let sx = Math.round(camp.x + Math.cos(ang) * dist);
  let sy = Math.round(camp.y + Math.sin(ang) * dist);
  // 落点校验：螺旋搜索可立足格（与 raid.trySpawnCat 同策略）
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
  // 随机 kind：兔/鹿各半
  const kinds = ['rabbit', 'deer'];
  const kind = kinds[Math.floor(ctx.rng() * kinds.length)];
  ctx.spawnHostile(kind, sx, sy);
  return true;
}

/** 单只动物 AI：受击逃跑 → 游荡 → 离场检测。
 *
 *  受击检测：比较当前 HP 与上次记录的 HP。若 HP 下降 → 标记为"刚受击"，
 *  开始朝远离最近鼠的方向跑 fleeRadius 距离。跑完恢复游荡。
 *  为什么用 HP 比较而非事件回调：damageHostile 不产生事件，scratch 比较是唯一无侵入方案。
 */
function tickAnimal(ctx: SimContext, h: Hostile, def: { name: string; speed: number; passive?: boolean }, dt: number, leaving: number[]): void {
  const t = ctx.tuning.hunting;
  // ---- 受击检测 ----
  const lastHp = ctx.scratch[`hunting.lastHp.${h.id}`] ?? h.maxHp;
  if (h.hp < lastHp) {
    // HP 下降 = 刚被打，开始逃跑
    ctx.scratch[`hunting.fleeDist.${h.id}`] = 0;
  }
  ctx.scratch[`hunting.lastHp.${h.id}`] = h.hp;

  const fleeDist = ctx.scratch[`hunting.fleeDist.${h.id}`] ?? 0;
  if (fleeDist < t.fleeRadius) {
    // ---- 逃跑：朝远离最近鼠的方向跑 ----
    const nearPawn = nearestPawn(ctx, h);
    if (nearPawn) {
      // 剩余逃跑距离：本 tick 最多跑这么多（防一 tick 跑完整个 fleeRadius）
      const remaining = t.fleeRadius - fleeDist;
      const budget = Math.min(def.speed * dt, remaining);
      const dx = h.pos.x - nearPawn.pos.x;
      const dy = h.pos.y - nearPawn.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = h.pos.x + (dx / d) * budget;
      const ny = h.pos.y + (dy / d) * budget;
      // 带通行的直线移动（与 raid.stepTowardPassable 同策略）
      if (ctx.passable(Math.round(nx), Math.round(ny))) {
        h.pos.x = nx;
        h.pos.y = ny;
        ctx.scratch[`hunting.fleeDist.${h.id}`] = fleeDist + budget;
      } else {
        // 被地形挡住：滑轴（先 x 后 y）
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
      // 没鼠就不跑了（无目标可逃）：标记逃跑完成，恢复游荡
      ctx.scratch[`hunting.fleeDist.${h.id}`] = t.fleeRadius;
    }
  }
  // 没在逃（或刚逃完/无鼠可逃）→ 游荡
  if ((ctx.scratch[`hunting.fleeDist.${h.id}`] ?? 0) >= t.fleeRadius) {
    wanderStep(ctx, h, def, dt);
  }

  // ---- 离场检测：远离营地超 leaveRadius 且附近无鼠 → 悻悻离去 ----
  const camp = campAnchor(ctx);
  if (camp) {
    const distToCamp = Math.hypot(h.pos.x - camp.x, h.pos.y - camp.y);
    if (distToCamp > t.leaveRadius) {
      // 检查附近是否有鼠（用 huntMagnetRadius 作"附近"半径：鼠在此距离内才会追它）
      let ratNearby = false;
      for (const p of ctx.pawns()) {
        if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= t.huntMagnetRadius) {
          ratNearby = true;
          break;
        }
      }
      if (!ratNearby) {
        leaving.push(h.id);
        // 清理 scratch 键（防内存泄漏）
        delete ctx.scratch[`hunting.lastHp.${h.id}`];
        delete ctx.scratch[`hunting.fleeDist.${h.id}`];
      }
    }
  }
}

/** 游荡：随机方向小步走（1~3 格），用 stepTowardPassable 保证不穿地形。
 *  mimic needs.wander 的 ctx.rng 模式：ang = rng*2π, dist = min + rng*(max-min)。 */
function wanderStep(ctx: SimContext, h: Hostile, def: { speed: number }, dt: number): void {
  const t = ctx.tuning.hunting;
  const ang = ctx.rng() * Math.PI * 2;
  const dist = t.wanderStepMin + ctx.rng() * (t.wanderStepMax - t.wanderStepMin);
  const tx = h.pos.x + Math.cos(ang) * dist;
  const ty = h.pos.y + Math.sin(ang) * dist;
  stepTowardPassable(ctx, h.pos, { x: tx, y: ty }, def.speed * dt);
}

/** 带通行的直线移动（复制自 raid.stepTowardPassable）：
 *  整向量走不通就滑轴（先 x 后 y），再不行原地。动物不是幽灵。 */
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

/** 找最近的被动动物（在 maxR 内）。null = 没有。
 *  用于 hunt 卡 condition 和 action。 */
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

/** 找离动物最近的鼠。null = 场上无鼠（已绝种）。 */
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

/** 营地锚点 = 鼠群质心附近的火堆（与 raid.trySpawnCat 同款锚定逻辑）。
 *  无火则以质心本身为锚。null = 场上无鼠且无火（极端情况，放弃出生）。 */
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
    // 无鼠：尝试找火堆
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
