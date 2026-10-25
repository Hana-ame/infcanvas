/**
 * dlc-entry.ts —— 官方 DLC 扩展包注册表与运行时热插拔入口（满足「要有 dlc 入口」、「AImode移入dlc，默认不开启」及「搜刮逻辑作为DLC分开，默认禁用」）。
 *
 * 包含 6 个内置官方 DLC 扩展包：
 *  1. dlc-biotech-ratkin  —— 生物科技：鼠鼠基因工程与皇家鼠卫血统（Biotech: Ratkin Xenogenetics）
 *  2. dlc-raider-pvp      —— 铁血争霸：玩家扮演袭击指挥官与联机对战（Raid Commander PvP）
 *  3. dlc-royalty-empire  —— 皇权帝国：鼠国爵位与灵能技艺（Royalty: Ratkin Crown & Psycasts）
 *  4. dlc-ideology-cult   —— 文化信条：地穴丰饶祭坛与殖民地信仰（Ideology: Burrow Tenets）
 *  5. dlc-ruin-scavenge   —— 远古遗迹搜刮扩展包（Ruin Scavenging DLC · 默认禁用 defaultEnabled: false）
 *  6. dlc-ai-director     —— AImode：AI 自治建造与全自动叙事导演扩展包（默认不开启 defaultEnabled: false）
 */
import type { ModPack } from './pack';
import { DLC_PACKS } from './packs/playstyle';
import type { Sim } from '../sim/sim';

export interface DlcCatalogItem {
  id: string;
  aliasIds?: string[];
  title: string;
  subtitle: string;
  badgeColor: string;
  icon: string;
  description: string;
  highlights: string[];
  /** 是否默认开启 */
  defaultEnabled: boolean;
  deferred?: boolean;
  statusTag?: string;
  pack: ModPack;
}

export const dlcBiotechRatkinPack: ModPack = {
  id: 'dlc-biotech-ratkin',
  requires: [],
  dlc: { title: 'Biotech: 鼠鼠基因工程与血脉 (Ratkin Xenogenetics)', order: 1 },
  apply(m) {
    m.registerBuilding({
      id: 'gene_assembler',
      name: '基因组装舱 (Gene Assembler)',
      cost: { wood: 10, ore: 8 },
      hp: 160,
      tags: ['research', 'biotech'],
      passable: false,
      w: 2,
      h: 2,
    });
    m.registerItem({ id: 'xenogerm_ratkin_royal', name: '皇家鼠卫异种胚 (Royal Ratkin Xenogerm)' });
    m.registerPredicate('dlc.biotech.active', () => true);
  },
};

export const dlcRaiderPvpPack: ModPack = {
  id: 'dlc-raider-pvp',
  requires: [],
  dlc: { title: 'Raider PvP: 玩家扮演袭击与据点争霸 (Multiplayer Raid Commander)', order: 2 },
  apply(m) {
    m.registerBuilding({
      id: 'raid_beacon',
      name: '战术空投信标 (Orbital Raid Beacon)',
      cost: { wood: 8, ore: 6 },
      hp: 130,
      tags: ['waypoint', 'tower'],
      passable: true,
      w: 1,
      h: 1,
    });
    m.registerEnemy({
      id: 'siege_rat_mech',
      name: '重装破城鼠甲 (Siege Rat-Mech)',
      hp: 150,
      dmg: 15,
      speed: 3.5,
      atkCd: 1.6,
      climb: 2,
      drops: { ore: 8, gold: 4 },
    });
    m.registerPredicate('dlc.raider-pvp.active', () => true);
  },
};

export const dlcRoyaltyEmpirePack: ModPack = {
  id: 'dlc-royalty-empire',
  requires: [],
  dlc: { title: 'Royalty: 鼠国皇权与灵能 (Ratkin Crown & Psycasts)', order: 3 },
  apply(m) {
    m.registerBuilding({
      id: 'royal_throne',
      name: '黄金鼠王宝座 (Golden Ratkin Throne)',
      cost: { wood: 12, gold: 6 },
      hp: 220,
      tags: ['shelter', 'royalty'],
      passable: true,
      w: 2,
      h: 2,
    });
    m.registerItem({ id: 'psylink_neuroformer', name: '灵能神经成形器 (Psylink Neuroformer)' });
    m.registerPredicate('dlc.royalty.active', () => true);
  },
};

