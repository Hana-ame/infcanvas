// 制衣玩法包（2026-08-15 用户需求「服装制作：服饰风格」+「染料+设计（=科技抽卡）+材质」）
// 设计三要素：
//   材质（两路原料 → 差异化属性）：皮路线（pelt 猫掉 → leather 鞣制 → 皮衣/皮大衣，保暖型
//     warmth 正数）+ 麻路线（flaxBush 野外采 → linen 织布 → 亚麻衫，散热型 warmth 负数——
//     夏天穿麻衣凉爽）。原料稀缺度不同：皮要打猫（风险换保暖），麻要采野（密度 0.4%）。
//   染料（三色野外植物 → 染色 = 悦目心情加成）：red/blue/yellow 各 0.25% 密度（比香料更稀），
//     染色配方 = 任意衣服 + 对应染料 → 染色版（warmth 同款，穿戴心情 +2 悦目）。
//   设计（= 科技抽卡）：4 个制衣科技（craft:clothing/linen/coat/dye）走 TECH_ORDER 独立抽卡池
//     碎片制解锁；裁缝台（loom）被 craft:clothing 门控建造；款式/染色配方由包内科技表
//     （TECH_OF）门控生产——与 BuildingDef.tech 门控建造同语义（"没研发就不许做"）。
// 装配：独立系统 TailorSystem（不依赖 craft 系统，cooking 先例——批量生产读 meta.tailor
//   配方表）；默认挂载；hg（游牧）局无 techPool 抽卡 → 科技永不解锁 → 裁缝台建不了（合理：
//   游牧不织布），猫 loot 被 hg override 成 food → 皮来源也断，整套功能自然休眠。
// 纯插件纪律（2026-08-15 用户指摘"内核为什么需要扩展"）：本包只用三个内核协议面——
//   ① ItemDef.meta（对齐 BuildingDef.meta 的通用容器，warmth/wearable 放 meta 不放顶层）；
//   ② Command 'wear'（命令协议成员，处理逻辑全在此包）；③ noise 生成层 4 种子轴（spice 先例）。
//   穿戴状态存 PawnState.extra.worn = { body?: string }（存档扩展点，自动随档零改动）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { GameSystem } from '../../sim/systems/registry';
import type { RecipeDef } from '../../sim/defs/recipes';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';
// 跨包契约键常量（2026-08-15 一致性：写方/读方引用同一权威常量，拼错 = 编译期错误）
import { K_WARMTH, K_WEARABLE, K_WORN, K_DYE } from '../../sim/mods/contracts';

// 本包数值（玩法包自治，注释数值意图）
const CFG = {
  // 心情：穿上 +wearMood；染色款额外 +dyeMood（悦目——染色的价值就是好看）
  wearMood: 3,
  dyeMood: 2,
};

// 衣物色名（2026-08-15 一致性解耦：色**值** = 表现层数据，归 renderer 本地色表
// DYE_COLORS；本包只持数据语义的染料 id（red/blue/yellow）与中文色名（物品名/配方名）——
// 服务端不持有颜色值，避免服务端/客户端两处色值来源不一致）
export const DYE_NAMES: Record<string, string> = { red: '红', blue: '蓝', yellow: '黄' };

const BASES = ['peltShirt', 'linenShirt', 'leatherCoat'];
const DYES = ['red', 'blue', 'yellow'];
const DYE_ITEMS: Record<string, string> = { red: 'redDye', blue: 'blueDye', yellow: 'yellowDye' };

// 配方科技门控表（包内表，不走内核 RecipeDef——2026-08-15 用户指摘后撤回内核扩展：
// 款式 = 设计 = 科技，门控是制衣玩法自己的规则）
const TECH_OF: Record<string, string> = {
  linen: 'craft:linen',
  linenShirt: 'craft:linen',
  leatherCoat: 'craft:coat',
};

const dyeTechOf = (rid: string): string | undefined => (rid.startsWith('dye_') ? 'craft:dye' : undefined);
const techOf = (rid: string): string | undefined => TECH_OF[rid] ?? dyeTechOf(rid);

