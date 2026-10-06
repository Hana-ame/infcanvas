/**
 * raid 包 —— 敌袭种子：野猫（数据）+ 叙事压力生成 + 鼠的战/逃卡。
 *
 * 原则②落地：没有波次脚本、没有难度曲线调度——只有"压力随时间积累，满了来一只猫"
 * 这一条局面规则。压力速率/敌人属性全在 tuning。猫的行为是最简动物智能（追最近鼠、
 * 近身咬），**鼠的反应全部走卡**：迎战/撤退与采集睡觉同台抽签，血量低时恐惧钩子
 * 把天平推向逃跑——"战或逃"是抽出来的，不是 if 出来的。
 */
import type { ModPack } from '../pack';
import { SER_FIGHT, SER_FLEE } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, Hostile } from '../../sim/types';

export const raidPack: ModPack = {
  id: 'raid',
  requires: [],
  apply(m) {
    // ---- 敌人数据表 ----
    // 平衡锚点：速度略低于鼠（跑得掉、追得上掉队的），血量够撑几轮围殴——
    // "战或逃都有戏"区间。改这里必须同步跑生存循环测试（survival-loop.test）
    // climb 2 = 能跃上岩层(z=2)追猎——鼠上不去的石头对猫是坦途（生态位差异）
    // 平衡锚点（seed42/7/99/2026/777 ×900s 网格实测）：速度略低于鼠（跑得掉）、
    // 血量在"2~3 只鼠围殴 ~10s 可杀"区间、dmg3 给足救援窗口——战或逃都有戏。
    // 改这里必须重跑 survival-loop 与多 seed 复采。
    m.registerEnemy({ id: 'cat', name: '野猫', hp: 24, dmg: 3, speed: 4.0, atkCd: 1.5, climb: 2 });

    // ---- 恐惧权重钩子：受伤越重越想跑、越不想打（数值即性格，无硬规则）----
    m.registerHook('cardWeight', (p, card, ctx) => {
      const hostileNear = card.series === SER_FIGHT || card.series === SER_FLEE;
      if (!hostileNear) {
        // 遭遇压制：猫在感知圈内时，把普通卡（采集/建造/睡觉/社交…）的权重压下去。
        //
        // 为什么必须有这一条（2026-10-06 实测，见 tuning.raid.threatWorkMul 的证据段）：
        // 工作卡一次抽签要执行 6~8s，猫 2 DPS，所以"猫在咬、鼠在伐木"是默认结果——
        // 实测 436 个被咬 tick 里 388 个（89%）鼠抽的确实是普通卡。
        // 抽签池里没有战斗卡、或者战斗卡只占 1/3 权重时，战或逃根本轮不到上台，
        // 鼠会在伐木途中被活活咬死。这不是数值大小问题，是**候选集/权重结构**问题。
        //
        // 为什么用权重而不是"遇敌打断当前卡"：见 tuning 里的红线说明——
        // 加 if 强插是 Work-Tab 式越权；压权重仍然让结果由抽签决定，只是天平被局势倾斜。
        const threat = nearestHostile(p, ctx);
        return threat ? ctx.tuning.raid.threatWorkMul : 1;
      }
      const ratio = p.hp / p.maxHp;
      if (ratio < 0.3) return card.series === SER_FLEE ? 5 : 0.4;
      if (ratio < 0.6) return card.series === SER_FLEE ? 2.5 : 0.8;
      return 1;
    });

    // ---- 卡：迎战（条件 = 有敌接近；伤害/冷却读 tuning.pawn）----
    m.registerCard({
      id: 'fight',
      label: '迎战',
      series: SER_FIGHT,
      weight: 9,
      condition: (p, ctx) => nearestHostile(p, ctx) !== null,
      action(p, ctx) {
        const h = nearestHostile(p, ctx);
        if (!h) {
          ctx.finishCard(p); // 敌退了
          return;
        }
        if (!ctx.adjacent(p, h.pos.x, h.pos.y, ctx.tuning.raid.attackRange + 0.25)) {
          if (p.path.length === 0 && !ctx.setPath(p, Math.round(h.pos.x), Math.round(h.pos.y))) {
            ctx.finishCard(p); // 敌在不可达处：放弃本次迎战
          }
          return; // 接敌中
        }
        p.path = []; // 贴脸停走
        if (p.atkCd <= 0) {
          const mul = ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1;
          ctx.damageHostile(h.id, Math.round(ctx.tuning.pawn.dmg * mul));
          p.atkCd = ctx.tuning.pawn.atkCd;
        }
      },
    });

    // ---- 卡：撤退（往营地反方向拉开距离；短承诺 → 每 2s 重新权衡战/逃）----
    m.registerCard({
      id: 'flee',
      label: '撤退',
      series: SER_FLEE,
      weight: 6,
      duration: 2,
      condition: (p, ctx) => nearestHostile(p, ctx) !== null,
      action(p, ctx) {
        const h = nearestHostile(p, ctx);
        if (!h) {
          ctx.finishCard(p);
          return;
        }
        if (p.path.length === 0) {
          // 逃向火堆（往人多处跑 = 集体防御自然涌现）；无火则远离敌人 6 格
          const fire = ctx.nearestBuildingByTag('fire', p.pos.x, p.pos.y, 20);
          const dx = p.pos.x - h.pos.x;
          const dy = p.pos.y - h.pos.y;
          const d = Math.hypot(dx, dy) || 1;
          let tx = fire ? fire.pos.x : Math.round(p.pos.x + (dx / d) * 6);
          let ty = fire ? fire.pos.y : Math.round(p.pos.y + (dy / d) * 6);
          if (!ctx.setPath(p, tx, ty)) {
            // 火堆/远点被地形隔断：就近背敌两格保命（绝不停在原地挨打）
            tx = Math.round(p.pos.x + (dx / d) * 2);
            ty = Math.round(p.pos.y + (dy / d) * 2);
            ctx.setPath(p, tx, ty);
          }
        }
      },
    });

    // ---- 系统：叙事压力 + 猫的动物智能（类别 raid）----
    // 压力键：本包自洽（写读同包），不入契约表；放 ctx.scratch 是为了随档——
    // 闭包状态存档无法还原（阶段④存档纪律：系统跨 tick 状态一律走 scratch）。
    const PRESSURE_KEY = 'raid.pressure';
    m.registerSystemDef({
      id: 'raid',
      category: 'raid',
      ctor: (ctx: SimContext) => ({
        id: 'raid',
        update(dt) {
          // 压力积累：满阈值 → 营地环带刷一只野猫，回落保留余量（连续高压期更凶）
          let pressure = (ctx.scratch[PRESSURE_KEY] ?? 0) + ctx.tuning.raid.pressurePerSec * dt;
          if (pressure >= ctx.tuning.raid.pressureThreshold) {
            // 刷点必须是低地可立足格；大湖地形下环带可能全程落水——
            // 此时压力顶格保留（敌袭顺延到找到落脚点的那个 tick），绝不生成幽灵猫
            if (trySpawnCat(ctx)) pressure -= ctx.tuning.raid.pressureThreshold;
          }
          ctx.scratch[PRESSURE_KEY] = pressure;
          tickCats(ctx, dt);
        },
      }),
    });
  },
};