export const dlcIdeologyCultPack: ModPack = {
  id: 'dlc-ideology-cult',
  requires: [],
  dlc: { title: 'Ideology: 地穴信条与丰饶祭坛 (Burrow Ideoligion)', order: 4 },
  apply(m) {
    m.registerBuilding({
      id: 'ideology_altar',
      name: '丰饶橡果祭坛 (Acorn Ritual Altar)',
      cost: { wood: 14 },
      hp: 180,
      tags: ['shelter', 'waypoint'],
      passable: true,
      w: 2,
      h: 2,
    });
    m.registerPredicate('dlc.ideology.active', () => true);
  },
};

export const dlcRuinScavengePack: ModPack = {
  id: 'dlc-ruin-scavenge',
  requires: [],
  dlc: { title: 'Ruin Scavenging: 远古遗迹房间与物资搜刮扩展包 (默认禁用)', order: 5 },
  apply(m) {
    m.registerPredicate('dlc.ruin-scavenge.active', () => true);
  },
};

export const dlcAiDirectorPack: ModPack = {
  id: 'dlc-ai-director',
  requires: [],
  dlc: { title: 'AImode: AI 自治建造与全自动叙事导演扩展包 (默认不开启)', order: 6 },
  apply(m) {
    m.registerBuilding({
      id: 'ai_persona_core',
      name: '人格核心主脑 (AI Persona Core · AImode DLC)',
      cost: { ore: 16, gold: 8 },
      hp: 240,
      tags: ['research', 'ai_director'],
      passable: false,
      w: 2,
      h: 2,
    });
    m.registerPredicate('dlc.ai-director.active', () => true);
  },
};

