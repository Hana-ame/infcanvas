// 医疗玩法包（2026-08-14，插件化大系统实验：伤害-伤口层）
// 背景：内核战斗只有 HP 直伤（打掉血、死了算数），没有"受伤后遗症/慢病/治疗"层。
// 本包在 HP 之上加伤口层（RimWorld 式受伤规则，用户 2026-08-14 指定）：
//   ⓐ 伤口 = 实体：{ 类型(cut/bruise/burn), 部位(head/torso/limb), 愈合进度 0-1,
//                    出血中, 感染严重度 0-1 }，存 st.extra.wounds（存档 extra 扩展点）
//   ⓑ 自然愈合：不治疗也会随时间好转，愈合满 1 自动痊愈（cut 60s / bruise 90s / burn 120s）
//   ⓒ 出血：cut 新伤出血 → 失血(hp) + 心慌(san)；愈合过半自然凝血（小伤自愈），
//      大伤需治疗止血——RimWorld：出血是紧急态，不处理会失血而死
//   ⓓ 感染赛跑：未处理的 cut/burn 感染度随时间增长（头快四肢慢），感染中不愈合、
//      持续掉血+剧痛+理智流失；感染到 1 = 坏疽态（惩罚封顶，直到治疗）——
//      治疗成功感染度大幅回落（免疫胜利），RimWorld 式"免疫 vs 感染"
//   ⓔ 疼痛：所有伤口产生心情惩罚，随愈合消退（新伤最痛）
//   ⓕ 部位权重：命中概率 limb 60% / torso 30% / head 10%（RimWorld 命中分布）；
//      头部伤失血×2、疼痛×1.5（重伤位），躯干×1.5，四肢×1
//   ⓖ 治疗 = 处理（triage：感染 > 出血 > 新伤），成功止血 + 退感染 + 加速愈合，
//      不是"移除伤口"（RimWorld 语义：治疗是包扎/清创，愈合靠时间）
// 装配：before 'raid'（伤口结算先于新袭击），默认挂载（ModRegistry.default()）。
// 依赖：内核 heal 卡（physio）+ heal tag 建筑（篝火）+ craft 技能 + 存档 extra。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import { beginHeal } from '../../sim/systems/heal';
import type { PawnState } from '../../sim/sim';
import type { ModPack } from '../pack';

// 身体部位（RimWorld：头/躯干/四肢；本包四肢合并，命中权重见 CFG.partChance）
type BodyPart = 'head' | 'torso' | 'limb';
// 伤害类型：cut 切割/咬伤（出血+易感染）、bruise 钝伤淤青（闭合，不流血）、
// burn 烧伤（不流血但易感染、愈合慢——当前无火源生成，类型为未来火伤预留）
type WoundKind = 'cut' | 'bruise' | 'burn';

// 伤口实体（RimWorld 式：独立条目，携带部位/愈合/出血/感染状态）
interface Wound {
  kind: WoundKind;
  part: BodyPart;
  severity: number;    // 愈合进度 0-1（0 新伤 → 1 痊愈自动消除）
  bleeding: boolean;   // 出血中（cut 新伤）
  infection: number;   // 感染严重度 0-1（>0 感染中，到 1 坏疽态）
}