function trySpawnCat(ctx: SimContext): boolean {
  const t = ctx.tuning.raid;
  // 营地锚点 = 鼠群质心附近的火堆（此前用"离世界原点最近的火"，拓荒出第二营地后
  // 猫会刷到无人区——真实缺陷）。没火则以质心本身为锚。
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const p of ctx.pawns()) {
    cx += p.pos.x;
    cy += p.pos.y;
    n++;
  }
  cx = n ? cx / n : 0;
  cy = n ? cy / n : 0;
  const fire = ctx.nearestBuildingByTag('fire', cx, cy);
  const ax = fire ? fire.pos.x : cx;
  const ay = fire ? fire.pos.y : cy;
  const ang = ctx.rng() * Math.PI * 2;
  const dist = t.spawnDistMin + ctx.rng() * (t.spawnDistMax - t.spawnDistMin);
  let sx = Math.round(ax + Math.cos(ang) * dist);
  let sy = Math.round(ay + Math.sin(ang) * dist);
  // 落点校验两连坑的终案：
  //   只查可立足 → 猫掉湖里永久卡死（幽灵敌袭）；
  //   放宽到任意立足 → 猫落岩层孤岛，鼠上不去它也下不来（双向僵局）；
  //   终案 = 低地 z=0 可立足格（与营地草地网络相连），救援圈 ±40，找不到就放弃本次。
  const okSpot = (x: number, y: number): boolean => ctx.passable(x, y);
  for (let r = 0; r <= 40 && !okSpot(sx, sy); r++) {
    for (let dy = -r; dy <= r && !okSpot(sx, sy); dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (okSpot(sx + dx, sy + dy)) {
          sx += dx;
          sy += dy;
          break;
        }
      }
    }
  }
  if (!okSpot(sx, sy)) return false;
  ctx.spawnHostile(t.kind, sx, sy);
  return true;
}

