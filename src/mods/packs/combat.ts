/**
 * combat 包 —— 战术种子（防御的行为层）：据守 / 集火 / 迂回 / 集结四卡。
 *
 * 与 raid 的分工（不是冗余）：
 *   raid  = 追击 / 撤退两卡 = 「打不打」（是否进入战斗，血量倾斜决定战或逃）
 *   combat = 据守 / 集火 / 迂回 / 集结四卡 = 「怎么打、从哪打、和谁一起打」
 * 两套卡同台抽签（SER_FIGHT / SER_FLEE / SER_DEFEND 三条系列），
 * 这正是「一切皆抽卡」的直接体现，而不是冗余——中间地带的战术空间入口。
 *
 * 红线遵守（违反即失败）：
 *   ① 一切皆抽卡：本包只 registerCard + registerHook，禁止 if-else 行为树 / 任务队列 / 强制指令 AI。
 *   ② 数据驱动：所有可 A/B 的量（半径/时长/伤害倍率/阈值）全进 tuning.combat，
 *      卡权重（7/6/4/3）写死在包里——registerCard 拿不到 ctx，见 cooking.ts 同款注释。
 *   ③ 磁铁范式：condition 用 defendMagnetRadius（大，24 格），action 里不在 attackRange（小，1.75 格）
 *      就 setPath + return 等 moveStep；不可达就 finishCard 收工（防「看得见却永远到不了」的空转）。
 *   ④ 复用现有近战 API：ctx.damageHostile(id, dmg) + p.atkCd（照 raid.fight 的写法），
 *      不加远程 / 投射物模型（那需要内核新实体类型，本轮不做）。
 *   ⑤ 跨 tick 状态走 ctx.scratch，禁止闭包（本包全部无状态，故不用 scratch）。
 *   ⑥ series 用 contracts 的 SER_* 常量（SER_DEFEND）。
 *   ⑦ 注释纪律：说明「做什么 + 为什么」。
 *
 * 卸载语义（原则④）：不挂本包 → 无 4 卡、无 SER_DEFEND 权重钩子；tuning.combat 仍在出厂表里
 *   但无人消费，raid 的 fight/flee 照常在池里、世界照跑。
 *
 * 数值全部读 ctx.tuning.combat，本文件零玩法魔法数（卡权重是例外，见 cooking.ts 注释）。
 */
import type { ModPack } from '../pack';
import { SER_DEFEND, K_TAG_FIRE, K_TAG_TOWER } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, Hostile, BuildingState, Pos } from '../../sim/types';

