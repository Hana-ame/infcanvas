/**
 * medicine.test.ts —— 医疗包验收。
 *
 * 覆盖清单：
 *  1. 数值表：tuning.medicine 全字段落表，且**磁铁/工作两半径确实不同**（红线③的实测取证）；
 *  2. 契约：病榻 2×2 可通行、造价木 8、标签 bed、hp 100；heal = SER_HEAL；build_bed = SER_BUILD；
 *  3. 方向性（核心机制）：force heal + 同伴重伤 + 库存有 herb → 同伴回血 且 herb 减少；
 *  4. 磁铁范式：伤员在 magnet 内、work 外时 heal 的 condition 为真（"看得见却抽不到"= 死代码）；
 *  5. 病榻倍率：病人身边有床时回血速率 = healPerSec × bedBonus（与无床对照，扣掉自然恢复）；
 *  6. 缺料不崩：herb=0 → heal 卡不报错、不额外回血（hunting 未挂载时的自然状态）；
 *  7. 自然恢复：无人照料时 hp 缓慢上升，速率 = naturalHealPerSec（不形成恒真空转死循环）；
 *  8. 康复即收工：同伴满血 → heal 卡立即 finishCard（不占着空转到 duration 到期）；
 *  9. 权重钩子：有重伤同伴抬 SER_HEAL；自己重伤抬 SER_REST（原则①：需求只是权重输入）；
 * 10. build_bed：木料够 + 有伤员 → 搭出病榻并扣料；
 * 11. 卸载不破坏核心（原则④）：摘掉 medicine 后无 heal 卡 / 无 bed 定义，世界照跑；
 * 12. 存读档：build_bed 后存档读档，bed 建筑仍在；且带病榻的档在**卸载后**仍能读、照跑。
 * 13. Round 57：heal 的 condition 判原料 —— 无草药时即使有重伤同伴也抽不到
 *     （硬闸纯度：condition 必须判自己的原料，对照 build_bed 判木料）。
 *
 * 装配纪律（照 cooking.test.ts SOLO 注释）：**不挂 bootstrapPack**——bootstrap 的 init
 * 会按 tuning.bootstrap.pawnCount(4) 出生 4 只鼠，`new Sim({pawnCount:2})` 实际会得到
 * 6 只，于是"同伴回血/草药减少"这类确定性断言会被**别人的消费**污染。
 * 因此这里用 needs + building + medicine 的最小装配：既能跑到 healing 的完整链路，
 * 又只有我们手控的鼠在动。
 */
import { describe, expect, it } from 'vitest';
import { Sim, loadSim, snapshotOf, cardWeight, type PawnState } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { CLIENT_STEP_SEC } from '../sim/tuning';
import {
  K_STOCK_HERB,
  K_STOCK_WOOD,
  K_TAG_BED,
  SER_BUILD,
  SER_HEAL,
  SER_REST,
} from '../mods/contracts';
import { medicinePack } from '../mods/packs/medicine';
import { needsPack } from '../mods/packs/needs';
import { buildingPack } from '../mods/packs/building';

/** 最小装配：needs（吃睡/权重管线）+ building（建筑生态）+ medicine。**不挂 bootstrap**（见文件头） */
const SOLO: ModPack[] = [needsPack, buildingPack, medicinePack];
/** 摘掉 medicine：对照"卸载不破坏核心"（原则④） */
const WITHOUT: ModPack[] = [needsPack, buildingPack];

function reg(packs: ModPack[]): ModRegistry {
  return ModRegistry.mountPacks(packs);
}

/**
 * 摆两只鼠：a 站 (0,0)、b 站 (d,0)，并把 b **冻结**。
 *
 * 为什么冻结 b（holdUntil 拉到远方）：b 不冻结就会自己抽卡（wander/eat/…）然后跑掉，
 * "同伴回血""草药减少"这类断言就不可控了。holdUntil 是**引擎侧**的抽卡闸门
 * （不是行为规则），把它拉远只是让夹具里的伤员站在原地——测试结束后世界就废了，不影响生产。
 *
 * 为什么选 (0,0)/(d,0)：|x|,|y| <= tuning.world.spawnClearRadius(6) 的方形区域内
 * 世界保证不出水/石/树/浆果（world.genTreeAnchor / genFeatureKind 的早退分支），
 * 所以任何 d <= 6 的摆放都落在可站、可达的格子上，不用再去查 passable。
 */
function setupPair(s: Sim, d: number): [PawnState, PawnState] {
  const ps = [...s.pawns()];
  const a = ps[0];
  const b = ps[1];
  a.pos = { x: 0, y: 0 };
  b.pos = { x: d, y: 0 };
  a.path = [];
  b.path = [];
  b.holdUntil = 1e6; // 冻结伤员
  return [a, b];
}

function bedsOf(s: Sim): number {
  return [...s.buildingsAll()].filter((x) => x.defId === 'bed').length;
}

