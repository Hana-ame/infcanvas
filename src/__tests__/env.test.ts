/**
 * env.test.ts —— 环境包（昼夜/温度/天气 + 冻伤中暑）验收。
 *
 * 覆盖验收清单：
 *  1. 温度曲线：dayPhase 走满一圈，温度锁定在 [baseTemp+nightOffset, baseTemp] 且**连续**
 *     （用 run() 步进而非手算，另断言振幅真的走完——否则恒温也能蒙过"区间内"）；
 *  2. 方向性：低温局（临时抬 coldThreshold）→ 野外鼠冻掉血、火旁鼠不受伤，死亡原因稳定；
 *  3. 庇护：棚屋（K_TAG_SHELTER）与火堆（K_TAG_FIRE）同等提供庇护；
 *  4. 钩子方向性：低温/酷暑抬 SER_REST 最终权重（用 cardWeight 直接比对）；
 *  5. 下雨压低 SER_GATHER / SER_WOOD 权重，且不污染其它系列；
 *  6. 天气：周期性掷骰 + 播报去抖（只在翻转时报 🌧/☀）+ 食物衰减乘数接入口；
 *  7. 装配/卸载：卸载 env 后世界照跑、零环境播报；
 *  8. 存读档：env.dayPhase/temp/rain 随档，读档续跑 ≡ 不存档直跑（指纹相等）；
 *  9. **跨包契约**：事件修饰 env.tempMod 是 additive 合成、不被昼夜循环抹掉——
 *     这条能抓"两个包写同一个键"这类静默冲突（env 与 events 各自单测都抓不到）。
 *
 * 测试风格：最小装配（原则④），只挂被测包 + 必要的对照包；
 *  建筑夹具注入免维护定义（不带 fuelSec）——避免 building 包的 upkeep 系统
 *  在我摆好的火堆燃尽后把庇护判据悄悄改掉（那会让方向性断言变得不可解释）。
 *
 * 【红线自检】本文件**不出现** debugForceCard + 手动摆坐标去验证"环境行为"的组合：
 *  环境不做新卡，也没有"躲到火旁"这种行为可强插——只有掉血与权重两条路径，
 *  本文件分别用真世界步进（run）与 cardWeight 直接比对来验证。
 */
import { describe, expect, it } from 'vitest';
import { Sim, loadSim, snapshotOf, fingerprint, cardWeight, type CardDef } from '../sim';
import { ModRegistry } from '../mods';
import { K_TAG_FIRE, K_TAG_SHELTER, SER_EAT, SER_GATHER, SER_REST, SER_WOOD } from '../mods/contracts';
import { envPack, K_ENV_FOOD_DECAY_MUL, K_ENV_TEMP_MOD } from '../mods/packs/env';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';

// ---- 环境播报文案（env.ts 里的字面量；这里复用作"是否环境日志"的判据）----
const ENV_LOG = /🌧 下雨了|☀ 雨停了|🥶 寒潮来袭|🥵 酷暑/;

/** 只挂 env 的最小装配（pawnCount: 0 = 跳过 bootstrap，纯环境时钟） */
function envOnly(seed = 1, pawns = 0): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks([envPack]), pawnCount: pawns });
}

/**
 * 注入免维护的建筑夹具定义。
 *
 * 为什么手动注入而不是挂 buildingPack：building 包的 `buildings-upkeep` 系统会按
 * fuelSec 烧木料、断薪就熄灭火堆——那我摆好的庇护锚点会在测试中途消失，
 * 方向性断言（"火旁不受伤"）会变成随机结果。带 requires 的完整装配留给生存闭环测试。
 * 这里只需要 tags 语义：'fire' 与 'shelter' 各自独立可查。
 */
function seedBuildings(s: Sim): void {
  s.tuning.buildings['campfire'] = { name: '篝火', cost: {}, hp: 80, tags: [K_TAG_FIRE], passable: true };
  s.tuning.buildings['hut'] = { name: '棚屋', cost: {}, hp: 200, tags: [K_TAG_SHELTER], passable: false, w: 2, h: 2 };
}

