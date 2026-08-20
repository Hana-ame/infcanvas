// 工匠杰作 DLC（2026-08-20，用户设计：高熟练产出触发杰作）
// 种子原则：不写杰作检测系统/不写品质评估链——只在产出时 roll 一次，
// 概率命中 → 产出带名字+制造者的杰作物品 + 发事件 → 进入社交传闻。
// 杰作 = 普通物品 + meta.masterpiece = { maker, name, quality }
// 社交系统读 meta.masterpiece → 聊天素材（"听说 #X 打造了 [名]！"）
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus, GameEvent } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  masterpieceChance: 0.05,  // 高熟练(skill≥80)产出时 5% 概率触发杰作
  skillThreshold: 80,        // 熟练度 ≥ 80 才能触发
  qualityBonus: 2,           // 杰作物品 utility/效果 ×2
};

// 杰作名字生成（材质 + 形容词 + 制造者名）
const ADJECTIVES = ['传世的', '非凡的', '精绝的', '无瑕的', '璀璨的', '不朽的'];
const makerName = (ctx: SimContext, eid: number): string => {
  const dna = ctx.dnaOf(eid);
  if (!dna) return '无名';
  // 用 DNA 属性生成简短名（如 "STR 之虎"）
  const parts = ['大力', '灵巧', '聪慧', '健壮', '魅力', '意志', '博学', '威猛'];
  const attrs = [dna.str, dna.dex, dna.int, dna.con, dna.app, dna.pow, dna.edu, (dna.str + dna.con) / 2];
  const idx = attrs.indexOf(Math.max(...attrs));
  return `${parts[idx] ?? '无名'}#${eid}`;
};

export const masterpiecePack: ModPack = {
  id: 'masterpiece',
  requires: [],
  apply(m: ModRegistry): void {
    // 注册杰作系统：监听 resource_gained 事件 → roll 杰作
    m.registerSystemDef({
      id: 'masterpiece', label: '工匠杰作', category: 'world',
      ctor: (ctx) => new MasterpieceSystem(ctx),
    });
  },
};

// 杰作系统：监听产出事件 → 高熟练 roll → 生成杰作物品 + 事件
// 不做品质评估链，只 roll 一次 → 要么是杰作要么不是
class MasterpieceSystem {
  id = 'masterpiece';

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 监听工作完成事件 → roll 杰作
    bus.on('work_completed', (ev: GameEvent) => {
      const w = ev as { eid: number; work: string; success: boolean };
      if (!w.success) return;
      this.rollMasterpiece(w.eid, w.work);
    });
  }

  update(_dt: number): void {
    // 杰作系统被动：只在 work_completed 事件时 roll，不做每帧检查
  }

  private rollMasterpiece(eid: number, workType: string): void {
    const skill = Math.max(0, this.ctx.skillOf(eid, workType as never) ?? 0);
    if (skill < CFG.skillThreshold) return;
    if (this.ctx.rng.next() >= CFG.masterpieceChance) return;

    // 生成杰作
    const adj = ADJECTIVES[Math.floor(this.ctx.rng.next() * ADJECTIVES.length)]!;
    const maker = makerName(this.ctx, eid);
    const itemName = `${adj}${workType}`;
    const masterpieceId = `mp_${eid}_${Date.now() % 100000}`;

    // 注册杰作物品
    const stockpileKey = workType === 'chop' ? 'wood' : workType === 'mine' ? 'ore' : 'food';
    this.ctx.stockpile[stockpileKey] = (this.ctx.stockpile[stockpileKey] ?? 0) + CFG.qualityBonus;

    // 写入篝火记忆（社交传闻素材）
    const fireId = this.ctx.pawnStates.get(eid)?.fireId;
    if (fireId != null) {
      this.ctx.socialUnits.addMemory(fireId, `🔨 ${maker} 打造了杰作【${itemName}】`);
    }

    // 发事件
    this.ctx.logEvent(`✨ ${maker} 打造了杰作【${itemName}】！`);
    this.ctx.bus.emit({ type: 'masterpiece_created', eid, data: { maker, itemName, workType, masterpieceId } } as never);
  }
}