// 数值（本包小表，独立可调；不往内核 tuning 塞医疗参数——玩法包自治）
const CFG = {
  damagePerWound: 6,      // 累计受伤多少 HP 加一条伤口（血少掉血慢就不至于满身伤）
  // 部位命中权重（RimWorld：四肢最易中弹、躯干次之、头最低——头伤最致命所以最难中）
  partChance: { limb: 0.6, torso: 0.3, head: 0.1 },
  // 自然愈合时间（秒/条）：轻伤几分钟内好，重伤（burn）最慢（RimWorld：愈合需数天，这里游戏时间压缩）
  healTime: { cut: 60, bruise: 90, burn: 120 },
  // 疼痛 → 心情流失/秒（新伤满痛，随愈合线性消退：× (1 - severity)）
  painPerSec: { cut: 0.25, bruise: 0.15, burn: 0.35 },
  // 部位修正：头部重伤位（失血×2、疼痛×1.5）；躯干×1.5；四肢轻
  partMul: { head: { bleed: 2, pain: 1.5 }, torso: { bleed: 1.5, pain: 1.2 }, limb: { bleed: 1, pain: 0.7 } },
  bleedHpPerSec: 0.5,     // 出血失血/秒（×部位修正；出血窗口 ~30s → 四肢最多掉 15hp，头部 30hp 可控）
  bleedSanPerSec: 0.4,    // 出血掉 san/秒（看见自己流血，心慌）
  autoClotAt: 0.5,        // 愈合进度过半自动凝血（小伤自愈；大伤需治疗止血）
  // 感染增长/秒（已感染伤口的赛跑速度；burn 两倍速——烧伤易感染，RimWorld）
  infectRate: { head: 0.02, torso: 0.01, limb: 0.005 },
  infectChance: 0.02,     // 感染触发概率/60s 检定/伤口（头伤两倍；RimWorld：概率事件非必然）
  infectionHp: 0.15,      // 感染掉血/秒（不治拖成大病真会死人）
  infectionMood: 0.5,     // 感染心情流失/秒（发烧难受）
  infectionSan: 0.1,      // 感染理智流失/秒
  treatInterval: 4,       // 治疗每次检定的间隔秒数
  woundHealCheck: 50,     // 检定 DC（craft 技能百分制，初始约 15-25）
  tendSeverity: 0.3,      // 治疗成功 → 愈合进度 +（加速愈合）
  tendInfectionCut: 0.5,  // 治疗成功 → 感染严重度 -（免疫胜利，RimWorld 式回落）
  // 类型封顶（防同一瞬间挨多次咬堆叠；自然愈合会让数量自我收敛）
  // 发现背景：2026-08-14 旧版枚举伤口无上限堆叠 26 条 → san 恒 0 死锁；
  // 实体化 + 自然愈合后本不再是问题，封顶只兜底瞬间爆发。
  // 封顶后最大出血 san 流失 = 4 cut × 0.4 = 1.6/s < 篝火恢复 2.5/s → 火旁必恢复
  maxCut: 4,
  maxBruise: 3,
  maxBurn: 2,
};

const LABEL: Record<WoundKind, string> = { cut: '切割伤', bruise: '淤伤', burn: '烧伤' };
const PART_LABEL: Record<BodyPart, string> = { head: '头部', torso: '躯干', limb: '四肢' };

// 读取一小人的伤口列表（mod 系统专属字段，契约 JSON-safe）
// 旧档迁移：2026-08-14 前 wounds 是字符串数组（'bruise'|'bleed'|'infection'），
// 实体化后读取时把旧格式转成 Wound 实体（bleed → 出血 cut，infection → 感染的 cut）
const woundsOf = (st: PawnState): Wound[] => {
  const raw = st.extra?.wounds as unknown[] | undefined;
  if (!raw || raw.length === 0) return [];
  if (typeof raw[0] === 'string') {
    const migrated = (raw as string[]).map((s): Wound =>
      s === 'bleed' ? { kind: 'cut', part: 'limb', severity: 0.2, bleeding: true, infection: 0 }
      : s === 'infection' ? { kind: 'cut', part: 'limb', severity: 0.3, bleeding: false, infection: 0.6 }
      : { kind: 'bruise', part: 'limb', severity: 0.3, bleeding: false, infection: 0 });
    st.extra!.wounds = migrated;
    return migrated;
  }
  // 防御：字段校验——extra 是自由 JSON-safe 契约，可能写入任意结构
  //（发现背景：saveExtra 测试塞 {type,hp} 任意对象 → part 缺失 → partMul[undefined] 崩溃）
  // 注意：只在本帧读取时过滤，不写回——存档契约要求 extra 原样往返（saveExtra 测试保护），
  // 脏数据留在 extra 里无害（每帧都被过滤），只有真实伤口演化才写回
  const valid = raw.filter((w): w is Wound => {
    if (typeof w !== 'object' || !w) return false;
    const o = w as Record<string, unknown>;
    return (o.kind === 'cut' || o.kind === 'bruise' || o.kind === 'burn')
      && (o.part === 'head' || o.part === 'torso' || o.part === 'limb')
      && typeof o.severity === 'number'
      && typeof o.bleeding === 'boolean'
      && typeof o.infection === 'number';
  });
  return valid;
};

