// 社交/流言系统（DESIGN §6 狗屁倒灶，微互动层——确定性模板，零 LLM）
// 小人相遇 → 打招呼/抱怨/表情 → 心情 + 好感度 + 话题传播（八卦）
// 话题素材：近期结构化历史（谁干了什么）→ 狗屁倒灶日志
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { fulfill } from '../core/desires';
import { socialLinesOf } from '../mods/registry';

export class SocialSystem implements GameSystem {
  id = 'social';
  private cd = 0; // 全系统社交节流（避免每帧刷）——间隔读 tuning.social.tickInterval

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.cd -= dt;
    // 社交冷却递减（每个小人独立）
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (st && (st.socialCd ?? 0) > 0) st.socialCd = (st.socialCd ?? 0) - dt;
    }
    if (this.cd > 0) return;
    this.cd = this.ctx.tuning.social.tickInterval;
    this.tickSocial();
  }

  private tickSocial(): void {
    const list = this.ctx.pawnList;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const posA = this.ctx.pawnPositions.get(a);
      if (!posA) continue;
      const stA = this.ctx.pawnStates.get(a);
      if (!stA) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const posB = this.ctx.pawnPositions.get(b);
        if (!posB) continue;
        if (Math.hypot(posA.x - posB.x, posA.y - posB.y) > this.ctx.tuning.social.meetDist) continue; // 相邻才算相遇
        this.interact(a, b, stA.socialCd ?? 0);
        this.relationEffects(a, b); // 关系影响（协作/口角），用户 Q8
      }
    }
  }

  // 关系效应（用户 Q8：社会关系支持协作/战争）
  // 好感高 → 协作心情加成；敌对 → 口角，积累冲突可能动手
  private relationEffects(a: number, b: number): void {
    const s = this.ctx.tuning.social;
    const stA = this.ctx.pawnStates.get(a)!;
    const rel = stA.relationships?.get(b) ?? 0;
    if (rel >= s.friendAt) {
      // 亲密：一起干活心情好
      this.ctx.adjustMood(a, s.moodFriend);
      const stB = this.ctx.pawnStates.get(b);
      if (stB) this.ctx.adjustMood(b, s.moodFriend);
    } else if (rel <= s.hostileAt) {
      // 敌对：口角升级，仇恨越深越容易动手
      const stB = this.ctx.pawnStates.get(b);
      if (!stB) return;
      // 关系每敌对 10 点 +0.4% 动手概率（rel=-50 → 28%），比固定 5% 更合理
      const punchChance = Math.max(s.punchChanceMin, Math.min(s.punchChanceMax, s.punchChanceBase + (Math.abs(rel) - Math.abs(s.hostileAt)) * s.punchChancePerHostility));
      if (this.ctx.rng.next() < punchChance) {
        // 动手（战争萌芽）：低力量者吃亏，负好感加深
        const dnaA = this.ctx.dnaOf(a);
        const dnaB = this.ctx.dnaOf(b);
        const strA = dnaA?.str ?? 40;
        const strB = dnaB?.str ?? 40;
        const winner = strA >= strB ? a : b;
        const loser = winner === a ? b : a;
        const hk = this.ctx.readHealth(loser);
        if (hk) {
          hk.hp = Math.max(1, hk.hp - s.punchDmg);
          this.ctx.setHealth(loser, hk);
        }
        const relLoser = stA.relationships ?? new Map();
        const relWinner = stB.relationships ?? new Map();
        const curA = relLoser.get(winner) ?? 0;
        const curB = relWinner.get(loser) ?? 0;
        relLoser.set(winner, Math.max(s.punchRelFloor, curA - s.punchRelLoss));
        relWinner.set(loser, Math.max(s.punchRelFloor, curB - s.punchRelLoss));
        stA.relationships = relLoser;
        stB.relationships = relWinner;
        this.ctx.adjustMood(winner, s.punchMoodWin);
        this.ctx.adjustMood(loser, s.punchMoodLose);
        this.ctx.logEvent(`👊 #${winner} 与 #${loser} 动手了！`);
      } else {
        this.ctx.adjustMood(a, s.moodHostile);
        this.ctx.adjustMood(b, s.moodHostile);
      }
    }
  }

  private interact(a: number, b: number, aCd: number): void {
    const s = this.ctx.tuning.social;
    // 社交冷却：避免连续刷屏
    if (aCd > 0) return;
    const stA = this.ctx.pawnStates.get(a)!;
    const stB = this.ctx.pawnStates.get(b);
    stA.socialCd = s.interactCdMin + Math.floor(this.ctx.rng.next() * (s.interactCdMax - s.interactCdMin));

    // 传教（信仰对抗，DESIGN §3 对抗检定）：高信仰者尝试说服邻居改信
    if (stB && (stA.faith ?? 0) >= s.preachFaithAt && this.ctx.rng.next() < s.preachChance) {
      this.preach(a, b);
      return;
    }

    const moodA = this.ctx.readNeeds(a)?.mood ?? this.ctx.tuning.needs.initMood;
    const moodB = this.ctx.readNeeds(b)?.mood ?? this.ctx.tuning.needs.initMood;
    // 心情共同决定基调；性格（APP 魅力）加分
    const dnaA = this.ctx.dnaOf(a);
    const charm = dnaA ? (dnaA.app - s.charmBase) / s.charmDiv : 0;
    let tone: 'positive' | 'negative' | 'neutral';
    if (moodA > s.toneHighAt && moodB > s.toneHighAt) tone = this.ctx.rng.next() < s.tonePosChance + charm ? 'positive' : 'neutral';
    else if (moodA < s.toneLowAt || moodB < s.toneLowAt) tone = this.ctx.rng.next() < s.toneNegChance ? 'negative' : 'neutral';
    else tone = this.ctx.rng.next() < s.toneNeutralChance ? 'neutral' : (this.ctx.rng.next() < s.toneNeutralChance ? 'positive' : 'negative');

    // 话题：优先转述听到的八卦（传播），否则从历史抽新素材
    const topic = this.pickTopic(a, stA);
    // 传播：把话题讲给对方（对方记住，TTL 内继续转述）；自己的话题保留（还能再传）
    if (topic && stB) {
      stB.gossip = { text: topic, heardAt: this.ctx.time };
      this.ctx.bus.emit({ type: 'gossip_spread', eid: b, topic, from: a });
    }

    // 好感度变化（双向，轻微）
    const relA = stA.relationships ?? new Map<number, number>();
    const delta = tone === 'positive' ? s.relDeltaPositive : tone === 'negative' ? s.relDeltaNegative : s.relDeltaNeutral;
    const curA = relA.get(b) ?? 0;
    relA.set(b, Math.max(s.relFloor, Math.min(s.relCap, curA + delta)));
    stA.relationships = relA;

    // 心情微调
    if (tone === 'positive') this.ctx.adjustMood(a, s.moodPositive);
    else if (tone === 'negative') this.ctx.adjustMood(a, s.moodNegative);

    // 文本（日志用）
    const line = this.line(tone);
    // 色欲满足（七宗罪全途径）：亲密社交互动 → 满足（参数 tuning.social.lustFulfillPerInteract）
    const dA = stA.desires;
    if (dA && tone === 'positive') fulfill(dA, 'lust', s.lustFulfillPerInteract);
    this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone, topic: topic ?? undefined });
    if (this.ctx.rng.next() < s.logChance || tone !== 'neutral') {
      this.ctx.logEvent(`💬 #${a} ${line} #${b}${topic ? `（${topic}）` : ''}`);
    }
  }

  // 传教：对抗检定（DESIGN §3）。传教者 魅力+信仰 vs 目标 意志
  // 成功 → 目标信仰升 + 好感升；失败 → 目标反感，传教者受挫
  private preach(a: number, b: number): void {
    const s = this.ctx.tuning.social;
    const stA = this.ctx.pawnStates.get(a)!;
    const stB = this.ctx.pawnStates.get(b);
    if (!stB) return;
    const dnaA = this.ctx.dnaOf(a);
    const dnaB = this.ctx.dnaOf(b);
    const app = dnaA?.app ?? 40;
    const faithA = stA.faith ?? 0;
    const powB = dnaB?.pow ?? 40;
    // 对抗：传教者 ATT（APP/2 + faith/2）vs 目标 守方（POW + 现有信仰抵抗）
    const att = app / s.preachAppDiv + faithA / s.preachFaithDiv;
    const def = powB + (stB.faith ?? 0) * s.preachResistFaith;
    const rollA = this.ctx.rng.int(1, 100) + att;
    const rollB = this.ctx.rng.int(1, 100) + def;
    const relA = stA.relationships ?? new Map<number, number>();
    if (rollA > rollB) {
      // 成功传教
      stB.faith = Math.min(100, (stB.faith ?? 0) + s.preachSucceedFaith);
      stA.faith = Math.min(100, faithA + s.preachSelfFaith);
      this.ctx.growSkill(a, 'social');
      relA.set(b, Math.max(s.relFloor, Math.min(s.relCap, (relA.get(b) ?? 0) + s.preachSucceedRel)));
      stA.relationships = relA;
      this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone: 'positive', topic: '布道' });
      this.ctx.logEvent(`🙏 #${a} 向 #${b} 布道，对方听了进去`);
    } else {
      // 失败：目标无动于衷甚至反感
      relA.set(b, Math.max(s.relFloor, Math.min(s.relCap, (relA.get(b) ?? 0) + s.preachFailRel)));
      stA.relationships = relA;
      this.ctx.adjustMood(a, s.preachFailMood);
      this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone: 'negative', topic: '布道' });
      this.ctx.logEvent(`🙅 #${b} 对 #${a} 的说教无动于衷`);
    }
  }

  private line(tone: 'positive' | 'negative' | 'neutral'): string {
    // 微互动文案查模板表（defs/socialLines.ts，mod 可 registerLine 扩展）
    const table = socialLinesOf();
    const pool = tone === 'positive' ? table.positive : tone === 'negative' ? table.negative : table.greet;
    return pool[Math.floor(this.ctx.rng.next() * pool.length)];
  }

  // 从结构化历史抽最近一条作话题（狗屁倒灶素材）
  // 话题选择（流言传播层，确定性模板）：优先聊"自己听到的八卦"（社交网络传播），
  // 否则从近期历史抽新话题；听到的八卦在 gossipTtl 内可转述给下一个相遇者
  private pickTopic(a: number, stA: { gossip?: { text: string; heardAt: number } }): string | null {
    const s = this.ctx.tuning.social;
    const my = stA.gossip;
    if (my && this.ctx.time - my.heardAt <= s.gossipTtl && this.ctx.rng.next() < s.gossipChance) {
      return my.text; // 转述听到的八卦（传播）
    }
    const rec = this.ctx.historyQuery?.({ limit: 8 }) ?? null;
    if (!rec || rec.length === 0) return null;
    const h = rec[Math.floor(this.ctx.rng.next() * rec.length)];
    // 话题文案查模板表（defs/socialLines.ts，mod 可 registerTopicTemplate 扩展）
    const pool = socialLinesOf().topics.filter((t) => t.event === h.type);
    if (pool.length === 0) return null;
    return pool[Math.floor(this.ctx.rng.next() * pool.length)].text(h.data ?? {});
  }
}