/** 猫 AI：索敌半径内追最近的鼠并近身咬；否则朝营地游荡（压迫感）。数据全读 enemies 表。
 *  离场阀：够不着任何鼠且远离营地持续 45s → 悻悻离去。没有它猫只增不减，
 *  长局会堆积成必死雪球（review 发现的玩法漏洞）。计时走 ctx.scratch 随档。 */
const AWAY_SEC = 45;

function tickCats(ctx: SimContext, dt: number): void {
  const leaving: number[] = [];
  for (const h of ctx.hostiles()) {
    const def = ctx.tuning.enemies[h.kind];
    // 卸载防线：def 可能不存在——存档里带着某种 hostile 的种类（例：factions 包刷出的
    // raider），而读档时那个包没挂，tuning.enemies 里没有它的定义。此时**跳过**而不是
    // 抛错：否则 def.passive 触发 TypeError，整条 raid 系统每 tick 崩一次，
    // 「卸载 factions 后 raid 照常工作」这条卸载纪律就破了。
    // 对本包自己的 cat 零行为影响（def 永远存在）。
    if (!def) continue;
    // 被动动物（R3-3 hunting）不跑掠食逻辑：它们的游荡/逃跑由 hunting 包自己的系统驱动。
    // 不跳过会让猫的智能把兔子也变成追猎鼠的猎手——既不是生态位差异，也不是设计。
    if (def.passive) continue;
    const target = nearestPawn(ctx, h);
    if (target && dist(h.pos, target.pos) <= ctx.tuning.raid.leashRadius) {
      if (dist(h.pos, target.pos) > ctx.tuning.raid.attackRange) {
        stepTowardPassable(ctx, h.pos, target.pos, def.speed * dt);
      } else if (h.atkCd <= 0) {
        ctx.damagePawn(target.eid, def.dmg, `${def.name}袭击`);
        h.atkCd = def.atkCd;
      }
    } else {
      const fire = ctx.nearestBuildingByTag('fire', h.pos.x, h.pos.y);
      const farFromCamp = !fire || dist(h.pos, fire.pos) > ctx.tuning.raid.spawnDistMax + 8;
      const awayKey = `raid.away.${h.id}`;
      if (!target && farFromCamp) {
        const t = (ctx.scratch[awayKey] ?? 0) + dt;
        if (t >= AWAY_SEC) {
          leaving.push(h.id);
          continue;
        }
        ctx.scratch[awayKey] = t;
      } else {
        delete ctx.scratch[awayKey];
      }
      if (fire && dist(h.pos, fire.pos) > 3) stepTowardPassable(ctx, h.pos, fire.pos, def.speed * 0.5 * dt);
    }
    if (h.atkCd > 0) h.atkCd = Math.max(0, h.atkCd - dt);
  }
  // 迭代结束后统一移除：边遍历边 splice 会跳过下一只（真实踩坑）
  for (const id of leaving) {
    ctx.despawnHostile(id);
    ctx.log('野猫悻悻离去了');
  }
}

/**
 * 带通行的直线移动：整向量走不通就滑轴（先 x 后 y），再不行原地。
 * 猫是动物不是幽灵——此前无视地形会直接划过湖面/岩层，画面与模拟双输。
 */
function stepTowardPassable(ctx: SimContext, pos: { x: number; y: number }, to: { x: number; y: number }, budget: number): void {
  const dx = to.x - pos.x;
  const dy = to.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return;
  // 插值封顶：t∈(0,1]，绝不过冲（首版用 Math.min 截断在负方向会越过目标瞬移——真实踩坑）
  const t = Math.min(1, budget / d);
  const nx = pos.x + dx * t;
  const ny = pos.y + dy * t;
  if (ctx.passable(Math.round(nx), Math.round(ny))) {
    pos.x = nx;
    pos.y = ny;
    return;
  }
  // 滑轴：整向量被地形挡住就只走 x 或只走 y（贴墙绕行最简形态；A* 是鼠的，猫保持动物智能）
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

function nearestHostile(p: PawnState, ctx: SimContext): Hostile | null {
  let best: Hostile | null = null;
  let bestD = ctx.tuning.raid.senseRadius;
  for (const h of ctx.hostiles()) {
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
    const d = dist(h.pos, p.pos);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function stepToward(pos: { x: number; y: number }, to: { x: number; y: number }, budget: number): void {
  const dx = to.x - pos.x;
  const dy = to.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= budget || d === 0) {
    pos.x = to.x;
    pos.y = to.y;
  } else {
    pos.x += (dx / d) * budget;
    pos.y += (dy / d) * budget;
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