export const combatPack: ModPack = {
  id: 'combat',
  requires: [], // 不依赖任何包：抽卡池 + tuning.combat + contracts 已够用
  apply(m) {
    // ---- 权重钩子：把「多敌人 + 血低」的局面信号变成 SER_DEFEND 权重的涌现 ----
    //
    // 【为什么用钩子而不是把权重基数调高】见 raid.ts / cooking.ts 同款注释：
    //   抬高集中在「真的有敌来袭、且附近有墙可依」的世界状态上，
    //   没敌时不浪费抽签（否则据守卡会在太平日子里霸占卡池）。
    // 【命中规则】签名 (p, card, ctx) => number，不命中系列 return 1（不干扰其他系列）。
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_DEFEND) return 1;
      const c = ctx.tuning.combat;
      let mul = 1;
      // ① 多敌人 → SER_DEFEND 系列抬权：≥ multiEnemyThreshold 只敌人时触发
      const enemyCount = countHostiles(p, ctx, c.defendMagnetRadius);
      if (enemyCount >= c.multiEnemyThreshold) mul *= c.defendMulMultiEnemy;
      // ② 血低 + 附近有据点 → hold 卡再加一层抬权（「有墙/塔保护就该守」的数值表达）
      if (card.id === 'hold' && p.hp / p.maxHp < 0.5 && strongholdNear(p, ctx, c.defendMagnetRadius) !== undefined) {
        mul *= c.defendMulMultiEnemy; // 复用同一个抬权系数（无更细分的表项）
      }
      return mul;
    });

    // ---- 卡：据守（SER_DEFEND，weight 7，duration 4）----
    // 【与 fight 的区别】fight 追敌人（磁铁到敌人），hold 等敌人来（磁铁到据点、站定不动）。
    // 【与 flee 的区别】血低时 hold 优于 flee：有墙/塔保护就该守（权重钩子②把这条数值化了）。
    // 【磁铁范式】condition 用 defendMagnetRadius 找据点，action 里不在 holdRadius 就 setPath 走过去。
    m.registerCard({
      id: 'hold',
      label: '据守',
      series: SER_DEFEND,
      weight: 7,
      duration: 4,
      condition: (p, ctx) => strongholdNear(p, ctx, ctx.tuning.combat.defendMagnetRadius) !== undefined,
      action(p, ctx) {
        holdAction(p, ctx);
      },
    });

    // ---- 卡：集火（SER_DEFEND，weight 6，duration 4）----
    // 【「同目标」近似判据】见 focusTarget 的注释：用「同伴最近敌人」近似其真实目标。
    // 【为什么这样近似，不精确怎么办】见 focusTarget 头部的取舍说明。
    m.registerCard({
      id: 'focus',
      label: '集火',
      series: SER_DEFEND,
      weight: 6,
      duration: 4,
      condition: (p, ctx) => focusTarget(p, ctx) !== null,
      action(p, ctx) {
        focusAction(p, ctx);
      },
    });

    // ---- 卡：迂回（SER_DEFEND，weight 4，duration 4）----
    // 【侧翼点算法】side = 据点 + perp(据点→敌人) × flankOffset（几何见 flankPoint 注释）。
    // 【战术含义】战术空间 = 从哪个方向进入：mouse 走侧翼点而不是敌人正前方。
    m.registerCard({
      id: 'flank',
      label: '迂回',
      series: SER_DEFEND,
      weight: 4,
      duration: 4,
      condition: (p, ctx) => flankTarget(p, ctx) !== null,
      action(p, ctx) {
        flankAction(p, ctx);
      },
    });

    // ---- 卡：集结（SER_DEFEND，weight 3，duration 2）----
    // 【短 duration 2s】让抽卡频繁重抽（聚拢是持续过程，不是一次性任务）。
    // 【不攻击】集结卡的目的就是「把人聚起来」——攻击由后续抽到的 fight/focus/hold 完成。
    m.registerCard({
      id: 'rally',
      label: '集结',
      series: SER_DEFEND,
      weight: 3,
      duration: 2,
      condition: (p, ctx) => countHostiles(p, ctx, ctx.tuning.combat.defendMagnetRadius) >= ctx.tuning.combat.rallyMinEnemies,
      action(p, ctx) {
        rallyAction(p, ctx);
      },
    });
  },
};

// =============================================================================
// 卡动作实现
// =============================================================================

/**
 * 据守动作（磁铁范式 + 站定不动）：
 *   - 找据点（K_TAG_TOWER 或 K_TAG_FIRE，取更近的）——**大半径** defendMagnetRadius；
 *   - 不在据点旁（> holdRadius）→ setPath 走过去 + return（等 moveStep 推进）；
 *   - 在据点旁 → p.path = []（**站定不动**），敌人在 attackRange 内就打（atkCd 冷却）。
 *
 * 【站定不动的语义】hold 与 fight 的核心区别：fight 追敌人（每 tick 追最近敌人），
 *   hold 站定等敌人来（不追，只在原地接敌）。这条「不追」体现在 p.path = []：
 *   到达据点后不再规划新路径，猫自己走过来才接。
 */
function holdAction(p: PawnState, ctx: SimContext): void {
  const c = ctx.tuning.combat;
  const b = strongholdNear(p, ctx, c.defendMagnetRadius);
  if (!b) {
    ctx.finishCard(p); // 据点被拆了 / 走出磁铁圈：收工重抽
    return;
  }
  if (!ctx.adjacent(p, b.pos.x, b.pos.y, c.holdRadius)) {
    // 还不够近——走过去（这一步是本卡全部的「磁铁」含义）
    if (p.path.length === 0 && !ctx.setPath(p, Math.round(b.pos.x), Math.round(b.pos.y))) {
      ctx.finishCard(p); // 不可达：收工重抽，防恒真空转
    }
    return;
  }
  // ---- 到据点旁了：站定不动 ----
  p.path = []; // 停在据点旁别乱走（这是 hold 与 fight 的核心区别）
  const h = nearestHostile(p, ctx, c.attackRange);
  if (h && p.atkCd <= 0) {
    const mul = ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1;
    ctx.damageHostile(h.id, Math.round(ctx.tuning.pawn.dmg * mul));
    p.atkCd = ctx.tuning.pawn.atkCd;
  }
}

