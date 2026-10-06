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

  it('方向性：force heal + 同伴重伤 + 库存有 herb → 同伴回血 且 herb 减少', () => {
    const s = new Sim({ seed: 11, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20; // 重伤：20 < 30% × 100
    s.stockpile[K_STOCK_HERB] = 50;
    const hp0 = b.hp;
    const herb0 = s.stockpile[K_STOCK_HERB]!;
    s.debugForceCard(a.eid, 'heal');
    s.step(1);
    s.step(1);
    s.step(1);
    // 回血必须远超自然恢复（3s × 0.05 = 0.15）——否则这条卡根本没在干活
    expect(b.hp - hp0).toBeGreaterThan(s.tuning.medicine.naturalHealPerSec * 3 + 1);
    // 草药确实被消耗，且精确到"每 tick 扣 herbCost 份"
    expect(s.stockpile[K_STOCK_HERB]).toBeLessThan(herb0);
    expect(herb0 - s.stockpile[K_STOCK_HERB]!).toBe(s.tuning.medicine.herbCost * 3);
  });

  it('磁铁范式：伤员在 magnet 内、work 外时 heal 的 condition 为真（抽卡硬闸，不是行为树）', () => {
    const s = new Sim({ seed: 12, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 5); // 5 > workRadius(2.5) 且 5 < magnetRadius(24)
    const m = s.tuning.medicine;
    expect(s.adjacent(a, b.pos.x, b.pos.y, m.healWorkRadius)).toBe(false); // 此刻确实还没到位
    b.hp = 20;
    const cond = s.cardById('heal')!.condition!;
    expect(cond(a, s), '伤员在磁铁半径内却抽不到 heal 卡 = 死代码').toBe(true);
    s.stockpile[K_STOCK_HERB] = 50;
    const hp0 = b.hp;
    s.debugForceCard(a.eid, 'heal');
    s.run(10); // 够 a 走到伤员身旁（5 格 / 4.5 格每秒 ≈ 1.1s）并照料若干 tick
    expect(b.hp, 'a 应该真的走过去并开始照料').toBeGreaterThan(hp0 + m.naturalHealPerSec * 10 + 1);
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

  it('缺料不崩：herb=0 时 heal 卡不报错、不额外回血（hunting 未挂载时的自然状态）', () => {
    const s = new Sim({ seed: 14, registry: reg(SOLO), pawnCount: 2 });
    const [a, b] = setupPair(s, 1);
    b.hp = 20;
    s.stockpile[K_STOCK_HERB] = 0;
    s.debugForceCard(a.eid, 'heal');
    const hp0 = b.hp;
    expect(() => {
      s.step(1);
      s.step(1);
      s.step(1);
    }).not.toThrow();
    // 只有自然恢复，没有照料加成
    expect(b.hp).toBeCloseTo(hp0 + s.tuning.medicine.naturalHealPerSec * 3, 5);
    // 卡**没**被提前收工：a 还占着照料位等草药（下一 tick 也许就到了）
    expect(a.cardId).toBe('heal');
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
});
