/**
 * events 包 —— 局面触发事件（"饥荒、寒冬、瘟疫、突袭与背叛都不是脚本，而是同一套
 * 抽卡池在不同局面下抽出的不同故事"——SEED.md 种子句）。
 *
 * 设计灵魂（红线，违反即失败）：
 *  - **一切皆抽卡 + 事件从局面触发**：事件 = 谓词(when) + 效果表(effects)。
 *    无脚本线、无剧情分支、无"第三章"。同一个事件种子在不同局面下被反复抽到，
 *    玩家看到的故事差异来自局面本身（库存/人口/建筑），不来自任何 if-else 分支。
 *  - **数据驱动**：所有数值（阈值/节奏）全在 tuning.events，事件种子只读不写。
 *  - **卸载不破坏核心（原则④）**：不挂本包 → eventSeeds 为空 → 无系统遍历谓词
 *    → 无事件触发、无 log、世界照跑。残留的 scratch 键（如 env.temp）由 env 包
 *    自己管，本包不碰（tempShift 只在 env.temp 存在时生效，否则静默跳过）。
 *  - **注释纪律**：每个函数/分支都说"做什么 + 为什么"，数值引用 tuning 路径。
 *
 * 运行态（跨 tick 状态一律走 ctx.scratch，禁止闭包——存档纪律，见 tech-pool.ts）：
 *  - `events.acc`：检查计时器（每 checkSec 秒扫一次 eventSeeds）
 *  - `events.<seedId>.last`：事件冷却（触发时刻；cooldownSec 内不再触发）
 *  - `events.expire.<seedId>`：持续效果到期时刻（到点时做反向效果，简化实现）
 *
 * 卸载纪律（tempShift / hpDelta / spawnPawn 的能力探测）：
 *  - tempShift **探测** `ctx.scratch["env.temp"]`（env 是否在场），**写入** `env.tempMod`
 *    （修饰量）——见下方 KEY_ENV_TEMP_MOD 的跨包契约注释。env 包未挂载时静默跳过，不报错。
 *    这是"事件效果依赖另一个包的能力"的标准处理方式。
 *  - hpDelta 走 ctx.damagePawn（内核单点出口），只要 Sim 存在就成立。
 *  - spawnPawn 走 ctx.spawnPawn（内核单点出口），只要 Sim 存在就成立。
 */
import type { ModPack } from '../pack';
import type { SimContext } from '../../sim/context';
import type { EventSeedDef } from '../registry';
import { K_STOCK_FOOD, K_TAG_SHELTER, K_TAG_FIRE } from '../contracts';

/** scratch 键（随档；键格式 "<包>.<名>" 见 context.ts 约定） */
const ACC_KEY = 'events.acc';
const LAST_PREFIX = 'events.'; // events.<seedId>.last = 上次触发时刻
const EXPIRE_PREFIX = 'events.expire.'; // events.expire.<seedId> = 持续效果到期时刻
/** 跨包契约（env ↔ events，2026-10-07 事故后立）：
 *  - `env.temp`   = **最终温度**，只有 env 包写（昼夜基准 + 修饰的合成值）。我们只读它做能力探测。
 *  - `env.tempMod` = **事件修饰量**（additive），只有本包写。env 每 tick 合成 `temp = base + mod`。
 *
 * 为什么要两个键：如果事件直接写 `env.temp`，env 的昼夜循环每 tick 会把它**覆写掉**，
 * coldsnap 的 -12 变成完全无效的静默 no-op——而且不报错。两个包写同一个键、后写的赢，
 * 这类冲突没有编译器能抓住，只能靠契约约定「谁写哪个键」。见 env 包的 K_TEMP_MOD 注释。
 */
const KEY_ENV_TEMP = 'env.temp'; // 只读：env 是否在场的能力探测
const KEY_ENV_TEMP_MOD = 'env.tempMod'; // 我们写：事件修饰量