export const medicinePack: ModPack = {
  id: 'medicine',
// 依赖（2026-08-15 显式化）：无硬前置——treat 工作/治疗卡由 behavior 挂接（弱依赖：不挂则治疗不执行，伤口处理系统仍健康）
  requires: [],
  apply(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'medicine', label: '医疗', category: 'production',
    ctor: (sim) => new MedicineSystem(sim),
  });

  // 治疗卡：受伤（hp<90%）即可选——谓词层无 pawnState 访问器（CardContext 只有 view+eid），
  // 用声明式 needAt(health) 近似"有伤需养"（出血/感染必伴随掉血；纯淤青不流血会自然好，
  // 无需治疗卡——RimWorld 语义：淤青自己消）；执行器内部再精确检查 wounds。
  // 无伤口却抽到 → 执行器立即闲逛，不产生副作用（见 registerWork('treat') 开头判空）。
  m.registerCardDef({
    id: 'treat', name: '疗伤养伤', series: 'physio', weight: 5,
    needAt: { hp: 90 },
    utilityBase: 50,
    action: 'walkAndWork', workType: 'treat', label: '疗伤养伤',
    satisfies: [{ desire: 'wrath', amount: 1 }],
    // 注意：与内核 heal 卡（defs/cards.ts 直接回血）并存双疗伤路径——treat 管伤口
    // （wounds：出血/感染/重伤，需篝火旁时间），heal 管纯血量（无伤淤血自然好）。
    // 两卡不冲突：treat 执行器精确检查 wounds，无伤口即闲逛不副作用（见上注释）；
    // satisfies wrath 借暴怒位让"受伤想养伤"在抽卡效用里占一席（审计 2026-08-15 语义登记）
  });
  m.registerWork('treat', (c: SimContext, eid: number, st) => {
    const pos = c.pawnPositions.get(eid);
    if (!pos) return;
    if (woundsOf(st).length === 0) { st.job = '闲逛'; return; }
    // 走到篝火（heal tag）旁治疗；无篝火原地休养——与内核 heal 卡共用 beginHeal
    //（2026-08-20 收敛：此前两处同构复制，行为语义漂移会静默分叉，见 systems/heal.ts）
    beginHeal(c, eid, st);
    st.job = '疗伤养伤';
  });
  },
};

// 伤口层系统：
// ① 受伤检测（上帧 HP 对比 + 部位 roll）② 伤口演化（愈合/疼痛/出血/凝血/感染赛跑）
// ③ 治疗推进（walkAndWork 到点后逐帧检定，triage 目标：感染 > 出血 > 新伤）
export class MedicineSystem {
  id = 'medicine';
  private prevHp = new Map<number, number>(); // 上帧 HP（检测受伤差量）
  private treatTimer = new Map<number, number>(); // 每个小人治疗检定计时
  private infectTimer = 0; // 感染触发检定轮询（低频 60s，防每帧 roll rng 序列漂移）
  private woundEvalTimer = 0; // 2026-08-20 优化：伤口心情/san 评估 2s 一次（原每帧每人）

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    // ① 受伤检测：HP 下降累计 → 生成伤口（战斗直伤已扣血，伤口是"后遗症"，不再额外扣血）
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      const hp = this.ctx.readHealth(eid);
      if (!st || !hp) { this.prevHp.delete(eid); continue; }
      const prev = this.prevHp.get(eid) ?? hp.hp;
      const lost = prev - hp.hp;
      this.prevHp.set(eid, hp.hp);
      if (lost > 0) {
        st.extra = st.extra ?? {};
        const wounds = woundsOf(st);
        let acc = (st.extra.hurtAcc as number | undefined) ?? 0; // 受伤累计（伤害摊到伤口条数）
        acc += lost;
        while (acc >= CFG.damagePerWound) {
          acc -= CFG.damagePerWound;
          // 伤害来源只剩 lost 量：大伤 = 切割/咬伤（出血），小伤 = 钝伤淤青（RimWorld 伤害类型近似）
          const kind: WoundKind = lost >= CFG.damagePerWound ? 'cut' : 'bruise';
          // 部位 roll（命中权重：四肢 60% / 躯干 30% / 头 10%）
          const r = this.ctx.rng.next();
          const part: BodyPart = r < CFG.partChance.head ? 'head' : r < CFG.partChance.head + CFG.partChance.torso ? 'torso' : 'limb';
          const cap = kind === 'cut' ? CFG.maxCut : kind === 'bruise' ? CFG.maxBruise : CFG.maxBurn;
          if (wounds.filter((w) => w.kind === kind).length < cap) {
            const w: Wound = { kind, part, severity: 0, bleeding: kind === 'cut', infection: 0 };
            wounds.push(w);
            st.extra.wounds = wounds;
            this.ctx.logEvent(`🩸 #${eid} 受了${LABEL[kind]}（${PART_LABEL[part]}）${w.bleeding ? '，在流血' : ''}，需要养伤`);
          }
        }
        st.extra.hurtAcc = acc;
      }