/**
 * 集火目标选择（focus 卡的 condition 判据）：
 *   ① 磁铁半径内有敌人（看得见）；
 *   ② 有同伴正在打**同一只**敌人（集火才有意义）。
 *
 * 【「同一只敌人」的近似判据 —— 本函数最关键的取舍】
 *   真实情况：同伴的「目标敌人」是同伴 action 里选定的那只，不在 PawnState 里。
 *   近似做法：**同伴的目标敌人 ≈ 同伴自己距离最近的敌人**（在 defendMagnetRadius 内）。
 *   局限：
 *     - 若同伴正在追 A 敌人但 B 敌人恰好路过更近，近似会误判「同伴在打 B」；
 *     - 若同伴刚抽到 fight 还没走到任何敌人身边，也会误判。
 *   为什么这样近似（而不是引入新字段）：
 *     - 红线：跨 tick 状态走 ctx.scratch，禁止闭包；引入 PawnState.targetHostileId 需要
 *       改内核 types.ts（且要随档、要进协议），代价远大于收益；
 *     - 战术语义：「同伴在打同一只敌人」的本质是「两只鼠的注意力都在这只猫身上」，
 *       而注意力 ≈ 距离最近的敌人 —— 这是**涌现的**，不是硬编码的。
 *     - 失效模式：最多让集火卡抽中的**时机**稍偏（多打一只其实没人在打的敌人），
 *       伤害 ×focusMul 仍然结算，不会让卡变死代码或霸池。
 * 【判定顺序】先找「自己的目标」（nearest 敌）；再遍历同伴，找 cardId 在
 *   ['fight','focus','hold'] 且「其目标（近似）与自己目标相同」者。任一命中即返回目标敌人。
 */
function focusTarget(p: PawnState, ctx: SimContext): Hostile | null {
  const c = ctx.tuning.combat;
  const mine = nearestHostile(p, ctx, c.defendMagnetRadius);
  if (!mine) return null; // ① 磁铁半径内无敌人
  // ② 有同伴正在打同一只敌人（近似判据）
  for (const o of ctx.pawns()) {
    if (o.eid === p.eid) continue; // 自己不算同伴
    const COMBAT_CARDS = ['fight', 'focus', 'hold'];
    if (!COMBAT_CARDS.includes(o.cardId ?? '')) continue;
    const theirTarget = nearestHostile(o, ctx, c.defendMagnetRadius);
    if (theirTarget && theirTarget.id === mine.id) return mine; // 同目标，集火成立
  }
  return null;
}

/**
 * 集火动作（磁铁范式 + 伤害倍率）：
 *   - 找目标敌人（磁铁半径内最近）；
 *   - 不在 attackRange 内 → setPath 走过去 + return；
 *   - 在 attackRange 内 → 站定 + 伤害 ×focusMul。
 *
 * 【为什么不复用 focusTarget】focusTarget 的判据是「有同伴在打同一只」，
 *   而 action 只需要「走过去打」；若 action 里再查一遍同伴会浪费 CPU（每 tick 每鼠 O(N²)）。
 *   所以 action 里直接用 nearestHostile，不重复判据。
 */
function focusAction(p: PawnState, ctx: SimContext): void {
  const c = ctx.tuning.combat;
  const h = nearestHostile(p, ctx, c.defendMagnetRadius);
  if (!h) {
    ctx.finishCard(p); // 敌人跑了
    return;
  }
  if (!ctx.adjacent(p, h.pos.x, h.pos.y, c.attackRange + 0.25)) {
    if (p.path.length === 0 && !ctx.setPath(p, Math.round(h.pos.x), Math.round(h.pos.y))) {
      ctx.finishCard(p); // 不可达：收工重抽
    }
    return;
  }
  p.path = []; // 贴脸停走
  if (p.atkCd <= 0) {
    const mul = (ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1) * c.focusMul;
    ctx.damageHostile(h.id, Math.round(ctx.tuning.pawn.dmg * mul));
    p.atkCd = ctx.tuning.pawn.atkCd;
  }
}