export const eventsPack: ModPack = {
  id: 'events',
  requires: [], // 不依赖任何包：事件只读 tuning + 世界查询面，效果走 ctx 单点出口
  apply(m) {
    // ---- 事件种子（全部谓词 + 效果表，数值全读 tuning.events.thresholds）----
    //
    // 为什么用局部数组而非直接 m.registerEvent：registerSystemDef 的 ctor 只收 ctx，
    // 没有 registry 访问面（SimContext 不暴露 registry）。按指令允许"在 apply 时闭包
    // 捕获你注册的那批 def"——这是包内自洽的例外：卸载本包 = 系统不存在 = 谓词不判
    // = 效果不生效（卸载即失效），且残留的 eventSeeds 数组不会污染无本包的世界
    // （registry 是每次 mountPacks 新建的，不同装配互不串扰）。
    const seeds: EventSeedDef[] = [];

    // ---- 丰收 harvest-blessing：低年（food < 阈值）+ 有浆果丛 → 浆果格外丰硕 ----
    seeds.push({
      id: 'harvest-blessing',
      name: '丰收之年',
      when: (ctx) => {
        const t = ctx.tuning.events.thresholds;
        if ((ctx.stockpile[K_STOCK_FOOD] ?? 0) >= t.harvestFoodBelow) return false;
        // 浆果丛必须在 60 格内（半径硬编码在谓词里，与 tuning.world.berryRate 无关——
        // 这是"事件能感知多远的世界"，属于事件语义而非世界生成，留作包内常量）
        // 用第一只鼠的位置作为锚点（营地可能在地图任何位置，不能硬编码 (0,0)）
        const firstPawn = [...ctx.pawns()][0];
        if (!firstPawn) return false;
        return ctx.nearestFeature('berry', firstPawn.pos.x, firstPawn.pos.y, 60) !== null;
      },
      effects: {
        log: '📦 丰收之年：浆果丛格外丰硕',
        stock: { [K_STOCK_FOOD]: 20 },
      },
    });

    // ---- 寒潮 coldsnap：无火堆 或 人多（≥阈值）→ 温度骤降（持续 60s）----
    seeds.push({
      id: 'coldsnap',
      name: '寒潮',
      when: (ctx) => {
        const t = ctx.tuning.events.thresholds;
        // 火堆数为 0 或 鼠数 ≥ coldsnapMinPawns
        let fires = 0;
        for (const b of ctx.buildingsAll()) {
          if (ctx.tuning.buildings[b.defId]?.tags?.includes(K_TAG_FIRE)) fires++;
        }
        if (fires > 0) {
          let n = 0;
          for (const _ of ctx.pawns()) n++;
          return n >= t.coldsnapMinPawns;
        }
        return true; // 无火堆 → 直接触发（营地还没立起来就来了寒潮）
      },
      effects: {
        log: '🥶 寒潮来袭',
        tempShift: -12,
        durationSec: 60,
      },
    });

    // ---- 瘟疫 plague：人多（≥阈值）→ 全体鼠 hp 下降 ----
    seeds.push({
      id: 'plague',
      name: '瘟疫',
      when: (ctx) => {
        const t = ctx.tuning.events.thresholds;
        let n = 0;
        for (const _ of ctx.pawns()) n++;
        return n >= t.plagueMinPawns;
      },
      effects: {
        log: '⚠ 瘟疫在营地蔓延',
        hpDelta: -10,
      },
    });

    // ---- 流浪者 stranger：富余（food > 阈值）+ 有棚屋 → 新增 1 鼠 ----
    seeds.push({
      id: 'stranger',
      name: '流浪者',
      when: (ctx) => {
        const t = ctx.tuning.events.thresholds;
        if ((ctx.stockpile[K_STOCK_FOOD] ?? 0) <= t.strangerFoodAbove) return false;
        // 有棚屋（shelter 标签建筑）
        for (const b of ctx.buildingsAll()) {
          if (ctx.tuning.buildings[b.defId]?.tags?.includes(K_TAG_SHELTER)) return true;
        }
        return false;
      },
      effects: {
        log: '🐭 一个流浪者加入了营地',
        spawnPawn: 1,
      },
    });

    // ---- 丰收节 festival：奢侈（food > 阈值）→ 分掉一部分食物（庆祝）----
    //
    // 注意：效果是 stock: { food: +15 }，看似"增加"，但语义是"丰收到能分出去庆祝"。
    // 与 harvest 的区分靠阈值（30 vs 80）：荒年才显丰收恩泽，奢侈才庆祝。
    seeds.push({
      id: 'festival',
      name: '丰收节',
      when: (ctx) => {
        const t = ctx.tuning.events.thresholds;
        return (ctx.stockpile[K_STOCK_FOOD] ?? 0) > t.festivalFoodAbove;
      },
      effects: {
        log: '🎉 丰收节：大家分着吃',
        stock: { [K_STOCK_FOOD]: 15 },
      },
    });

    // 全部注册进 registry（registry.eventSeeds 数组会持有引用，供未来的跨包消费者用）
    for (const s of seeds) m.registerEvent(s);

    // ---- 系统：事件扫描（category 'world'：进度类，与战斗无关但也不是社会行为）----
    m.registerSystemDef({
      id: 'events',
      category: 'world',
      ctor: (ctx: SimContext) => ({
        id: 'events',
        update(dt) {
          const t = ctx.tuning.events;
          // ① 先处理持续效果的过期（每 tick 都查——到期必须及时，不依赖 checkSec 节拍）
          handleExpiry(ctx, seeds);
          // ② 累加检查计时器；未到 checkSec 就存下返回（余量保留，长 dt 不丢进度）
          let acc = (ctx.scratch[ACC_KEY] ?? 0) + dt;
          if (acc < t.checkSec) {
            ctx.scratch[ACC_KEY] = acc;
            return;
          }
          acc -= t.checkSec; // 不是取模：防长步长雪崩（与 tech-pool 同款手法）
          ctx.scratch[ACC_KEY] = acc;
          // ③ 遍历谓词，命中且不在冷却内 → 应用效果 + 记冷却
          for (const seed of seeds) {
            const lastKey = `${LAST_PREFIX}${seed.id}.last`;
            const last = ctx.scratch[lastKey];
            if (last !== undefined && ctx.time - last < t.cooldownSec) continue;
            if (!seed.when(ctx)) continue;
            ctx.scratch[lastKey] = ctx.time;
            applyEffects(ctx, seed);
          }
        },
      }),
    });
  },
};