export const DLC_CATALOG: readonly DlcCatalogItem[] = [
  {
    id: 'dlc-biotech-ratkin',
    title: 'Biotech · 鼠鼠基因工程 (Ratkin Xenogenetics)',
    subtitle: '官方扩展包 #1 · 种族基因与血脉合成',
    badgeColor: '#3a8fb7',
    icon: 'biotech',
    defaultEnabled: false,
    statusTag: '已实装可开关',
    description:
      '解锁鼠鼠族（Ratkin）全系异种基因拼接、皇家鼠卫血统、双亲 DNA 显隐性遗传与 2×2 基因组装舱建筑。',
    highlights: [
      '新增 2×2 多格建筑：基因组装舱 (Gene Assembler)',
      '新增基因：鼠耳灵觉 / 掘地利爪 / 钢毛皮甲 / 高速代谢',
      '支持殖民者实时基因拼接与属性强化',
    ],
    pack: dlcBiotechRatkinPack,
  },
  {
    id: 'dlc-raider-pvp',
    title: 'Raider Commander · 袭击扮演与多人争霸',
    subtitle: '官方扩展包 #2 · 非对称联机对抗与野生据点攻防',
    badgeColor: '#c94a4a',
    icon: 'raider',
    defaultEnabled: false,
    statusTag: '已实装可开关',
    description:
      '允许玩家化身 Raid 袭击指挥官，使用威胁点数投放攻城工兵、狙击弩鼠与重装破城鼠甲，或远征 5×5 野生敌对据点。',
    highlights: [
      '新增玩法：玩家扮演 Raid 指挥官投放并微操敌袭小队',
      '新增兵种：重装破城鼠甲 (Siege Rat-Mech)',
      '新增建筑：战术空投信标 (Orbital Raid Beacon)',
    ],
    pack: dlcRaiderPvpPack,
  },
  {
    id: 'dlc-royalty-empire',
    title: 'Royalty · 鼠国皇权与灵能',
    subtitle: '官方扩展包 #3 · 帝国爵位与灵能技艺',
    badgeColor: '#d4af37',
    icon: 'royalty',
    defaultEnabled: false,
    statusTag: '已实装可开关',
    description: '引入白桦皇家鼠卫爵位体系、2×2 黄金鼠王宝座以及灵能神经强化。',
    highlights: [
      '新增 2×2 多格建筑：黄金鼠王宝座 (Golden Ratkin Throne)',
      '新增皇家商队贡品与盟友空投特权',
    ],
    pack: dlcRoyaltyEmpirePack,
  },
  {
    id: 'dlc-ideology-cult',
    title: 'Ideology · 地穴信条与祭坛',
    subtitle: '官方扩展包 #4 · 殖民地戒律与丰收庆典',
    badgeColor: '#7b52ab',
    icon: 'ideology',
    defaultEnabled: false,
    statusTag: '已实装可开关',
    description: '为殖民地定制专属地穴信条、建造 2×2 丰饶橡果祭坛并举行全员振奋仪式。',
    highlights: [
      '新增 2×2 多格建筑：丰饶橡果祭坛 (Acorn Ritual Altar)',
      '仪式效果：全员心情与理智大幅恢复',
    ],
    pack: dlcIdeologyCultPack,
  },
  {
    id: 'dlc-ruin-scavenge',
    aliasIds: ['ruin_scavenge', 'ruins'],
    title: 'Ruin Scavenging · 远古遗迹搜刮扩展包 (默认禁用)',
    subtitle: '官方扩展包 #5 · 独立搜刮玩法 DLC (Default Disabled)',
    badgeColor: '#8d6e63',
    icon: 'ancient_locker',
    defaultEnabled: false,
    deferred: true,
    statusTag: '🔒 默认禁用 (可手动开启)',
    description:
      '将远古遗迹房间生成与储物柜/物资箱/实验终端搜刮逻辑拆分为独立 DLC，默认处于禁用状态，确保本体地图清爽纯粹。',
    highlights: [
      '默认禁用 (defaultEnabled: false)：本体不主动刷出遗迹搜刮建筑',
      '独立管理远古遗迹废墟房间、储物柜与军用物资箱搜刮机制',
    ],
    pack: dlcRuinScavengePack,
  },
  {
    id: 'dlc-ai-director',
    aliasIds: ['ai_mode', 'aimode', 'dlc-ai-mode'],
    title: 'AImode · AI 自治建造与叙事导演扩展包 (AI Mode DLC)',
    subtitle: '官方扩展包 #6 · 默认不开启 (Default Off · 推后实现)',
    badgeColor: '#6c7885',
    icon: 'ai_director',
    defaultEnabled: false,
    deferred: true,
    statusTag: '⏳ 默认关闭 / 推后实现 (Default Off)',
    description:
      'AImode 已移入独立 DLC 且默认不开启！玩家模式下全面屏蔽 AI 自主建造卡（build_*），所有建筑与基地布局 100% 由玩家在「建造规划」面板中决定。',
    highlights: [
      '默认不开启 (defaultEnabled: false)：本体 100% 由玩家规划建筑',
      '收纳归档：自主 AI 抽卡建房 (`build_*`) 与全自动 AI 叙事导演',
      '预留 2×2 建筑：人格核心主脑 (AI Persona Core)',
    ],
    pack: dlcAiDirectorPack,
  },
];

function resolveDlcItem(dlcId: string): DlcCatalogItem | undefined {
  const norm = dlcId.toLowerCase();
  return DLC_CATALOG.find(
    (x) => x.id === dlcId || x.id === norm || (x.aliasIds?.includes(norm) ?? false),
  );
}

/** 将官方 DLC 注册进全局 DLC_PACKS 表，供 ModRegistry.default({ dlc }) 直接挂载 */
export function registerOfficialDlcs(): void {
  if (!DLC_PACKS) return;
  for (const item of DLC_CATALOG) {
    DLC_PACKS[item.id] = item.pack;
    for (const alias of item.aliasIds ?? []) {
      DLC_PACKS[alias] = item.pack;
    }
  }
}

registerOfficialDlcs();

const activeSimDlcs = new WeakMap<Sim, Set<string>>();

export function getActiveSimDlcs(sim: Sim): Set<string> {
  let s = activeSimDlcs.get(sim);
  if (!s) {
    s = new Set(sim.reg.enabledDlcIds());
    activeSimDlcs.set(sim, s);
  }
  return s;
}