/**
 * 迂回目标选择（flank 卡的 condition 判据）：
 *   ① 附近有敌人（磁铁半径内）；
 *   ② 附近有据点（K_TAG_TOWER 或 K_TAG_FIRE）。
 * 两条都要满足，否则不算「有侧翼可绕」。
 */
function flankTarget(p: PawnState, ctx: SimContext): { enemy: Hostile; base: BuildingState } | null {
  const c = ctx.tuning.combat;
  const h = nearestHostile(p, ctx, c.defendMagnetRadius);
  if (!h) return null;
  const b = strongholdNear(p, ctx, c.defendMagnetRadius);
  if (!b) return null;
  return { enemy: h, base: b };
}

/**
 * 侧翼点几何（flank 卡的核心算法）：
 *
 *   side = 据点位置 + perp(据点→敌人) × flankOffset
 *
 *   其中：
 *     d = normalize(enemy - base)         // 据点→敌人方向（单位向量）
 *     perp = (-d.y, d.x)                 // 逆时针旋转 90° 的单位向量
 *     side = base + perp × flankOffset
 *
 * 【为什么取 perp 而不是「据点另一侧」】
 *   直觉上「据点另一侧」= 敌人在据点东边、我从西边绕 = 沿 d 方向的反向延伸；
 *   但那会让鼠走「据点 → 敌人反方向」，最终还是要折返回来打敌人，白走一截。
 *   侧翼（perp）走的是「据点 → 敌人垂直方向」，抵达后向敌人推进的方向与「据点→敌人」
 *   成直角 —— 这才是真正的「从侧翼进入」（战术含义 = 攻击角度 ≠ 敌人面向）。
 *
 * 【perp 方向取哪一侧】取 (-d.y, d.x)（逆时针 90°）而非 (d.y, -d.x)（顺时针 90°）：
 *   两者对称，选一个即可；测试只断言「不在据点→敌人连线上」，不关心具体哪一侧。
 */
function flankPoint(base: Pos, enemy: Pos, offset: number): Pos {
  const dx = enemy.x - base.x;
  const dy = enemy.y - base.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: base.x, y: base.y }; // 敌在据点上：退化为据点本身
  const ux = dx / d;
  const uy = dy / d;
  // perp = 逆时针 90°：(u) → (-uy, ux)
  return { x: base.x + -uy * offset, y: base.y + ux * offset };
}

/**
 * 迂回动作（两段路径：先到侧翼点，再从侧翼点推进敌人）：
 *   - 找目标敌人 + 据点；
 *   - 不在侧翼点旁（> 0.5 格）→ setPath 去侧翼点 + return；
 *   - 在侧翼点旁 → 走向敌人（从侧翼角度切入）；
 *   - 敌人在 attackRange 内 → 站定 + 伤害 ×flankMul。
 *
 * 【为什么两段路径，不直接走敌人】
 *   直接走敌人 = 「据点 → 敌人」直线 = 正面冲锋，没有战术意义。
 *   两段路径 = 「据点 → 侧翼点 → 敌人」，攻击角度 = 侧翼角度，这才是「迂回」。
 *   到达侧翼点后，敌人相对自己已经偏出「据点→敌人」连线，从那里推进的攻击方向
 *   与「据点→敌人」方向成夹角 —— 战术空间的实现。
 *
 * 【侧翼点 0.5 格的到达容差】比 attackRange(1.75) 小得多，让「到达侧翼点」是精确事件
 *   而非「差不多到了」；到达后再转向敌人，两段路径衔接清晰。
 */
function flankAction(p: PawnState, ctx: SimContext): void {
  const c = ctx.tuning.combat;
  const t = flankTarget(p, ctx);
  if (!t) {
    ctx.finishCard(p);
    return;
  }
  const { enemy, base } = t;
  const flank = flankPoint(base.pos, enemy.pos, c.flankOffset);
  // 第一段：走向侧翼点
  if (!ctx.adjacent(p, flank.x, flank.y, 0.5)) {
    if (p.path.length === 0 && !ctx.setPath(p, Math.round(flank.x), Math.round(flank.y))) {
      ctx.finishCard(p);
    }
    return;
  }
  // 第二段：从侧翼点推进敌人（攻击角度 = 侧翼角度）
  if (!ctx.adjacent(p, enemy.pos.x, enemy.pos.y, c.attackRange + 0.25)) {
    if (p.path.length === 0 && !ctx.setPath(p, Math.round(enemy.pos.x), Math.round(enemy.pos.y))) {
      ctx.finishCard(p);
    }
    return;
  }
  p.path = [];
  if (p.atkCd <= 0) {
    const mul = (ctx.tuning.pawn.traitDmgMul[p.trait] ?? 1) * c.flankMul;
    ctx.damageHostile(enemy.id, Math.round(ctx.tuning.pawn.dmg * mul));
    p.atkCd = ctx.tuning.pawn.atkCd;
  }
}