      // ② 伤口演化（2026-08-20 优化：2s 一次评估替代每帧——伤口是慢变量，
      // 但用累计 dt 保证进度正确，不跳帧丢失愈合/失血进度）
      this.woundEvalTimer -= dt;
      const wounds = woundsOf(st);
      if (wounds.length > 0 && this.woundEvalTimer <= 0) {
        const evalDt = 2; // 累计 2s 的进度
        // mood/san 收口：原实现每伤口每帧各调 adjustMood（readNeeds+setNeeds+bus.emit 往返）
        // 和出血/感染分支的独立 readNeeds/setNeeds——伤口多时一帧 6 次往返，是 medicine 系统
        // 42% 耗时主因（profiler 定位）。收口后每 pawn 每帧至多 1 次 mood + 1 次 san 写回。
        let moodDelta = 0;
        let sanDelta = 0;
        for (const w of wounds) {
          const partMul = CFG.partMul[w.part];
          // 愈合：感染中不愈合（RimWorld：感染阻碍恢复）；满 1 痊愈移除
          if (w.infection <= 0) {
            w.severity = Math.min(1, w.severity + dt / CFG.healTime[w.kind]);
            if (w.severity >= 1) {
              // 痊愈：从数组移除并记日志（小伤口多时一条条报——低频可接受）
              wounds.splice(wounds.indexOf(w), 1);
              this.ctx.logEvent(`🩹 #${eid} 伤势痊愈`);
              continue;
            }
          }
          // 疼痛：新伤最痛，随愈合消退（RimWorld：pain 随时间/治疗降低）
          const pain = CFG.painPerSec[w.kind] * partMul.pain * (1 - w.severity) + (w.infection > 0 ? 0.3 : 0);
          if (pain > 0) moodDelta -= pain * dt;
          // 出血：失血 + 心慌；愈合过半自然凝血（小伤自愈；大伤需治疗止血）
          if (w.bleeding) {
            if (w.severity >= CFG.autoClotAt) {
              w.bleeding = false; // 自然凝血（RimWorld：小出血自己停）
            } else {
              const h = this.ctx.readHealth(eid);
              if (h && h.hp > 1) {
                h.hp = Math.max(1, h.hp - CFG.bleedHpPerSec * partMul.bleed * dt);
                this.ctx.setHealth(eid, h);
                // 失血同步进 prevHp：本系统的演化掉血不算"受伤"（RimWorld：伤口不会
                // 因为伤口而再添新伤——否则出血/感染掉血会无限生成新伤口，测试暴露）
                this.prevHp.set(eid, h.hp);
              }
              sanDelta -= CFG.bleedSanPerSec * dt;
            }
          }
          // 感染（已感染伤口的赛跑）：感染度按部位增长（头快四肢慢），感染中
          // 持续掉血 + 发烧剧痛 + 理智流失；到 1 = 坏疽态（惩罚封顶）。
          // 触发是概率事件（见下方 60s 检定）——RimWorld：感染不是必然，小伤口大多自愈
          if (w.infection > 0) {
            const rate = CFG.infectRate[w.part] * (w.kind === 'burn' ? 2 : 1);
            w.infection = Math.min(1, w.infection + rate * dt);
            const h = this.ctx.readHealth(eid);
            if (h && h.hp > 1) { h.hp = Math.max(1, h.hp - CFG.infectionHp * dt); this.ctx.setHealth(eid, h); this.prevHp.set(eid, h.hp); }
            moodDelta -= CFG.infectionMood * dt;
            sanDelta -= CFG.infectionSan * dt;
          }
        }
        st.extra!.wounds = wounds;
        // 收口写回（delta 语义与 adjustMood 一致，仅频率降为每 pawn 每帧一次）
        if (moodDelta !== 0) this.ctx.adjustMood(eid, moodDelta);
        if (sanDelta !== 0) {
          const n = this.ctx.readNeeds(eid);
          if (n) { n.san = Math.max(0, n.san + sanDelta); this.ctx.setNeeds(eid, n); }
        }
      }
    }

    // ③ 治疗推进：'treat' 工作的小人在篝火旁持续检定（walkAndWork 已把小人带到 healTarget）
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st || st.job !== '疗伤养伤') { this.treatTimer.delete(eid); continue; }
      const wounds = woundsOf(st);
      if (wounds.length === 0) { st.job = '闲逛'; continue; }
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      // 未到达治疗点（在脚步声里）不算治疗
      if (st.healTarget) {
        // 篝火被毁清理（2026-08-20 审查修复）：healTarget 指的建筑已不存在（raids 拆家/
        // 怒砸/清剿）→ 清理目标、退出疗伤态交给决策层重新规划。此前残留的目标坐标让
        // 距离判定恒 > 2.2 → 本分支永久 continue，小人卡在"疗伤养伤"等一座不存在的火
        const b = this.ctx.world.getBuilding(Math.round(st.healTarget.x), Math.round(st.healTarget.y));
        if (!b || !(b.def.tags?.includes('heal') ?? false)) {
          st.healTarget = undefined;
          st.healing = undefined;
          st.job = '闲逛';
          continue;
        }
        const d = Math.hypot(pos.x - st.healTarget.x, pos.y - st.healTarget.y);
        if (d > 2.2) continue;
      }
      let t = this.treatTimer.get(eid) ?? 0;
      t += dt;
      if (t < CFG.treatInterval) { this.treatTimer.set(eid, t); continue; }
      this.treatTimer.set(eid, 0);
      const r = this.ctx.rollEventSkill(eid, CFG.woundHealCheck, 'craft');
      if (r.success) {
        // triage 目标选择（RimWorld 医疗优先级：感染 > 出血 > 最新伤）
        const target =
          wounds.filter((w) => w.infection > 0).sort((a, b) => b.infection - a.infection)[0]
          ?? wounds.find((w) => w.bleeding)
          ?? wounds.reduce((a, b) => (a.severity <= b.severity ? a : b));
        target.bleeding = false;                                   // 止血（RimWorld：包扎停止出血）
        target.infection = Math.max(0, target.infection - CFG.tendInfectionCut); // 清创退烧（免疫胜利）
        target.severity = Math.min(1, target.severity + CFG.tendSeverity);        // 愈合加速
        this.ctx.logEvent(`🏥 #${eid} 处理好了${LABEL[target.kind]}（${PART_LABEL[target.part]}）`);
      } else {
        this.ctx.logEvent(`😮💨 #${eid} 处理伤口失败，继续养伤`);
      }
    }

    // 感染触发（低频检定）：未感染伤口小概率感染（RimWorld：概率事件，免疫好/小伤自愈
    // 大多不会感染；头伤两倍概率——重伤位）。触发后进入感染赛跑（见演化段）。
    this.infectTimer -= dt;
    if (this.infectTimer <= 0) {
      this.infectTimer = 60;
      for (const eid of this.ctx.iterPawns) {
        const st = this.ctx.pawnStates.get(eid);
        if (!st || !st.extra) continue; // 无伤者跳过（extra 只在受过伤时创建）
        const wounds = woundsOf(st);
        for (const w of wounds) {
          if (w.infection > 0 || w.kind === 'bruise') continue; // 已感染/闭合伤跳过
          const chance = CFG.infectChance * (w.part === 'head' ? 2 : 1);
          if (this.ctx.rng.next() < chance) {
            w.infection = 0.3; // 起始低烧（RimWorld：感染从低严重度开始赛跑）
            this.ctx.logEvent(`🤒 #${eid} 的${LABEL[w.kind]}（${PART_LABEL[w.part]}）感染了，需要治疗`);
          }
        }
        // 只有真实伤口才写回（脏数据不持久化清理——见 woundsOf 注释）
        if (wounds.length > 0) st.extra.wounds = wounds;
      }
    }
  }
}
