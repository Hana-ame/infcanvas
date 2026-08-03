// 社交/流言系统（DESIGN §6 狗屁倒灶，微互动层——确定性模板，零 LLM）
// 小人相遇 → 打招呼/抱怨/表情 → 心情 + 好感度 + 话题传播（八卦）
// 话题素材：近期结构化历史（谁干了什么）→ 狗屁倒灶日志
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

const GREET = ['打个招呼', '点头致意', '打了个哈欠', '抱怨天气', '交换了个眼神', '小声嘀咕'];
const POSITIVE = ['夸了你', '分享了口粮', '拍了拍你的肩', '讲了个笑话'];
const NEGATIVE = ['瞪了你一眼', '说了句风凉话', '背着你偷笑', '嫌弃地走开'];

export class SocialSystem implements GameSystem {
  id = 'social';
  private cd = 2; // 全系统社交节流（避免每帧刷）

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
    this.cd = 2;
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
        if (Math.hypot(posA.x - posB.x, posA.y - posB.y) > 1.6) continue; // 相邻才算相遇
        this.interact(a, b, stA.socialCd ?? 0);
      }
    }
  }

  private interact(a: number, b: number, aCd: number): void {
    // 社交冷却：避免连续刷屏
    if (aCd > 0) return;
    const stA = this.ctx.pawnStates.get(a)!;
    const stB = this.ctx.pawnStates.get(b);
    stA.socialCd = 15 + Math.floor(this.ctx.rng.next() * 10);

    // 传教（信仰对抗，DESIGN §3 对抗检定）：高信仰者尝试说服邻居改信
    if (stB && (stA.faith ?? 0) >= 30 && this.ctx.rng.next() < 0.25) {
      this.preach(a, b);
      return;
    }

    const moodA = this.ctx.readNeeds(a)?.mood ?? 60;
    const moodB = this.ctx.readNeeds(b)?.mood ?? 60;
    // 心情共同决定基调；性格（APP 魅力）加分
    const dnaA = this.ctx.dnaOf(a);
    const charm = dnaA ? (dnaA.app - 30) / 100 : 0;
    let tone: 'positive' | 'negative' | 'neutral';
    if (moodA > 65 && moodB > 65) tone = this.ctx.rng.next() < 0.7 + charm ? 'positive' : 'neutral';
    else if (moodA < 25 || moodB < 25) tone = this.ctx.rng.next() < 0.7 ? 'negative' : 'neutral';
    else tone = this.ctx.rng.next() < 0.5 ? 'neutral' : (this.ctx.rng.next() < 0.5 ? 'positive' : 'negative');

    // 话题：从最近历史里抽一条（狗屁倒灶素材）
    const topic = this.pickTopic();

    // 好感度变化（双向，轻微）
    const relA = stA.relationships ?? new Map<number, number>();
    const delta = tone === 'positive' ? 3 : tone === 'negative' ? -4 : 1;
    const curA = relA.get(b) ?? 0;
    relA.set(b, Math.max(-50, Math.min(100, curA + delta)));
    stA.relationships = relA;

    // 心情微调
    if (tone === 'positive') this.ctx.adjustMood(a, 1);
    else if (tone === 'negative') this.ctx.adjustMood(a, -2);

    // 文本（日志用）
    const line = this.line(tone);
    this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone, topic: topic ?? undefined });
    if (this.ctx.rng.next() < 0.4 || tone !== 'neutral') {
      this.ctx.logEvent(`💬 #${a} ${line} #${b}${topic ? `（${topic}）` : ''}`);
    }
  }

  // 传教：对抗检定（DESIGN §3）。传教者 魅力+信仰 vs 目标 意志
  // 成功 → 目标信仰升 + 好感升；失败 → 目标反感，传教者受挫
  private preach(a: number, b: number): void {
    const stA = this.ctx.pawnStates.get(a)!;
    const stB = this.ctx.pawnStates.get(b);
    if (!stB) return;
    const dnaA = this.ctx.dnaOf(a);
    const dnaB = this.ctx.dnaOf(b);
    const app = dnaA?.app ?? 40;
    const faithA = stA.faith ?? 0;
    const powB = dnaB?.pow ?? 40;
    // 对抗：传教者 ATT（APP/2 + faith/2）vs 目标 守方（POW + 现有信仰抵抗）
    const att = app / 2 + faithA / 2;
    const def = powB + (stB.faith ?? 0) * 0.4;
    const rollA = this.ctx.rng.int(1, 100) + att;
    const rollB = this.ctx.rng.int(1, 100) + def;
    const relA = stA.relationships ?? new Map<number, number>();
    if (rollA > rollB) {
      // 成功传教
      stB.faith = Math.min(100, (stB.faith ?? 0) + 4);
      stA.faith = Math.min(100, faithA + 1);
      this.ctx.growSkill(a, 'social');
      relA.set(b, Math.max(-50, Math.min(100, (relA.get(b) ?? 0) + 6)));
      stA.relationships = relA;
      this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone: 'positive', topic: '布道' });
      this.ctx.logEvent(`🙏 #${a} 向 #${b} 布道，对方听了进去`);
    } else {
      // 失败：目标无动于衷甚至反感
      relA.set(b, Math.max(-50, Math.min(100, (relA.get(b) ?? 0) - 5)));
      stA.relationships = relA;
      this.ctx.adjustMood(a, -2);
      this.ctx.bus.emit({ type: 'social', eid: a, target: b, tone: 'negative', topic: '布道' });
      this.ctx.logEvent(`🙅 #${b} 对 #${a} 的说教无动于衷`);
    }
  }

  private line(tone: 'positive' | 'negative' | 'neutral'): string {
    const pool = tone === 'positive' ? POSITIVE : tone === 'negative' ? NEGATIVE : GREET;
    return pool[Math.floor(this.ctx.rng.next() * pool.length)];
  }

  // 从结构化历史抽最近一条作话题（狗屁倒灶素材）
  private pickTopic(): string | null {
    const rec = this.ctx.historyQuery?.({ limit: 8 }) ?? null;
    if (!rec || rec.length === 0) return null;
    const h = rec[Math.floor(this.ctx.rng.next() * rec.length)];
    if (h.type === 'work_completed') return `说他昨天${h.data?.success ? '干成了' : '没干成'}一单活`;
    if (h.type === 'pawn_died') return `议论昨天死的那个`;
    if (h.type === 'raid_started') return '聊起野狼袭击的事';
    if (h.type === 'building_built') return `说新盖了个${h.data?.defId}`;
    if (h.type === 'resource_gained') return `说他攒了点${h.data?.item}`;
    return null;
  }
}