/** 在 (cx,cy) 附近找一块能放下 w×h 建筑的左上角（地形不确定性的兜底）。 */
function findSpot(s: Sim, cx: number, cy: number, w: number, h: number, maxR = 60): { x: number; y: number } | null {
  for (let r = 0; r <= maxR; r += 2) {
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const x = cx + dx;
        const y = cy + dy;
        let fit = true;
        for (let j = 0; j < h && fit; j++) {
          for (let i = 0; i < w && fit; i++) {
            if (!s.passable(x + i, y + j)) fit = false;
          }
        }
        if (fit) return { x, y };
      }
    }
  }
  return null;
}

/** 摆一座建筑夹具（findSpot 已保证全格可通行且无占位 ⇒ addBuilding 不会返回 null）。 */
function place(s: Sim, defId: string, cx: number, cy: number): { id: string; pos: { x: number; y: number } } {
  const def = s.tuning.buildings[defId];
  const spot = findSpot(s, cx, cy, def?.w ?? 1, def?.h ?? 1);
  const b = spot && s.addBuilding(defId, spot.x, spot.y);
  if (!b) throw new Error(`夹具落子失败：${defId} @ 目标 (${cx},${cy})`);
  return b;
}

/** 探针卡：不注册进卡池，只为喂给 cardWeight 取最终权重（管线顺序对两次调用恒定）。 */
function probe(series: string, weight = 10): CardDef {
  return { id: `_probe_${series}`, label: '探针', series, weight, action: () => {} };
}