// 衣物物品（材质 → 保暖/散热；meta.warmth 由 thermo 包读取调节有效温度）
const CLOTHES: Record<string, { name: string; warmth: number }> = {
  peltShirt: { name: '粗糙皮衣', warmth: 3 },   // 皮路线基础款：勒上兽皮，御寒一般
  linenShirt: { name: '亚麻衫', warmth: -1 },   // 麻路线：轻散热，夏天穿凉爽
  leatherCoat: { name: '皮大衣', warmth: 6 },   // 皮路线进阶（科技）：厚鞣皮，严寒主力
};

export const clothingPack: ModPack = {
  id: 'clothing',
// 依赖（2026-08-15 显式化）：无硬前置——cat 是内核 defs（皮来源生态位属 raid 包，可选联动）；thermo 读 meta.warmth 同为可选联动
  requires: [],
  apply(m: ModRegistry): void {
    // ---- 地形（spiceBush 模式：可通行灌木 + growable/harvest 数据驱动自动接入采集）----
    for (const t of [
      { id: 'flaxBush', name: '亚麻丛', product: 'flax' },
      { id: 'redBush', name: '红莓丛', product: 'redDye' },
      { id: 'blueBush', name: '蓝莓丛', product: 'blueDye' },
      { id: 'yellowBush', name: '黄莓丛', product: 'yellowDye' },
    ]) {
      m.registerTile({
        id: t.id, name: t.name, z: 0, passable: true, buildable: false, moveCost: 1.2,
        color: t.id === 'flaxBush' ? '#8a9a4a' : '#9a6a5a', emoji: '🌿',
        growable: true,
        harvest: { product: t.product, time: 1.5, yieldSuccess: 2, yieldFail: 1, dc: 50 },
        // 生成层点缀（TileDef.sparse 数据驱动，2026-08-15 数据化）：亚麻 0.4% 密度、
        // 染料各 0.25%——密度刻意低于香料（衣服是后期玩法，原料稀缺）；独立轴种子由
        // World 构造按 defs 收集序派生，改密度不影响其它点缀
        sparse: { density: t.id === 'flaxBush' ? 0.004 : 0.0025 },
      });
    }
    // ---- 物品（原料/中间品/染料/衣物；衣物标 meta.wearable + meta.warmth）----
    for (const it of [
      { id: 'flax', name: '亚麻纤维' },
      { id: 'pelt', name: '兽皮' },
      { id: 'linen', name: '麻布' },
      { id: 'leather', name: '皮革' },
      { id: 'redDye', name: '红染料' },
      { id: 'blueDye', name: '蓝染料' },
      { id: 'yellowDye', name: '黄染料' },
    ]) m.registerItem({ id: it.id, name: it.name });
    for (const [id, c] of Object.entries(CLOTHES)) {
      m.registerItem({ id, name: c.name, meta: { [K_WEARABLE]: true, [K_WARMTH]: c.warmth } });
    }
    // 染色版衣物：同款同 warmth，染上颜色（悦目心情由 wear 命令查染料前缀给）
    for (const d of DYES) {
      for (const base of BASES) {
        const id = `${d}_${base}`;
        m.registerItem({
          id, name: `${DYE_NAMES[d]}的${CLOTHES[base].name}`,
          meta: { [K_WEARABLE]: true, [K_WARMTH]: CLOTHES[base].warmth, [K_DYE]: d },
        });
      }
    }
    // ---- 配方（裁缝台批量生产；interval 节奏，多台共享均分）----
    for (const r of [
      { id: 'leather', name: '鞣制皮革', input: [{ item: 'pelt', amount: 2 }], output: { item: 'leather', amount: 1 }, interval: 5 },
      { id: 'linen', name: '织麻布', input: [{ item: 'flax', amount: 4 }], output: { item: 'linen', amount: 2 }, interval: 6 },
      { id: 'peltShirt', name: '缝制皮衣', input: [{ item: 'leather', amount: 1 }], output: { item: 'peltShirt', amount: 1 }, interval: 6 },
      { id: 'linenShirt', name: '裁剪亚麻衫', input: [{ item: 'linen', amount: 2 }], output: { item: 'linenShirt', amount: 1 }, interval: 6 },
      { id: 'leatherCoat', name: '鞣制皮大衣', input: [{ item: 'leather', amount: 2 }], output: { item: 'leatherCoat', amount: 1 }, interval: 8 },
    ]) m.registerRecipe({ id: r.id, name: r.name, kind: 'batch', input: r.input, output: r.output, interval: r.interval });
    // 染色配方（程序生成：base + dye → 染色版）
    for (const d of DYES) {
      for (const base of BASES) {
        m.registerRecipe({
          id: `dye_${d}_${base}`, name: `染${CLOTHES[base].name}（${DYE_NAMES[d]}）`, kind: 'batch',
          input: [{ item: base, amount: 1 }, { item: DYE_ITEMS[d], amount: 1 }],
          output: { item: `${d}_${base}`, amount: 1 },
          interval: 4,
        });
      }
    }
    // ---- 科技（设计 = 抽卡解锁：4 个制衣科技进 TECH_ORDER 表尾 = 后期解锁）----
    m.registerTech({ id: 'craft:clothing', name: '制衣术', unlocks: ['loom'], desc: '搭建裁缝台，鞣皮缝制衣物', fragments: 3 });
    m.registerTech({ id: 'craft:linen', name: '织布术', unlocks: [], desc: '亚麻织布，裁剪轻薄麻衣', fragments: 3 });
    m.registerTech({ id: 'craft:coat', name: '皮衣鞣制', unlocks: [], desc: '厚鞣兽皮，缝制御寒皮大衣', fragments: 3 });
    m.registerTech({ id: 'craft:dye', name: '染色术', unlocks: [], desc: '用浆果榨染，给衣服染上颜色', fragments: 3 });
    // ---- 裁缝台（craft:clothing 门控建造；meta.tailor = 本台可产配方表，数据驱动）----
    m.registerBuilding({
      id: 'loom', name: '裁缝台', size: { x: 1, y: 1 }, hp: 150, color: '#8a6a4a',
      emoji: '🧵', passable: false, buildTime: 5, costWood: 15,
      tech: 'craft:clothing', tags: ['craft', 'cloth'],
      meta: {
        // 本台可产配方（TailorSystem 遍历此表；含染色配方——染色也是裁缝台的活）
        tailor: [
          'leather', 'linen', 'peltShirt', 'linenShirt', 'leatherCoat',
          ...DYES.flatMap((d) => BASES.map((b) => `dye_${d}_${b}`)),
        ],
      },
    });
    // ---- 系统：TailorSystem（id 'clothing'，独立系统不依赖 craft）----
    m.registerSystemDef({ id: 'clothing', label: '制衣', category: 'production', ctor: (s: Sim) => new TailorSystem(s) });
    // ---- 穿戴命令（命令协议 'wear' 由本包注册：type 开放字符串 + args 通用位，
//   内核零改动；穿/换/脱，处理逻辑全在此包）----
    m.registerCommand('wear', (ctx, cmd) => {
      const eid = cmd.pawnId ?? ctx.selected[0];
      const st = ctx.pawnStates.get(eid);
      if (!st) return;
      const itemId = cmd.args?.['itemId'] as string | undefined; // 缺省 = 脱衣
      const worn = (st.extra?.[K_WORN] as { body?: string } | undefined) ?? {};
      const old = worn.body;
      // 脱衣：无 itemId → 旧衣回库存
      if (!itemId) {
        if (old) {
          ctx.stockpile[old] = (ctx.stockpile[old] ?? 0) + 1;
          st.extra = { ...st.extra, worn: {} };
          ctx.logEvent(`🧵 #${eid} 脱下 ${itemName(ctx, old)}`);
        }
        return;
      }
      const item = itemId ? ctx.mods.items[itemId] : undefined;
      // 读侧与写侧（registerItem 用 [K_WEARABLE]）同一常量——契约纪律：跨包键一律引用
      // K_* 常量（拼错 = 编译期错误；裸串曾漏网，审计 2026-08-15 修复）
      if (!item?.meta?.[K_WEARABLE]) { ctx.logEvent(`📛 无法穿戴：${itemId}`); return; }
      if ((ctx.stockpile[itemId!] ?? 0) < 1) { ctx.logEvent(`📛 没有 ${item.name} 可穿（库存 0）`); return; }
      ctx.stockpile[itemId!] -= 1;
      if (old) ctx.stockpile[old] = (ctx.stockpile[old] ?? 0) + 1; // 换装：旧衣回库存
      st.extra = { ...st.extra, worn: { body: itemId } };
      // 染色款心情加成（悦目——染色的价值）；日志区分 🧵（素衣）/🎨（染色）
      const dyed = Boolean(item.meta[K_DYE]);
      ctx.adjustMood(eid, CFG.wearMood + (dyed ? CFG.dyeMood : 0));
      ctx.logEvent(`${dyed ? '🎨' : '🧵'} #${eid} 穿上 ${item.name}${old ? `（换下 ${itemName(ctx, old)}）` : ''}`);
    });
    // ---- 皮来源：猫击杀掉 pelt（替代原 ore；掠夺者 raider 保持 ore）----
    // overrideDef 深合并：loot 整体替换为 pelt——皮 = 打猫的凶险回报（狩猎/守家防猫都有）
    m.overrideDef('enemy', 'cat', { loot: { item: 'pelt', amount: 2 } });
  },
};