/**
 * 集结动作（磁铁范式 + 走质心 + 不攻击）：
 *   - 找磁铁半径内的敌人（rallySenseRadius）；
 *   - 敌人 < rallyMinEnemies → finishCard（不值得聚拢）；
 *   - 计算质心（多敌人的算术平均）；
 *   - setPath 去质心；
 *   - **不攻击**（这是集结卡的语义：把人聚起来，攻击由后续抽到的卡完成）。
 */
function rallyAction(p: PawnState, ctx: SimContext): void {
  const c = ctx.tuning.combat;
  const enemies = enemiesInRadius(p, ctx, c.rallySenseRadius);
  if (enemies.length < c.rallyMinEnemies) {
    ctx.finishCard(p);
    return;
  }
  // 质心 = 敌人坐标的算术平均
  let sx = 0;
  let sy = 0;
  for (const e of enemies) {
    sx += e.pos.x;
    sy += e.pos.y;
  }
  const cx = sx / enemies.length;
  const cy = sy / enemies.length;
  if (p.path.length === 0 && !ctx.setPath(p, Math.round(cx), Math.round(cy))) {
    ctx.finishCard(p);
  }
  // 集结卡不攻击：p.path 保持，等 moveStep 推进
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 据点查询：K_TAG_TOWER 或 K_TAG_FIRE，取更近的一座。
 *
 * 【为什么要两个 tag】哨塔（K_TAG_TOWER）是专门的防御建筑（fortify 包将写），
 *   火堆（K_TAG_FIRE）是现有建筑里最接近「据点」语义的（营地核心、可站人、有航点标签）。
 *   两者共享「这是可以据守的点」的跨包语义；取更近的一座让 hold/focus/flank 卡
 *   在有无哨塔的世界下都能工作（卸载 fortify 时 fire 兜底）。
 *
 * 【maxR 缺省 Infinity 的处理】ctx.nearestBuildingByTag 的 maxR 缺省是 Infinity，
 *   但我们需要「在 defendMagnetRadius 内」，所以显式传 r。
 */
function strongholdNear(p: PawnState, ctx: SimContext, r: number): BuildingState | undefined {
  const fire = ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, r);
  const tower = ctx.nearestBuildingByTag(K_TAG_TOWER, p.pos.x, p.pos.y, r);
  if (!fire && !tower) return undefined;
  if (!fire) return tower;
  if (!tower) return fire;
  const dFire = Math.hypot(fire.pos.x - p.pos.x, fire.pos.y - p.pos.y);
  const dTower = Math.hypot(tower.pos.x - p.pos.x, tower.pos.y - p.pos.y);
  return dFire <= dTower ? fire : tower;
}

/**
 * 最近敌人在给定半径内（否则 null）。与 raid.ts 的 nearestHostile 同构，
 *   只是半径参数化（raid 用固定 senseRadius，combat 用可配置的 defendMagnetRadius/attackRange）。
 */
function nearestHostile(p: PawnState, ctx: SimContext, r: number): Hostile | null {
  let best: Hostile | null = null;
  let bestD = r;
  for (const h of ctx.hostiles()) {
    const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
    if (d <= bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/**
 * 半径内的所有敌人（集结卡算质心用）。与 nearestHostile 同构，只是返回全部。
 */
function enemiesInRadius(p: PawnState, ctx: SimContext, r: number): Hostile[] {
  const out: Hostile[] = [];
  for (const h of ctx.hostiles()) {
    if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= r) out.push(h);
  }
  return out;
}

/** 半径内的敌人数（权重钩子 + rally condition 用）。 */
function countHostiles(p: PawnState, ctx: SimContext, r: number): number {
  let n = 0;
  for (const h of ctx.hostiles()) {
    if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= r) n++;
  }
  return n;
}