describe('env 环境包', () => {
  it('① 温度曲线：一天走满后温度锁定在区间内、逐拍连续、且振幅真的走完', () => {
    const s = envOnly(1);
    const t = s.tuning.env;
    // 温度区间 = baseTemp 与 baseTemp+nightOffset 的两端（nightOffset 为负 ⇒ 上界是 baseTemp）
    const lo = Math.min(t.baseTemp, t.baseTemp + t.nightOffset);
    const hi = Math.max(t.baseTemp, t.baseTemp + t.nightOffset);

    // dt=1 ⇒ 每拍推进 1/dayLengthSec；多跑 4 拍收尾以吸收相位浮点余量
    const steps = Math.ceil(t.dayLengthSec) + 4;
    const temps: number[] = [];
    let prevTemp: number | undefined;
    let prevPhase = 0;
    let maxDelta = 0;
    let maxPhaseStep = 0;
    for (let i = 0; i < steps; i++) {
      s.step(1);
      const phase = s.scratch['env.dayPhase'];
      const temp = s.scratch['env.temp'];
      expect(phase, 'dayPhase 未写入 scratch').toBeTypeOf('number');
      expect(temp, 'env.temp 未写入 scratch').toBeTypeOf('number');
      // 区间约束
      expect(temp).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(temp).toBeLessThanOrEqual(hi + 1e-9);
      // 连续性：逐拍跳变不得超过正弦曲线的最大瞬时变化率（|nightOffset|·π）× 每拍相位增量
      if (prevTemp !== undefined) maxDelta = Math.max(maxDelta, Math.abs(temp - prevTemp));
      prevTemp = temp;
      // 相位必须单调前进（允许一次环绕），且每拍增量 = 1/dayLengthSec
      const d = phase >= prevPhase ? phase - prevPhase : 1 + phase - prevPhase;
      maxPhaseStep = Math.max(maxPhaseStep, d);
      prevPhase = phase;
      temps.push(temp);
    }
    const bound = (Math.abs(t.nightOffset) * Math.PI) / t.dayLengthSec;
    expect(maxDelta, '温度逐拍跳变超过正弦上界 ⇒ 曲线不连续').toBeLessThanOrEqual(bound + 1e-9);
    expect(maxPhaseStep, 'dayPhase 推进幅度不对').toBeLessThanOrEqual(1 / t.dayLengthSec + 1e-9);
    // 走满一圈后相位应回到 0 附近
    expect(s.scratch['env.dayPhase']).toBeLessThan(0.1);
    // 振幅必须真的走完：否则"恒温 = baseTemp"也能蒙过区间与连续性断言
    expect(Math.max(...temps) - Math.min(...temps), '温度曲线振幅不足 ⇒ 昼夜没在转').toBeGreaterThan(
      Math.abs(t.nightOffset) * 0.95,
    );
  });

  it('② 方向性：低温局野外鼠冻掉血、火旁鼠不受伤，死亡原因稳定为「冻伤」', () => {
    const s = envOnly(2, 2);
    seedBuildings(s);
    const fire = place(s, 'campfire', 0, 0);
    const [wild, warm] = [...s.pawns()];
    wild.pos = { x: 0, y: 200 }; // 距火 200 格 ≫ warmRadius
    warm.pos = { x: fire.pos.x + 0.5, y: fire.pos.y + 0.5 }; // 火堆旁（0.71 < warmRadius 4）

    // 强制低温：把冻伤线抬到白天最高温之上（白天 baseTemp=18，抬到 50 ⇒ 全天冻）
    s.tuning.env.coldThreshold = 50;

    const wildHp0 = wild.hp;
    const warmHp0 = warm.hp;
    s.run(20);
    // 野外按 freezeDmgPerSec × dt 掉血（世界事实：速率可预测、可验证）
    expect(wild.hp, '野外鼠没有冻掉血').toBeLessThan(wildHp0);
    expect(wildHp0 - wild.hp, '冻伤速率 ≠ freezeDmgPerSec × 秒数').toBeCloseTo(20 * s.tuning.env.freezeDmgPerSec, 5);
    // 火旁鼠全程无恙
    expect(warm.hp, '火旁鼠不该受伤').toBe(warmHp0);

    // 继续跑到野外鼠死亡：死亡原因字符串必须稳定（进日志与指纹，不能随文案漂移）
    s.run(300);
    expect(s.events.some((e) => e.text.includes('死亡（冻伤）')), '缺少稳定的「冻伤」死亡原因').toBe(true);
    // 播报去抖：越线只报一次，不是每秒一条
    expect(s.events.filter((e) => e.text.includes('寒潮')).length, '寒潮播报刷屏了').toBe(1);
    // 火旁鼠活到最后
    expect([...s.pawns()].some((p) => p.eid === warm.eid), '火旁鼠应该活下来').toBe(true);
  });

  it('③ 庇护：棚屋（K_TAG_SHELTER）与火堆同等提供庇护', () => {
    const s = envOnly(3, 3);
    seedBuildings(s);
    const fireB = place(s, 'campfire', 0, 0);
    const hutB = place(s, 'hut', 60, 60);

    const [byFire, byHut, exposed] = [...s.pawns()];
    byFire.pos = { x: fireB.pos.x + 0.5, y: fireB.pos.y + 0.5 };
    // 棚屋是 2×2、nearestBuildingByTag 按建筑角点测距：角点旁 1.41 格 < warmRadius 4
    byHut.pos = { x: hutB.pos.x + 1, y: hutB.pos.y + 1 };
    exposed.pos = { x: 0, y: 300 };

    s.tuning.env.coldThreshold = 50;
    s.run(30);
    expect(byFire.hp, '火旁鼠应受庇护').toBe(byFire.maxHp);
    expect(byHut.hp, '棚屋旁鼠应受庇护').toBe(byHut.maxHp);
    expect(exposed.hp, '野外鼠应受伤').toBeLessThan(exposed.maxHp);
  });

  it('④ 钩子方向性：低温与酷暑都抬高 SER_REST 最终权重（cardWeight 直接比对）', () => {
    const s = envOnly(4, 1);
    const p = [...s.pawns()][0];
    const card = probe(SER_REST);
    const t = s.tuning.env;

    // 只改 env.temp；特质/熟练度对同一次调用恒定 ⇒ 权重差全部来自 env 钩子
    s.scratch['env.temp'] = 0; // 深冬（远低于 coldThreshold + coldRestBand）
    s.scratch['env.rain'] = 0;
    const coldW = cardWeight(p, card, s);
    s.scratch['env.temp'] = t.baseTemp; // 常温正午
    const normalW = cardWeight(p, card, s);
    expect(coldW, '低温时休息权重应高于常温').toBeGreaterThan(normalW);
    expect(coldW / normalW, '低温抬升倍数 ≠ coldRestMul').toBeCloseTo(t.coldRestMul, 5);

    // 预警带宽的两侧边界（band 是"提前量"：真实冻伤线之上就开始想躲火旁）
    s.scratch['env.temp'] = t.coldThreshold + 0.5; // 2.5 ∈ [coldThreshold, +band) ⇒ 带内，抬升
    expect(cardWeight(p, card, s), '预警带内应提前抬升').toBeCloseTo(normalW * t.coldRestMul, 5);
    s.scratch['env.temp'] = t.coldThreshold + t.coldRestBand + 0.5; // 6.5 ≥ +band ⇒ 带外，不抬
    expect(cardWeight(p, card, s), '越过预警带宽不该抬升').toBeCloseTo(normalW, 5);

    // 酷暑：temp > hotThreshold ⇒ SER_REST × hotRestMul
    s.scratch['env.temp'] = t.hotThreshold + 1;
    expect(cardWeight(p, card, s) / normalW, '酷暑抬升倍数 ≠ hotRestMul').toBeCloseTo(t.hotRestMul, 5);
  });

  it('⑤ 下雨压低 SER_GATHER / SER_WOOD 权重，且不污染其它系列', () => {
    const s = envOnly(5, 1);
    const p = [...s.pawns()][0];
    const t = s.tuning.env;
    s.scratch['env.temp'] = t.baseTemp; // 排除温度对休息系列的干扰

    for (const series of [SER_GATHER, SER_WOOD]) {
      const card = probe(series);
      s.scratch['env.rain'] = 0;
      const dryW = cardWeight(p, card, s);
      s.scratch['env.rain'] = 1;
      const wetW = cardWeight(p, card, s);
      expect(wetW, `${series} 雨天权重应低于晴天`).toBeLessThan(dryW);
      expect(wetW / dryW, '雨天压制倍数 ≠ rainWorkMul').toBeCloseTo(t.rainWorkMul, 5);
    }

    // 非户外系列不受雨影响（钩子在未命中系列时 return 1）
    const eatCard = probe(SER_EAT);
    s.scratch['env.rain'] = 0;
    const d = cardWeight(p, eatCard, s);
    s.scratch['env.rain'] = 1;
    expect(cardWeight(p, eatCard, s), '雨不该影响进食系列').toBeCloseTo(d, 5);
  });

  it('⑥ 天气：周期性掷骰决定降雨，只在翻转时播报，食物衰减乘数正确暴露', () => {
    const s = envOnly(6);
    const t = s.tuning.env;

    // 概率拉满 ⇒ 每个周期边界必然下雨
    s.tuning.env.rainChance = 1;
    s.run(t.weatherCycleSec);
    expect(s.scratch['env.rain'], '概率 1 时应下雨').toBe(1);
    expect(s.events.some((e) => e.text === '🌧 下雨了'), '缺少下雨播报').toBe(true);
    // 食物衰减乘数接入口：下雨 = rainFoodDecayMul
    expect(s.scratch[K_ENV_FOOD_DECAY_MUL], '雨天食物衰减乘数错').toBe(t.rainFoodDecayMul);

    // 持续多个周期仍下雨 ⇒ 不再重复播报（去抖）
    s.run(t.weatherCycleSec * 3);
    expect(s.scratch['env.rain']).toBe(1);
    expect(s.events.filter((e) => e.text === '🌧 下雨了').length, '同一雨状态重复播报了').toBe(1);

    // 雨停 ⇒ 报 ☀，乘数回落 1
    s.tuning.env.rainChance = 0;
    s.run(t.weatherCycleSec);
    expect(s.scratch['env.rain'], '概率 0 时应转晴').toBe(0);
    expect(s.events.some((e) => e.text === '☀ 雨停了'), '缺少雨停播报').toBe(true);
    expect(s.scratch[K_ENV_FOOD_DECAY_MUL], '晴天食物衰减乘数应为 1').toBe(1);

    // 再下雨 ⇒ 又报一次（翻转才报，不是永远只报一次）
    s.tuning.env.rainChance = 1;
    s.run(t.weatherCycleSec);
    expect(s.events.filter((e) => e.text === '🌧 下雨了').length).toBe(2);
  });

  it('⑦ 装配/卸载：卸载 env 后世界照跑且零环境播报；挂载时播报不刷屏', () => {
    // 卸载：核心照跑（原则④），rng 序列不受 env 影响，scratch 里也不留环境键
    const bare = new Sim({
      seed: 6,
      registry: ModRegistry.mountPacks([needsPack, gatheringPack]),
      pawnCount: 2,
    });
    expect(() => bare.run(120), '卸载 env 后核心崩溃了').not.toThrow();
    expect(bare.scratch['env.dayPhase'], '卸载后不应残留 dayPhase').toBeUndefined();
    expect(bare.events.some((e) => ENV_LOG.test(e.text)), '卸载后不该有环境播报').toBe(false);

    // 挂载：环境播报上限 = 掷骰次数（每个周期边界至多一次翻转）
    const withEnv = new Sim({
      seed: 6,
      registry: ModRegistry.mountPacks([needsPack, gatheringPack, envPack]),
      pawnCount: 2,
    });
    const seconds = 600;
    withEnv.run(seconds);
    const cycles = Math.ceil(seconds / withEnv.tuning.env.weatherCycleSec);
    const envLogs = withEnv.events.filter((e) => ENV_LOG.test(e.text));
    expect(envLogs.length, `环境播报刷屏（${envLogs.length} 条 > 掷骰 ${cycles} 次）`).toBeLessThanOrEqual(cycles);
    // 默认气候温和（温度锁在 [10,18]，阈值 2/34 够不到）⇒ 只有雨在报
    expect(withEnv.events.some((e) => e.text.includes('寒潮')), '温和气候不该报寒潮').toBe(false);
    expect(withEnv.events.some((e) => e.text.includes('酷暑')), '温和气候不该报酷暑').toBe(false);
    // 两个装配下同 seed 的核心事件数不同（rng 消耗分叉）是**预期的**：
    // env 的雨骰只在 env 系统里消耗；这里只断言卸载侧不崩、不刷屏。
  });

  it('⑧ 存读档：env.dayPhase/temp/rain 随档，读档续跑 ≡ 不存档直跑', () => {
    const reg = ModRegistry.mountPacks([envPack]);
    const a = new Sim({ seed: 8, registry: reg, pawnCount: 1 });
    a.run(137);
    const snap = snapshotOf(a);

    const b = loadSim(JSON.parse(JSON.stringify(snap)), reg);
    for (const k of [
      'env.dayPhase',
      'env.tempBase',
      K_ENV_TEMP_MOD,
      'env.temp',
      'env.rain',
      'env.cycleAcc',
      'env.rainReported',
      K_ENV_FOOD_DECAY_MUL,
    ]) {
      expect(snap.scratch[k], `快照缺 ${k}`).toBeTypeOf('number');
      expect(b.scratch[k], `读档后 ${k} 丢失（闭包存状态了？）`).toBeCloseTo(snap.scratch[k]!, 10);
    }
    // 续跑一致性：存档→读档→跑 = 不存档直接跑（续跑分叉是最安静的确定性 bug）
    const direct = new Sim({ seed: 8, registry: reg, pawnCount: 1 });
    direct.run(137);
    expect(fingerprint(b), '读档续跑与直跑指纹不一致').toBe(fingerprint(direct));
  });

  it('⑨ 跨包契约：事件修饰 env.tempMod 是 additive 合成，不被昼夜循环抹掉', () => {
    // 这条测试的意义不在 env 自己的行为，而在**抓跨包静默冲突**：
    // 一旦有第二个包去写 env.temp（后写的赢、不报错），寒潮事件就变成 no-op，
    // 而 env/events 各自的单元测试都测不出来。这里模拟 events 的 coldsnap。
    const s = envOnly(9, 2);
    seedBuildings(s);
    const fire = place(s, 'campfire', 0, 0);
    const [wild, warm] = [...s.pawns()];
    wild.pos = { x: 0, y: 200 };
    warm.pos = { x: fire.pos.x + 0.5, y: fire.pos.y + 0.5 };

    // 停在正午（最热，≈baseTemp）附近，让"被覆盖则回到 ~18"的对比最大化
    s.scratch['env.dayPhase'] = 0.25;
    s.run(1);
    const before = s.scratch['env.temp'];

    // 模拟 events 包 coldsnap：只写修饰量，**不碰** env.temp / env.tempBase
    const COLD_SNAP = -20;
    s.scratch[K_ENV_TEMP_MOD] = COLD_SNAP;
    s.run(1);

    // ① 合成契约：env.temp = tempBase + tempMod
    expect(
      s.scratch['env.temp'] - s.scratch['env.tempBase'],
      'env.temp ≠ tempBase + tempMod（合成断了）',
    ).toBeCloseTo(COLD_SNAP, 9);
    // ② 修饰没被昼夜循环覆写：若 env.temp 被直接重写，这里会回到 ~18
    expect(s.scratch['env.temp'], '事件降温被昼夜循环抹掉了（两个包写同一个键？）').toBeLessThan(
      before + COLD_SNAP + 1,
    );
    // ③ 下游读的是**合成值**：合成温度跌破冻伤线 ⇒ 野外鼠冻死、火旁鼠无恙
    expect(s.scratch['env.temp'], '合成温度应跌破冻伤线').toBeLessThan(s.tuning.env.coldThreshold);
    s.run(120);
    expect(wild.hp, '合成温度触发冻伤，但野外鼠没掉血').toBeLessThan(0);
    expect([...s.pawns()].some((p) => p.eid === wild.eid), '野外鼠应已被冻死').toBe(false);
    expect(warm.hp, '火旁鼠全程不该受伤').toBe(warm.maxHp);
  });

  it('⑩ needs 真的消费 env.foodDecayMul：雨天食物衰减 ≈ 晴天 × rainFoodDecayMul（接线而非只暴露事实）', () => {
    // env 只写 scratch['env.foodDecayMul']，needs 负责读。本条钉的是**双向都到位**：
    // 只测「env 写了」是抓不到 needs 没消费的情况（那时雨天和晴天衰减一模一样，
    // 而雨水的生存压力设计意图就落空了）。
    const s = new Sim({
      seed: 1,
      registry: ModRegistry.mountPacks([needsPack, envPack]),
      pawnCount: 1,
    });
    const t = s.tuning.env;
    const p = [...s.pawns()][0];
    s.stockpile = {}; // 清空库存，防 eat 卡消费食物干扰衰减量（food need=100 本就满，不吃）
    s.run(1); // 让 env 把全部 scratch 键初始化好

    const measure = (ticks: number) => {
      p.needs.food = 100;
      s.run(ticks);
      return 100 - p.needs.food;
    };

    // ⚠ 天气是按 weatherCycleSec 掷骰的周期状态（不是每 tick 掷），所以不能靠
    // 「改 rainChance 再跑几拍」来切雨——已下的雨要等下一个周期边界才会翻。
    // 直接改状态键 env.rain，并让 rainChance=1/0 保证窗口内不会跨边界重掷。
    // 测量窗口 40 tick < weatherCycleSec 90，窗口内不会跨掷骰边界。
    const W = 40;
    s.tuning.env.rainChance = 1;
    s.scratch['env.rain'] = 1;
    s.run(1); // 让 env 把 mul 写成 rainFoodDecayMul（needs 在 category 'needs' 早于
    // env 的 'world'，所以必须等 env 写完本拍，下一拍 needs 才读得到）
    const rainDrop = measure(W);

    s.tuning.env.rainChance = 0;
    s.scratch['env.rain'] = 0;
    s.run(1);
    const sunDrop = measure(W);

    expect(rainDrop, '雨天没衰减食物').toBeGreaterThan(0);
    expect(sunDrop, '晴天没衰减食物').toBeGreaterThan(0);
    // 比值就是 env 写进去的那个乘数。needs 与 env 同拍执行且 needs 在前，
    // 所以窗口内每拍读到的都是上一拍 env 写好的值，比值应是精确的 1.4。
    expect(rainDrop / sunDrop, '雨天食物衰减没比晴天快，needs 可能没消费 env 的乘数').toBeCloseTo(
      t.rainFoodDecayMul,
      5,
    );
  });

  it('⑪ env 未挂载时 needs 的食物衰减静默退化为原速率（卸载不破坏核心）', () => {
    // `?? 1` 的另半边：env 缺席时 scratch 里没这个键，needs 不能报错也不能崩。
    const s = new Sim({ seed: 1, registry: ModRegistry.mountPacks([needsPack]), pawnCount: 1 });
    const p = [...s.pawns()][0];
    s.stockpile = {};
    p.needs.food = 100;
    expect(() => s.run(10)).not.toThrow();
    expect(p.needs.food).toBeCloseTo(100 - s.tuning.needs.foodDecay * 10, 5);
  });
});