export function isAiModeDlcEnabled(sim: Sim): boolean {
  const s = getActiveSimDlcs(sim);
  return s.has('dlc-ai-director') || s.has('ai_mode') || s.has('aimode') || sim.reg.dlcEnabled('dlc-ai-director');
}

export function isRuinScavengeDlcEnabled(sim: Sim): boolean {
  const s = getActiveSimDlcs(sim);
  return s.has('dlc-ruin-scavenge') || s.has('ruin_scavenge') || sim.reg.dlcEnabled('dlc-ruin-scavenge');
}

/** 在运行中的 Sim 上热启用/停用某个官方 DLC（供游戏内 DLC 入口面板一键开关） */
export function toggleSimDlc(
  sim: Sim,
  dlcId: string,
  enable?: boolean,
): { ok: boolean; enabled: boolean; message: string } {
  const item = resolveDlcItem(dlcId);
  if (!item) return { ok: false, enabled: false, message: `未找到 DLC：${dlcId}` };
  const set = getActiveSimDlcs(sim);
  const next = enable !== undefined ? enable : !set.has(item.id);
  if (next) {
    set.add(item.id);
    for (const al of item.aliasIds ?? []) set.add(al);
    if (!sim.reg.isMounted(item.id)) {
      try {
        sim.reg.mountPack(item.pack);
      } catch {
        // 已注册同名条目时幂等跳过
      }
    }
    const eff = sim.reg.effectiveTuning();
    Object.assign(sim.tuning.buildings, eff.buildings);
    Object.assign(sim.tuning.enemies, eff.enemies);
    const suffix = item.deferred ? '（注：推后实现/扩展包处于可选开启态）' : '';
    const msg = `📦 已启用 DLC 扩展包：【${item.title}】${suffix}`;
    sim.log(msg);
    return { ok: true, enabled: true, message: msg };
  } else {
    set.delete(item.id);
    for (const al of item.aliasIds ?? []) set.delete(al);
    const msg = `📦 已停用 DLC 扩展包：【${item.title}】`;
    sim.log(msg);
    return { ok: true, enabled: false, message: msg };
  }
}

/** 在运行中的 Sim 上直接加载 JSON 格式的自定义 Mod 包（.mod.json） */
export function loadCustomModJsonOnSim(
  sim: Sim,
  rawJson: string,
): { ok: boolean; modId?: string; message: string } {
  try {
    const obj = JSON.parse(rawJson);
    const modId = obj.manifest?.id ?? obj.id;
    if (!modId || typeof modId !== 'string') {
      return { ok: false, message: 'Mod JSON 缺少 id 或 manifest.id' };
    }
    const defs = obj.defs ?? {
      buildings: obj.buildings,
      enemies: obj.enemies,
      items: obj.items,
      techs: obj.techs,
    };
    const pack: ModPack = {
      id: modId,
      requires: obj.manifest?.requires ?? [],
      dlc: { title: obj.manifest?.title ?? obj.title ?? modId },
      apply(m) {
        for (const b of defs.buildings ?? []) {
          if (!sim.tuning.buildings[b.id]) m.registerBuilding(b);
        }
        for (const e of defs.enemies ?? []) {
          if (!sim.tuning.enemies[e.id]) m.registerEnemy(e);
        }
        for (const it of defs.items ?? []) m.registerItem(it);
        for (const t of defs.techs ?? []) {
          if (!sim.tuning.techs[t.id]) m.registerTech(t);
        }
      },
    };
    if (!sim.reg.isMounted(pack.id)) {
      sim.reg.mountPack(pack);
    }
    for (const b of defs.buildings ?? []) {
      const { id, ...rest } = b;
      sim.tuning.buildings[id] = rest;
    }
    for (const e of defs.enemies ?? []) {
      const { id, ...rest } = e;
      sim.tuning.enemies[id] = rest;
    }
    for (const t of defs.techs ?? []) {
      const { id, ...rest } = t;
      sim.tuning.techs[id] = rest;
    }
    const set = getActiveSimDlcs(sim);
    set.add(modId);
    const msg = `🧩 成功挂载自定义 Mod 包：【${modId}】`;
    sim.log(msg);
    return { ok: true, modId, message: msg };
  } catch (err) {
    return { ok: false, message: `Mod JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