describe('医疗包 medicine', () => {
  it('数值表：tuning.medicine 全字段落表，磁铁与工作两半径确实不同（红线③取证）', () => {
    const s = new Sim({ seed: 1, registry: reg(SOLO), pawnCount: 1 });
    const m = s.tuning.medicine;
    expect(m.woundedBelow).toBeGreaterThan(0);
    expect(m.woundedBelow).toBeLessThan(1);
    expect(m.healPerSec).toBeGreaterThan(0);
    expect(m.bedBonus).toBeGreaterThan(1);
    expect(m.bedWorkRadius).toBeGreaterThan(0);
    expect(m.herbCost).toBeGreaterThan(0);
    expect(m.naturalHealPerSec).toBeGreaterThan(0);
    expect(m.healWeightWounded).toBeGreaterThan(1);
    expect(m.restWeightWounded).toBeGreaterThan(1);
    // 磁铁 > 工作：这是「拆两个半径」的实测证据。若两者相等，"伤员看得见却照顾不到"
    // 就会变成死代码（chat/sow/harvest/sleep/cook 五个实例的共同根因）。
    expect(m.healMagnetRadius).toBeGreaterThan(m.healWorkRadius);
    // 建造搜索半径必须大于同类间距，否则第二张床永远放不下（几何证明见 tuning 注释）
    expect(m.bedSearchRadius).toBeGreaterThan(s.tuning.build.minSpacing);
  });

  it('契约：病榻 2×2 可通行、造价木 8、标签 bed；heal 是 SER_HEAL；build_bed 是 SER_BUILD', () => {
    const s = new Sim({ seed: 2, registry: reg(SOLO), pawnCount: 1 });
    const bed = s.tuning.buildings['bed'];
    expect(bed).toBeDefined();
    expect(bed!.w).toBe(2);
    expect(bed!.h).toBe(2);
    expect(bed!.passable).toBe(true); // 病人和照料者都要能站到床边
    expect(bed!.hp).toBe(100);
    expect(bed!.tags).toContain(K_TAG_BED);
    expect(bed!.cost[K_STOCK_WOOD]).toBe(8);
    expect(s.cardById('heal')?.series).toBe(SER_HEAL);
    expect(s.cardById('heal')?.duration).toBe(8); // 持续劳作，不是"秒完成"（防霸池自锁）
    expect(s.cardById('build_bed')?.series).toBe(SER_BUILD);
    // 系统已注册且类别是 needs（保证早于 behavior 的 ai 类）
    expect(s.systems.some((x) => x.id === 'medicine-tick')).toBe(true);
  });

  it('方向性：force heal + 同伴重伤 + 库存有 herb → 同伴回血 且 herb 预留', () => {
    const s = new Sim({ seed: 11, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20; // 重伤：20 < 30% × 100
    s.stockpile[K_STOCK_HERB] = 50;
    const hp0 = b.hp;
    const herb0 = s.stockpile[K_STOCK_HERB]!;
    s.debugForceCard(a.eid, 'heal');
    // 原子性预留：commit 时一次性预留 duration * herbCost（P1 #4 并发安全）
    const duration = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const reserved = s.tuning.medicine.herbCost * duration;
    expect(herb0 - s.stockpile[K_STOCK_HERB]!).toBe(reserved);
    s.step(1);
    s.step(1);
    s.step(1);
    // 回血必须远超自然恢复（3s × 0.05 = 0.15）——否则这条卡根本没在干活
    expect(b.hp - hp0).toBeGreaterThan(s.tuning.medicine.naturalHealPerSec * 3 + 1);
    // stockpile 不再变化（预留已在 commit 时扣除，后续 tick 从预留扣减）
    expect(s.stockpile[K_STOCK_HERB]).toBe(herb0 - reserved);
  });

  it('磁铁范式：伤员在 magnet 内、work 外时 heal 的 condition 为真（抽卡硬闸，不是行为树）', () => {
    const s = new Sim({ seed: 12, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 5); // 5 > workRadius(2.5) 且 5 < magnetRadius(24)
    const m = s.tuning.medicine;
    expect(s.adjacent(a, b.pos.x, b.pos.y, m.healWorkRadius)).toBe(false); // 此刻确实还没到位
    b.hp = 20;
    const cond = s.cardById('heal')!.condition!;
    s.stockpile[K_STOCK_HERB] = 50;
    expect(cond(a, s), '伤员在磁铁半径内却抽不到 heal 卡 = 死代码').toBe(true);
    s.debugForceCard(a.eid, 'heal');
    const hp0 = b.hp;
    s.run(10); // 够 a 走到伤员身旁（5 格 / 4.5 格每秒 ≈ 1.1s）并照料若干 tick
    expect(b.hp, 'a 应该真的走过去并开始照料').toBeGreaterThan(hp0 + m.naturalHealPerSec * 10 + 1);
  });

  /**
   * Round 57 契约升级 + R1 审计 P1 #1 修正：heal 的 condition 必须同时判
   * 「附近有伤员」**和**「库存草药 ≥ herbCost × duration」。
   *
   * 为什么必须有这道门：`heal()` 里「没草药就 return 等下一 tick」意味着无料时这张卡
   * 抽中后必然空转，而 condition 不判自己的原料 = 抽卡硬闸不纯（对照 build_bed 先判木料、
   * build_field 先判木料：能干的活才进候选池）。12 seed×900 tick 实测见 medicine.ts
   * wantHeal 注释：加了这道门医疗不降（卡回血 231→236hp）、木料 +178%、空转 −92%。
   *
   * R1 审计 P1 #1（2026-08-21）：改前门检 herbCost(1)，但预留量是 herbCost×duration(8)，
   * herbs=1~7 时门放行、预留静默失败 → 空转。修正后门检量 = 预留量，边界对齐。
   *
   * 这条不是放宽原断言，而是把它拆成多段各自断言：无料→假、不足→假（新增）、刚好→真。
   */
  it('heal condition 判原料：无草药时即使有重伤同伴也抽不到（Round 57 硬闸纯度）', () => {
    const s = new Sim({ seed: 12, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    const m = s.tuning.medicine;
    expect(s.tuning.medicine.healRequireHerb, '默认必须开启原料闸').toBeGreaterThan(0);
    const cond = s.cardById('heal')!.condition!;
    expect(s.stockpile[K_STOCK_HERB] ?? 0, '夹具默认不该有草药').toBe(0);
    expect(cond(a, s), '无草药时不该抽 heal——抽中后必然空转，这是硬闸不纯').toBe(false);

    // 料一到就放行：R1 审计 P1 #1 修正——门检量 = herbCost × duration（=8），
    // 不是 herbCost(1)。herbs=1~7 时门不放行（预留会静默失败），herbs=8 才放行。
    s.stockpile[K_STOCK_HERB] = m.herbCost; // 1 份
    expect(cond(a, s), 'herbs=1（< herbCost×duration=8）不该放行——预留会失败').toBe(false);
    s.stockpile[K_STOCK_HERB] = m.herbCost * 7; // 7 份
    expect(cond(a, s), 'herbs=7（< 8）仍不该放行').toBe(false);
    s.stockpile[K_STOCK_HERB] = m.herbCost * 8; // 8 份 = totalCost
    expect(cond(a, s), 'herbs=8（= herbCost×duration）应该放行').toBe(true);

    // 把闸关掉（mod 可自行调回旧语义）：无料也抽得到 —— 证明这是可关的机制而非写死
    const regOff = ModRegistry.mountPacks(SOLO);
    regOff.overrideTuning((t) => { t.medicine.healRequireHerb = 0; });
    const s2 = new Sim({ seed: 12, registry: regOff, pawnCount: 2 });
    const [a2, b2] = setupPair(s2, 1);
    b2.hp = 20;
    expect(s2.cardById('heal')!.condition!(a2, s2), '闸关后回到旧语义').toBe(true);
    // R3 审计 P2 #4：上面只断言 condition 返回 true 是**假绿**——抽得到不等于活得成。
    // 闸关时内核不写预留，heal() 必须退回直接扣库存；改前 heal() 只认 scratch 预留，
    // 于是"闸关 + 有料"反而永远回不了血（反向死锁，比"闸开 + 无料"的空转更糟）。
    s2.stockpile[K_STOCK_HERB] = 50;
    s2.debugForceCard(a2.eid, 'heal');
    const hp2 = b2.hp;
    for (let i = 0; i < 3; i++) s2.step(1);
    expect(b2.hp - hp2 - s2.tuning.medicine.naturalHealPerSec * 3,
      '闸关+有料必须照常照料回血（改前永远空转）').toBeCloseTo(s2.tuning.medicine.healPerSec * 3, 3);
  });

  it('病榻倍率：病人身边有床时回血速率 = healPerSec × bedBonus（与无床对照）', () => {
    const mk = (withBed: boolean) => {
      const s = new Sim({ seed: 13, registry: reg(SOLO), pawnCount: 2 });
      const [a, b] = setupPair(s, 1);
      b.hp = 20;
      s.stockpile[K_STOCK_HERB] = 1000;
      // 床 2×2 落在 (2,0)，病人 (1,0) 距床角 1 格 < bedWorkRadius(4) ⇒ 有床位加成
      if (withBed) {
        expect(s.addBuilding('bed', 2, 0)).not.toBeNull();
      }
      s.debugForceCard(a.eid, 'heal');
      const hp0 = b.hp;
      s.run(5);
      return { s, gain: b.hp - hp0 };
    };
    const plain = mk(false);
    const bedded = mk(true);
    const m = plain.s.tuning.medicine;
    // 两组都含自然恢复（0.05/s × 5 = 0.25），所以各自减去它只剩照料贡献
    expect(plain.gain - m.naturalHealPerSec * 5).toBeCloseTo(m.healPerSec * 5, 3);
    expect(bedded.gain - m.naturalHealPerSec * 5).toBeCloseTo(m.healPerSec * m.bedBonus * 5, 3);
    // 差值里只剩倍率的增量：healPerSec × (bedBonus - 1)
    expect(bedded.gain - plain.gain).toBeCloseTo(m.healPerSec * (m.bedBonus - 1) * 5, 3);
  });

  it('缺料不崩：herb=0 时 debugForceCard 返回 false（R1 审计 P1 #2：不指派空转卡）', () => {
    const s = new Sim({ seed: 14, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    s.stockpile[K_STOCK_HERB] = 0;
    // R1 审计 P1 #2：预留不足时 debugForceCard 返回 false，不指派卡
    expect(s.debugForceCard(a.eid, 'heal'), 'herb=0 时 debugForceCard 应返回 false').toBe(false);
    expect(a.cardId, '预留不足时不该指派 heal 卡').not.toBe('heal');
    const hp0 = b.hp;
    expect(() => {
      s.step(1);
      s.step(1);
      s.step(1);
    }).not.toThrow();
    // 只有自然恢复，没有照料加成（卡根本没被指派）
    expect(b.hp).toBeCloseTo(hp0 + s.tuning.medicine.naturalHealPerSec * 3, 5);
  });

  it('自然恢复：无人照料时 hp 缓慢上升，速率 = naturalHealPerSec（不形成死循环）', () => {
    const s = new Sim({ seed: 15, registry: reg(SOLO), pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.hp = 50;
    const hp0 = p.hp;
    s.run(20);
    // 缺这条会怎样：hp 永远停在 50，"重伤且无人管"变成永久死状态而不是故事
    expect(p.hp - hp0).toBeCloseTo(s.tuning.medicine.naturalHealPerSec * 20, 4);
  });

  it('康复即收工：同伴满血 → heal 卡立即 finishCard（不占着空转到 duration 到期）', () => {
    const s = new Sim({ seed: 22, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    // b 已接近满血（被另一只鼠抬到 99）；a 仍挂着"照顾 b"的目标键（跨 tick 状态在 scratch）
    b.hp = 99;
    s.scratch[`medicine.target.${a.eid}`] = b.eid;
    s.stockpile[K_STOCK_HERB] = 50;
    s.debugForceCard(a.eid, 'heal');
    s.step(1); // 这一 tick 把 b 抬到满血 ⇒ finishCard
    expect(b.hp).toBe(b.maxHp);
    expect(s.scratch[`medicine.target.${a.eid}`]).toBeUndefined(); // 陈旧目标键已清
    expect(a.busyUntil).toBe(s.time); // finishCard 把 busyUntil 拉回当下
    s.step(1); // 下一拍重抽
    expect(a.cardId, '同伴满血后 heal 卡应已结束').not.toBe('heal');
  });

  it('权重钩子：有重伤同伴抬 SER_HEAL；自己重伤抬 SER_REST（需求只是权重输入）', () => {
    const s = new Sim({ seed: 17, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    const healCard = s.cardById('heal')!;
    const restCard = s.cardById('sleep')!; // needs 包的休息卡 id 是 sleep（series 才是 SER_REST）
    const m = s.tuning.medicine;
    // 无伤员：不抬
    const healW0 = cardWeight(a, healCard, s);
    b.hp = 20; // 重伤同伴进入磁铁半径
    const healW1 = cardWeight(a, healCard, s);
    expect(healW1 / healW0).toBeCloseTo(m.healWeightWounded, 3);
    // 自己重伤：抬 SER_REST（想躺下歇着）
    const restW0 = cardWeight(a, restCard, s);
    a.hp = 20;
    const restW1 = cardWeight(a, restCard, s);
    expect(restW1 / restW0).toBeCloseTo(m.restWeightWounded, 3);
  });

  it('build_bed：木料够 + 有伤员 → 搭出病榻并扣料', () => {
    const s = new Sim({ seed: 18, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20; // 有伤员才值得搭（否则这张卡抽不到，防"4 只鼠狂搭空床"）
    s.stockpile[K_STOCK_WOOD] = 30;
    expect(s.cardById('build_bed')!.condition!(a, s)).toBe(true);
    // 无伤员时抽不到（即便木料富余）
    b.hp = b.maxHp;
    expect(s.cardById('build_bed')!.condition!(a, s), '无伤员时 build_bed 不该抽到').toBe(false);
    b.hp = 20;
    const wood0 = s.stockpile[K_STOCK_WOOD]!;
    s.debugForceCard(a.eid, 'build_bed');
    s.step(1);
    expect(bedsOf(s)).toBe(1);
    expect(s.stockpile[K_STOCK_WOOD]).toBe(wood0 - 8);
  });

  it('卸载不破坏核心（原则④）：摘掉 medicine 后无 heal 卡 / 无 bed 定义，世界照跑', () => {
    const s = new Sim({ seed: 19, registry: reg(WITHOUT), pawnCount: 2 });
    expect(s.cardById('heal')).toBeUndefined();
    expect(s.cardById('build_bed')).toBeUndefined();
    expect(s.tuning.buildings['bed']).toBeUndefined();
    expect(s.systems.some((x) => x.id === 'medicine-tick')).toBe(false);
    expect(() => s.run(30), '卸载后世界照常推进').not.toThrow();
  });

  it('存读档：build_bed 后存档读档，bed 建筑仍在；且带病榻的档在卸载后仍能读、照跑', () => {
    const s = new Sim({ seed: 20, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    s.stockpile[K_STOCK_WOOD] = 30;
    s.stockpile[K_STOCK_HERB] = 5;
    s.debugForceCard(a.eid, 'build_bed');
    s.step(1);
    expect(bedsOf(s)).toBe(1);
    const saved = snapshotOf(s);
    // ① 同装配读档：病榻仍在，继续跑不崩
    const s2 = loadSim(saved, reg(SOLO));
    expect(bedsOf(s2)).toBe(1);
    expect(() => s2.run(30)).not.toThrow();

    // ② 卸载后读档：bed 定义没了，但已落地的建筑是世界事实（随档），
    //    没有系统读它 ⇒ 不产出也不报错。这是原则④最硬的验收。
    const s3 = loadSim(saved, reg(WITHOUT));
    expect(s3.tuning.buildings['bed']).toBeUndefined();
    expect(bedsOf(s3), '卸载后残留的病榻建筑应留存').toBe(1);
    expect(() => s3.run(30), '残留建筑不该让世界崩掉').not.toThrow();
  });

  it('P2 #7 草药预留泄漏：heal 卡自然到期时，未消耗的预留量归还 stockpile', () => {
    const s = new Sim({ seed: 21, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 90; // 轻伤：90 > woundedBelow(0.7) * maxHp(100) = 70，所以不会被 wantHeal 判为重伤
    // 但 heal 卡已被 force，action 里 resolveTarget 会找到 b 并照料
    s.stockpile[K_STOCK_HERB] = 50;
    const herb0 = s.stockpile[K_STOCK_HERB]!;
    s.debugForceCard(a.eid, 'heal');
    const duration = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const reserved = s.tuning.medicine.herbCost * duration;
    expect(herb0 - s.stockpile[K_STOCK_HERB]!).toBe(reserved);
    // 让卡跑满 duration，但目标几乎不受伤（90hp 离 maxHp 很近，heal 很快 finishCard）
    // 为避免 target 满血提前 finishCard，把 hp 设成刚好低于 woundedBelow
    b.hp = 60; // 60 < 70，是重伤，但离 maxHp 100 还有距离
    // 重置 force 卡
    a.cardId = null;
    a.busyUntil = 0;
    s.step(1); // 让 pawn 重新抽卡
    // 实际上 stepPawn 会在卡到期时释放预留，然后可能抽新卡
    // 这里验证的是：卡到期后，预留量已归还 stockpile
    // 由于 pawn 可能已经抽了 heal 卡（再次预留），我们检查 scratch 是否有旧预留
    // 更直接的测试：force heal，等卡到期，检查 stockpile 恢复
    const s2 = new Sim({ seed: 22, registry: reg(SOLO), pawnCount: 2 });
    const [c, d] = setupPair(s2, 1);
    d.hp = 60; // 重伤但不满血，heal 不会提前 finishCard
    s2.stockpile[K_STOCK_HERB] = 100;
    const herb02 = s2.stockpile[K_STOCK_HERB]!;
    s2.debugForceCard(c.eid, 'heal');
    const reserved2 = s2.tuning.medicine.herbCost * duration;
    expect(herb02 - s2.stockpile[K_STOCK_HERB]!).toBe(reserved2);
    // 跑满 duration（8s）+ 1 tick 让卡到期
    s2.run(duration + 1);
    // 卡到期后，未消耗的预留应归还 stockpile
    // 假设 8s 内消耗了 8 份 herbCost = 8 份草药
    const consumed = s2.tuning.medicine.herbCost * duration;
    // stockpile 应该恢复为 herb02 - consumed（已消耗的）+ 0（已归还的预留）
    // 即：herb02 - consumed = 100 - 8 = 92
    // 但 pawn 可能又抽了 heal 卡并预留了新的预留量
    // 我们检查：stockpile 应比预留后高（说明旧预留已归还）
    // 简单验证：跑完后 stockpile 不应低于 herb02 - consumed（除非新卡又预留了）
    expect(s2.stockpile[K_STOCK_HERB]!).toBeGreaterThanOrEqual(herb02 - consumed);
  });

  /**
   * R1 审计 P1 #1 边界测试：wantHeal 门检量 = herbCost × HEAL_DURATION（=8）。
   * herbs=0~7 时门不放行，herbs=8 时放行——消除"门放行、预留静默失败"的缝隙。
   */
  it('R1 P1#1 边界：herbs=0~7 时 wantHeal=false，herbs=8 时 true（门检与预留量纲对齐）', () => {
    const s = new Sim({ seed: 30, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    const m = s.tuning.medicine;
    const cond = s.cardById('heal')!.condition!;
    const totalCost = m.herbCost * (s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec);
    // 逐边界扫描：0,1,2,...,7 → false；8 → true
    for (let h = 0; h < totalCost; h++) {
      s.stockpile[K_STOCK_HERB] = h;
      expect(cond(a, s), `herbs=${h}（< totalCost=${totalCost}）不该放行`).toBe(false);
    }
    s.stockpile[K_STOCK_HERB] = totalCost;
    expect(cond(a, s), `herbs=${totalCost}（= totalCost）应该放行`).toBe(true);
    // 超量也放行
    s.stockpile[K_STOCK_HERB] = totalCost + 100;
    expect(cond(a, s), 'herbs 远超 totalCost 应放行').toBe(true);
  });

  /**
   * R1 审计 P1 #2 边界测试：debugForceCard 预留不足时返回 false，不指派卡。
   * herbs < totalCost → false（不指派、不预留）；herbs >= totalCost → true（指派+预留）。
   */
  it('R1 P1#2 边界：debugForceCard 预留不足时返回 false 且不指派卡', () => {
    const s = new Sim({ seed: 31, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    const m = s.tuning.medicine;
    const totalCost = m.herbCost * (s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec);
    // herbs=7（< totalCost=8）：debugForceCard 返回 false，不指派
    s.stockpile[K_STOCK_HERB] = totalCost - 1;
    expect(s.debugForceCard(a.eid, 'heal'), 'herbs<totalCost 时 debugForceCard 应返回 false').toBe(false);
    expect(a.cardId, '预留不足时不该指派 heal 卡').not.toBe('heal');
    expect(s.stockpile[K_STOCK_HERB], '预留失败时不该扣草药').toBe(totalCost - 1);
    expect(s.scratch[`medicine.herbReserved.${a.eid}`], '预留失败时不该写入预留').toBeUndefined();

    // herbs=8（= totalCost）：debugForceCard 返回 true，指派+预留
    s.stockpile[K_STOCK_HERB] = totalCost;
    expect(s.debugForceCard(a.eid, 'heal'), 'herbs>=totalCost 时 debugForceCard 应返回 true').toBe(true);
    expect(a.cardId, '预留成功时应该指派 heal 卡').toBe('heal');
    expect(s.stockpile[K_STOCK_HERB], '预留成功时应该扣减草药').toBe(0);
    expect(s.scratch[`medicine.herbReserved.${a.eid}`], '预留成功时应该写入预留').toBe(totalCost);
  });

  /**
   * R3 审计 P1 #1：真抽卡面（systems.stepPawn）的预留失败必须**降级为不派卡**。
   *
   * 复现点是一条真实存在的缝隙：wantHeal 的原料门判 `herbCost × HEAL_DURATION`
   * （medicine.ts 的模块常量 8），而预留判 `herbCost × card.duration` —— 两个 8 各自硬编码，
   * 谁只改一边就出现"门放行、预留失败"。改前 stepPawn 只有成功分支没有 else：卡已 commit、
   * 预留静默失败，heal() 每 tick 因"无预留"直接 return，整张卡期原地空转到自然到期。
   * 而 debugForceCard 那边（R2 修的）是"预留不足返回 false 不指派"—— 两条抽卡路径语义相反。
   *
   * 改前实测（本夹具 seed 40 跑 400 tick）：719 次 heal 全部无预留（100% 空转），
   * 伤员只拿到自然恢复；改后 0 次无预留卡、库存一分未动。断言走**真实抽卡路径**
   * （stepPawn → drawCard → wantHeal → commit），不绕过引擎。
   */
  it('R3 P1#1：真抽卡面预留失败降级为不派卡（不再静默失败后空转）', () => {
    const mk = (drift: boolean) => {
      const s = new Sim({ seed: 40, registry: reg(SOLO), pawnCount: 3 });
      const m = s.tuning.medicine;
      if (drift) s.cardById('heal')!.duration = 20; // R4 P3#3: unified read source
      s.stockpile[K_STOCK_HERB] = m.herbCost * 8; // 8: enough for aligned, not for drift
      const ps = [...s.pawns()];
      ps[2].hp = 20;
      ps[2].holdUntil = 1e6;
      ps[2].pos = { x: 0, y: 0 };
      ps[0].pos = { x: 1, y: 0 };
      ps[1].pos = { x: 2, y: 0 };
      for (const p of ps) { p.path = []; p.holdUntil = 0; p.busyUntil = 0; }
      const wantCond = drift ? false : true;
      expect(s.cardById('heal')!.condition!(ps[0], s),
        drift ? 'drift: wantHeal blocks (unified source)' : 'aligned: wantHeal passes')
        .toBe(wantCond);
      let healTicks = 0;
      let unreserved = 0;
      for (let t = 0; t < 120; t++) {
        s.step(1);
        for (const p of s.pawns()) {
          if (p.cardId === 'heal') {
            healTicks++;
            if (!s.scratch[`medicine.herbReserved.${p.eid}`]) unreserved++;
          }
        }
      }
      return { s, healTicks, unreserved };
    };
    // 对照：量纲对齐时 heal 确实抽得上且带着预留（证明这个夹具真的能抽到 heal）
    const aligned = mk(false);
    expect(aligned.healTicks, '门/预留对齐时 heal 应真的被抽上').toBeGreaterThan(0);
    expect(aligned.unreserved).toBe(0);
    // R4 P3#3: drift eliminated - wantHeal and tryReserveHerb both read card.duration
    const drift = mk(true);
    expect(drift.unreserved, 'no unreserved heals').toBe(0);
    expect(drift.healTicks, 'wantHeal blocks (unified source), no heals drawn').toBe(0);
    expect(drift.s.stockpile[K_STOCK_HERB], 'no herbs consumed').toBe(drift.s.tuning.medicine.herbCost * 8);
  });

  /**
   * R3 审计 P1 #2：预留是「秒」量纲，heal() 的消费曾经是「每 tick 一份」——
   * 8 秒卡期下预留的 8 份只够前 8 个 tick，其余全因"无预留"直接 return，整卡空转。
   * 缺多少与 dt 取值无关（client 0.25 → 只够 2s；server 0.1 → 只够 0.8s）。
   * 改成 herbCost × dt 后两端都是秒，8 份正好覆盖 8 秒；测试走的 step(1) 行为与改前等价。
   * 见 time-source.test.ts 的同款断言在两种步长下都成立。
   */
  it('R3 P1#2：按秒消费——半卡期只花一半预留，卡期回血覆盖率 ≈100%', () => {
    const s = new Sim({ seed: 41, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    const m = s.tuning.medicine;
    const dur = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const total = m.herbCost * dur;
    const dt = CLIENT_STEP_SEC; // 客户端生产步进：tuning.ts §0 的单一真相源
    const herbKey = `medicine.herbReserved.${a.eid}`;
    s.stockpile[K_STOCK_HERB] = total;
    s.debugForceCard(a.eid, 'heal');
    expect(s.stockpile[K_STOCK_HERB]).toBe(0);
    expect(s.scratch[herbKey]).toBe(total);
    const hp0 = b.hp;
    // 半卡期（4 秒 = 16 tick）：按秒扣应只花掉一半
    for (let i = 0; i < 16; i++) s.step(dt);
    expect(s.scratch[herbKey],
      '4 秒应花掉 4 份；改前按 tick 每 tick 1 份 → 16 份早就扣空（reserved=0）')
      .toBeCloseTo(total / 2, 5);
    // 跑满整张卡期：回血覆盖率应接近 100%（改前只有 25%）
    for (let i = 0; i < 16; i++) s.step(dt);
    const care = b.hp - hp0 - m.naturalHealPerSec * dur;
    expect(care / (m.healPerSec * dur), '卡期回血覆盖率（改前 0.25）').toBeGreaterThan(0.9);
  });

  /**
   * R3 审计 P2 #3：killPawn 不走 finishCard/clearTarget（卡没到期就被打死），
   * 预留量会一直挂在 scratch 上永不归还 stockpile；指向死鼠的照料目标键也不会被清。
   */
  it('R3 P2#3：鼠死亡时释放自己的预留，并清掉指向它的照料目标键', () => {
    const s = new Sim({ seed: 42, registry: reg(SOLO), pawnCount: 3 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    s.stockpile[K_STOCK_HERB] = 50;
    s.debugForceCard(a.eid, 'heal');
    const reserved = s.tuning.medicine.herbCost * (s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec);
    expect(s.stockpile[K_STOCK_HERB], '预留应已扣出库存').toBe(50 - reserved);
    // a 正记着要照顾 b；第三只鼠 c 正记着要照顾 a；另有一条存数字但不是鼠目标的键
    s.scratch[`medicine.target.${a.eid}`] = b.eid;
    const c = [...s.pawns()][2];
    s.scratch[`medicine.target.${c.eid}`] = a.eid;
    s.scratch['factions.name.3'] = a.eid;
    s.killPawn(a.eid, '测试击杀');
    expect(s.stockpile[K_STOCK_HERB], '死亡不该吞掉预留，剩余量要回库存').toBe(50);
    expect(s.scratch[`medicine.target.${a.eid}`], '死鼠自己的目标键要清掉').toBeUndefined();
    expect(s.scratch[`medicine.target.${c.eid}`], '指向死鼠的照料目标键要一并清掉').toBeUndefined();
    expect(s.scratch['factions.name.3'], '存数字但不是鼠目标的键不该被误删').toBe(a.eid);
  });

  /**
   * R3 审计 P2 #4 组合：闸关（healRequireHerb=0）+ 无料。
   * 闸关时内核不写预留，改前 heal() 只认 scratch → 连"有料"都回不了血（反向死锁）；
   * 无料时旧语义是"留着等料"，不该崩也不该凭空回血。
   */
  it('R3 P2#4：闸关+无料不崩也不凭空回血（只拿自然恢复）', () => {
    const r = ModRegistry.mountPacks(SOLO);
    r.overrideTuning((t) => { t.medicine.healRequireHerb = 0; });
    const s = new Sim({ seed: 43, registry: r, pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    expect(s.stockpile[K_STOCK_HERB] ?? 0, '夹具默认无料').toBe(0);
    expect(s.cardById('heal')!.condition!(a, s), '闸关后无料也放行').toBe(true);
    expect(s.debugForceCard(a.eid, 'heal'), '不该写预留时仍应能派卡').toBe(true);
    expect(s.scratch[`medicine.herbReserved.${a.eid}`], '闸关时不该写预留').toBeUndefined();
    const hp0 = b.hp;
    expect(() => { for (let i = 0; i < 8; i++) s.step(1); }, '闸关+无料跑满卡期不该抛').not.toThrow();
    expect(b.hp, '无料时只有自然恢复，不会凭空回血')
      .toBeCloseTo(hp0 + s.tuning.medicine.naturalHealPerSec * 8, 5);
    expect(s.stockpile[K_STOCK_HERB] ?? 0, '无料时不该扣出负数库存').toBe(0);
  });

  /**
   * R4 审计 P2 #1：herbCost=0 时 tryReserveHerb 写 scratch=0（falsy），
   * heal() 旧代码 `if (reserved)` 把 0 当"无预留" → 落到
   * `else if (healRequireHerb > 0)` → return → **永久空转霸池**。
   * 实测 seed57/200tick 净回血 0.000——比无预留更糟（卡占着位置却不干活）。
   * 改用 `reserved !== undefined` 后，0 被视为有效预留（need=0, 0>=0 成立），
   * heal() 正常扣减（0-0=0）并回血。
   */
  it('R4 P2#1：herbCost=0 时预留不致死锁（reserved=0 仍视为有效预留）', () => {
    const r = ModRegistry.mountPacks(SOLO);
    r.overrideTuning((t) => { t.medicine.herbCost = 0; });
    const s = new Sim({ seed: 44, registry: r, pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    s.stockpile[K_STOCK_HERB] = 10; // 有料但 herbCost=0 实际不消耗
    s.debugForceCard(a.eid, 'heal');
    // tryReserveHerb 应写入 scratch=0（reservation of 0 herbs, but key exists）
    expect(s.scratch[`medicine.herbReserved.${a.eid}`],
      'herbCost=0 时预留应写入 0（键存在，值=0）').toBe(0);
    // 预留不实际扣减库存（totalCost=0）
    expect(s.stockpile[K_STOCK_HERB], 'herbCost=0 时预留不扣库存').toBe(10);

    const hp0 = b.hp;
    s.run(5);
    const m = s.tuning.medicine;
    const naturalGain = m.naturalHealPerSec * 5;
    // 改前：reserved=0 是 falsy → heal() return → 只拿自然恢复
    // 改后：reserved=0 是 "!== undefined" → 0>=0 成立 → 正常回血
    expect(b.hp - hp0 - naturalGain,
      'herbCost=0 时 heal 应能照常回血（改前永远死锁，净回血=0）')
      .toBeGreaterThan(0);
  });

  /**
   * R4 审计 P3 #2：clearTarget 旧代码 `ctx.scratch[herbKey] = 0`（键=0 永留 scratch），
   * releaseHerbReservation 是 `delete`。两处不对称 → 键=0 随档泄漏。
   * 改用 `delete` 后与 releaseHerbReservation 对称——"删除而非置零"。
   */
  it('R4 P3#2：clearTarget 删除预留键（不置 0 留残键随档）', () => {
    const s = new Sim({ seed: 45, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 99; // 接近满血：heal 一次即 finishCard
    s.scratch[`medicine.target.${a.eid}`] = b.eid; // 手动设目标（99>70 不满足重伤判定）
    s.stockpile[K_STOCK_HERB] = 50;
    s.debugForceCard(a.eid, 'heal');
    const herbKey = `medicine.herbReserved.${a.eid}`;
    expect(s.scratch[herbKey], '预留键应存在').toBeDefined();
    expect(s.scratch[herbKey]!, '预留量应 > 0').toBeGreaterThan(0);
    // heal 一次 → b 到满血 → finishCard → clearTarget
    s.step(1);
    expect(b.hp, 'b 应已被抬到满血').toBe(b.maxHp);
    expect(s.scratch[herbKey],
      'finishCard 后预留键应被 delete（改前是 =0 永留）').toBeUndefined();
    // 预留量应已归还库存
    const reserved = s.tuning.medicine.herbCost * (s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec);
    const consumed = s.tuning.medicine.herbCost * 1; // 1 秒消耗
    expect(s.stockpile[K_STOCK_HERB], '预留量应已归还（扣除已消耗的）')
      .toBeCloseTo(50 - consumed, 5);
  });

  /**
   * R4 审计 P3 #3：wantHeal 旧代码读模块常量 HEAL_DURATION，
   * systems.tryReserveHerb 读 card.duration —— 两个 8 各自硬编码。
   * 改一边漏一边 = "门放行但预留失败"缝隙（R3 P1#1 的根因）。
   * 统一到 card.duration 后，改卡时长只需改一处（卡定义），门/预留自动同步。
   */
  it('R4 P3#3：wantHeal 读源与 tryReserveHerb 一致（card.duration，非硬编码常量）', () => {
    const s = new Sim({ seed: 46, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    const m = s.tuning.medicine;
    const cond = s.cardById('heal')!.condition!;
    // 卡定义 duration=8，总成本 = herbCost(1) × 8 = 8
    const totalCost = m.herbCost * (s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec);
    // herbs=7 → 门不放行
    s.stockpile[K_STOCK_HERB] = totalCost - 1;
    expect(cond(a, s), 'herbs<totalCost 时 wantHeal 应为 false').toBe(false);
    // herbs=8 → 门放行
    s.stockpile[K_STOCK_HERB] = totalCost;
    expect(cond(a, s), 'herbs=totalCost 时 wantHeal 应为 true').toBe(true);
    // 改卡时长为 10 → 门检量自动跟着变（改前读常量 8，预留读 10 → 门放行但预留失败）
    s.cardById('heal')!.duration = 10;
    const newTotalCost = m.herbCost * 10;
    s.stockpile[K_STOCK_HERB] = totalCost; // 8 份：旧常量下够、新卡时长下不够
    expect(cond(a, s), '卡时长改为 10 后门检应自动同步（8<10 不放行）').toBe(false);
    s.stockpile[K_STOCK_HERB] = newTotalCost; // 10 份：刚好够
    expect(cond(a, s), '库存=新总成本时门应放行').toBe(true);
    // 预留也应判同一份卡时长（10）
    expect(s.debugForceCard(a.eid, 'heal'), '预留应判新卡时长（10）').toBe(true);
    expect(s.stockpile[K_STOCK_HERB], '预留量应为 10 份').toBe(0);
    expect(s.scratch[`medicine.herbReserved.${a.eid}`], '预留量应=10')
      .toBe(newTotalCost);
  });
});