/**
 * 应用事件效果表（逐项，缺字段自然跳过——向后兼容旧 `{ log }` 形状）。
 *
 * 卸载纪律：tempShift 只在 env.temp 存在时生效（?? 判空，不报错）。
 * 其余效果走 ctx 单点出口（stockpile / damagePawn / spawnPawn），只要 Sim 存在就成立。
 */
function applyEffects(ctx: SimContext, seed: EventSeedDef): void {
  const e = seed.effects;
  // log 是效果表的必有字段（哪怕其他效果都缺，log 也在）
  ctx.log(e.log);

  // stock：库存增减，钳制 ≥0（不能出现负库存——世界事实，不是"欠粮")
  if (e.stock) {
    for (const [k, v] of Object.entries(e.stock)) {
      ctx.stockpile[k] = Math.max(0, (ctx.stockpile[k] ?? 0) + v);
    }
  }

  // stockMul：库存乘数，同样钳制 ≥0（乘数 <0 没物理意义，钳到 0）
  if (e.stockMul) {
    for (const [k, m] of Object.entries(e.stockMul)) {
      ctx.stockpile[k] = Math.max(0, (ctx.stockpile[k] ?? 0) * m);
    }
  }

  // hpDelta：全体鼠 hp 增减。负值 = 扣血（走 damagePawn 单点出口，含死亡判定）；
  // 正值 = 回血（damagePawn 只做扣血，回血直接改 hp，钳到 maxHp）
  if (e.hpDelta !== undefined && e.hpDelta !== 0) {
    // 复制列表：damagePawn 会 kill → 从 pawnMap 删 → 迭代期间 map 变动不安全
    for (const p of [...ctx.pawns()]) {
      if (e.hpDelta < 0) {
        ctx.damagePawn(p.eid, -e.hpDelta, seed.name);
      } else {
        p.hp = Math.min(p.maxHp, p.hp + e.hpDelta);
      }
    }
  }

  // spawnPawn：新增鼠（流浪者加入营地）
  if (e.spawnPawn && e.spawnPawn > 0) {
    for (let i = 0; i < e.spawnPawn; i++) {
      ctx.spawnPawn();
    }
  }

  // tempShift：环境温度修饰。**仅当 env 包在场时生效**（ctx.scratch["env.temp"] 存在）。
  // 写 `env.tempMod`（修饰量）而不是 `env.temp`（最终值）——见上方跨包契约注释：
  // 直接写 env.temp 会被 env 的昼夜循环每 tick 覆写，coldsnap 变成静默 no-op。
  // env 包未挂载时该键不存在 → 静默跳过（能力探测），不报错。这是"效果依赖另一个包
  // 的能力"的标准处理方式（卸载纪律：能依赖的能力不存在就不碰，不破坏核心）。
  if (e.tempShift !== undefined) {
    if (ctx.scratch[KEY_ENV_TEMP] !== undefined) {
      ctx.scratch[KEY_ENV_TEMP_MOD] = (ctx.scratch[KEY_ENV_TEMP_MOD] ?? 0) + e.tempShift;
      // 持续效果：登记到期时刻，到点时做反向效果（简化实现）
      if (e.durationSec && e.durationSec > 0) {
        ctx.scratch[`${EXPIRE_PREFIX}${seed.id}`] = ctx.time + e.durationSec;
      }
    }
    // env.temp 不存在 → 整个 tempShift 分支静默跳过（连到期登记都不做，
    // 否则到期时反向效果会凭空写入 env.tempMod——破坏"卸载即失效"）
  }
}