const itemName = (ctx: SimContext, id: string): string => ctx.mods.items[id]?.name ?? id;

// 制衣系统：遍历全图裁缝台（def.meta.tailor 配方表），每配方独立节奏批量生产
//（cooking 先例：独立系统，多台共享冷却、节奏随台数均分；科技门控/原料够才产，不刷屏日志）
export class TailorSystem implements GameSystem {
  id = 'clothing';
  private cds = new Map<string, number>(); // 配方 id → 剩余冷却（每配方独立节奏）

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    // 统计裁缝台：配方 id → 台数（建筑 def.meta.tailor = 可产配方表）
    const counts = new Map<string, number>();
    const recipes = new Map<string, RecipeDef>();
    for (const [, b] of this.ctx.world.buildings) {
      const list = b.def.meta?.['tailor'];
      if (!Array.isArray(list)) continue;
      for (const rid of list as string[]) {
        const r = this.ctx.recipe(rid);
        if (!r || r.kind !== 'batch') continue;
        recipes.set(rid, r);
        counts.set(rid, (counts.get(rid) ?? 0) + 1);
      }
    }
    if (recipes.size === 0) return;
    // 各配方独立冷却推进
    for (const [rid, r] of recipes) {
      const cd = this.cds.get(rid) ?? 0;
      const next = cd - dt;
      this.cds.set(rid, next);
      if (next > 0) continue;
      // 节奏 = interval / 台数（多台均分）；节流到点才开始
      this.cds.set(rid, (r.interval ?? 6) / Math.max(1, counts.get(rid)!));
      // 科技门控（款式 = 设计 = 科技抽卡解锁；未研发不产，静默）
      const tech = techOf(rid);
      if (tech && !this.ctx.techs.has(tech)) continue;
      // 原料够才产（缺料静默——每配方各自等待，互不阻塞）
      if (!(r.input ?? []).every((inp) => (this.ctx.stockpile[inp.item] ?? 0) >= inp.amount)) continue;
      for (const inp of r.input ?? []) this.ctx.stockpile[inp.item] -= inp.amount;
      this.ctx.stockpile[r.output.item] = (this.ctx.stockpile[r.output.item] ?? 0) + r.output.amount;
      this.ctx.logEvent(`🧵 ${r.name}完成（${r.output.item} +${r.output.amount}）`);
    }
  }
}

// 穿戴查询工具（thermo 渲染包共用契约：PawnState.extra.worn.body = 衣物物品 id）
export const wornBodyOf = (st: { extra?: Record<string, unknown> } | undefined): string | undefined =>
  (st?.extra?.[K_WORN] as { body?: string } | undefined)?.body;