/**
 * 处理持续效果的过期：遍历 scratch 里所有 events.expire.* 键，到期的做反向效果。
 *
 * 简化实现（指令允许）：持续效果 = "到点时再做一次反向效果"。当前只有 tempShift
 * 有 durationSec（coldsnap 的 60s 低温），反向 = 温度回升。stock/hpDelta/spawnPawn
 * 没有 durationSec（它们是瞬时效果），不涉及过期。
 *
 * 卸载纪律：如果 seed 已被卸载（热卸载场景，registry 重建但 scratch 残留），
 * 找不到对应 seed → 清理孤儿键，不报错（与 tech-pool 的"表外放行"同款手法）。
 */
function handleExpiry(ctx: SimContext, seeds: EventSeedDef[]): void {
  for (const [key, expireAt] of Object.entries(ctx.scratch)) {
    if (!key.startsWith(EXPIRE_PREFIX)) continue;
    if (ctx.time < expireAt) continue;
    const seedId = key.slice(EXPIRE_PREFIX.length);
    const seed = seeds.find((s) => s.id === seedId);
    if (!seed) {
      // 孤儿键（seed 已卸载）：清理，不报错
      delete ctx.scratch[key];
      continue;
    }
    const e = seed.effects;
    // 反向效果：只有 tempShift 有 durationSec，反向 = 修饰量归零方向回退
    if (e.tempShift !== undefined) {
      if (ctx.scratch[KEY_ENV_TEMP] !== undefined) {
        ctx.scratch[KEY_ENV_TEMP_MOD] = (ctx.scratch[KEY_ENV_TEMP_MOD] ?? 0) - e.tempShift;
        ctx.log(`🌡 ${seed.name} 的余波散去，温度回升`);
      }
    }
    delete ctx.scratch[key];
  }
}
