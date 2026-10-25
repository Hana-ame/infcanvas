/**
 * client/ui-inspect-gear-health.ts —— RimWorld 1.5 原版截图级「健康 (ITab_Pawn_Health)」与「装备/武器 (ITab_Pawn_Gear)」检视面板（完整 i18n 双语版）。
 *
 * 严格对齐 RimWorld 原版截图布局，同时支持纯净简体中文 (`zh`) 与原版英文 (`en`) 无缝切换：
 *  1. 健康页签 (ITab_Pawn_Health)：
 *     - 左栏：概览 / 手术清单双子页签、自我包扎勾选框、医药策略切换、疼痛等级、失血速率、12 项生理机能效率列表。
 *     - 右栏：全身状态 (料理风味增益与基因血统) + 26 个独立解剖部位的左部位 HP 与右伤病状态/包扎/截肢/义体按钮。
 *  2. 装备与武器页签 (ITab_Pawn_Gear)：
 *     - 顶部三项核心指标：负重进度条、舒适温度范围、整体护甲三联表（利器/钝器/热能）。
 *     - 武器装备栏、穿戴服饰与护甲栏（头饰层/外套护甲层/贴身层）、随身行囊物品栏。
 */
import {
  BODY_PART_DEFS,
  CULINARY_INGREDIENTS,
  CULINARY_RECIPES,
  ITEM_WEIGHT_KG,
  type PawnState,
  Sim,
  amputateBodyPart,
  bandageBodyPartWithHerb,
  computeAnatomyCapacities,
  computePawnMaxCarryKg,
  consumeCulinaryDish,
  ensurePawnAnatomy,
  getActiveCulinaryBuff,
  inflictBodyPartInjury,
  spawnOutdoorItem,
  transplantBodyPart,
} from '../sim';
import { getUiLocale, t, tr } from './i18n';
import { svgIcon } from './ui-icons';

export interface WeaponSpec {
  id: string;
  zhName: string;
  enName: string;
  icon: string;
  zhQuality: string;
  enQuality: string;
  qualityColor: string;
  hpPct: number;
  damage: number;
  zhDamageType: string;
  enDamageType: string;
  armorPenPct: number;
  range: number;
  burstCount: number;
  cooldownSec: number;
  dps: number;
  massKg: number;
  accTouch: number;
  accShort: number;
  accMed: number;
  accLong: number;
  zhDesc: string;
  enDesc: string;
}

export interface ApparelSpec {
  id: string;
  layer: 'Headgear' | 'Shell' | 'OnSkin';
  zhLayerLabel: string;
  enLayerLabel: string;
  zhName: string;
  enName: string;
  icon: string;
  zhQuality: string;
  enQuality: string;
  qualityColor: string;
  hpPct: number;
  sharpPct: number;
  bluntPct: number;
  heatPct: number;
  coldInsulC: number;
  heatInsulC: number;
  massKg: number;
}

export const RIMWORLD_WEAPONS: readonly WeaponSpec[] = [
  {
    id: 'bolt_rifle',
    zhName: '栓动步枪',
    enName: 'Bolt-Action Rifle',
    icon: 'weapon_rifle',
    zhQuality: '优良',
    enQuality: 'Excellent',
    qualityColor: '#7ef09d',
    hpPct: 96,
    damage: 18,
    zhDamageType: '子弹·利器',
    enDamageType: 'Bullet (Sharp)',
    armorPenPct: 27,
    range: 37,
    burstCount: 1,
    cooldownSec: 1.5,
    dps: 8.6,
    massKg: 3.5,
    accTouch: 65,
    accShort: 80,
    accMed: 90,
    accLong: 80,
    zhDesc: '经典长射程精确步枪，中远距离命中率极高，适合殖民地防线狙击与野外狩猎。',
    enDesc: 'Ancient pattern bolt-action rifle. Long range and good accuracy make it ideal for hunting and defense.',
  },
  {
    id: 'assault_rifle',
    zhName: '制式突击步枪',
    enName: 'Assault Rifle',
    icon: 'weapon_assault',
    zhQuality: '大师',
    enQuality: 'Masterwork',
    qualityColor: '#64dfdf',
    hpPct: 98,
    damage: 11,
    zhDamageType: '子弹·利器',
    enDamageType: 'Bullet (Sharp)',
    armorPenPct: 23,
    range: 31,
    burstCount: 3,
    cooldownSec: 1.7,
    dps: 13.4,
    massKg: 3.5,
    accTouch: 60,
    accShort: 70,
    accMed: 65,
    accLong: 55,
    zhDesc: '全自动三连发制式步枪，射速与压制力出色，是应对掠夺者袭击的主力武器。',
    enDesc: 'General-purpose gas-operated assault rifle firing 3-round bursts with good range and stopping power.',
  },
  {
    id: 'charge_rifle',
    zhName: '电荷脉冲步枪',
    enName: 'Charge Rifle',
    icon: 'weapon_charge',
    zhQuality: '传奇',
    enQuality: 'Legendary',
    qualityColor: '#f5d451',
    hpPct: 100,
    damage: 15,
    zhDamageType: '电荷脉冲·高穿甲',
    enDamageType: 'Charge Shot',
    armorPenPct: 52,
    range: 27,
    burstCount: 3,
    cooldownSec: 1.6,
    dps: 18.2,
    massKg: 4.6,
    accTouch: 55,
    accShort: 75,
    accMed: 68,
    accLong: 52,
    zhDesc: '闪耀世界尖端电荷能量步枪，弹头裹挟不稳定等离子护套，拥有极高的护甲穿透力。',
    enDesc: 'Charged-shot energy rifle coating projectiles in unstable plasma for superior armor penetration.',
  },
  {
    id: 'ratkin_lance',
    zhName: '鼠族精工骑枪',
    enName: 'Ratkin Heavy Lance',
    icon: 'weapon_lance',
    zhQuality: '大师',
    enQuality: 'Masterwork',
    qualityColor: '#64dfdf',
    hpPct: 95,
    damage: 26,
    zhDamageType: '穿刺·高穿甲',
    enDamageType: 'Stab (Pierce)',
    armorPenPct: 44,
    range: 1.8,
    burstCount: 1,
    cooldownSec: 1.8,
    dps: 14.4,
    massKg: 3.2,
    accTouch: 92,
    accShort: 0,
    accMed: 0,
    accLong: 0,
    zhDesc: '鼠鼠族皇家卫队制式重型骑枪，配合灵巧冲刺可轻易刺穿重型防弹护甲。',
    enDesc: 'Royal Ratkin vanguard heavy lance designed to pierce heavy armor in close quarters.',
  },
  {
    id: 'ratkin_crossbow',
    zhName: '鼠族连发重弩',
    enName: 'Ratkin Repeating Crossbow',
    icon: 'weapon_crossbow',
    zhQuality: '优良',
    enQuality: 'Excellent',
    qualityColor: '#7ef09d',
    hpPct: 92,
    damage: 14,
    zhDamageType: '重弩箭·利器',
    enDamageType: 'Bolt (Sharp)',
    armorPenPct: 31,
    range: 29,
    burstCount: 2,
    cooldownSec: 1.4,
    dps: 11.8,
    massKg: 2.9,
    accTouch: 72,
    accShort: 84,
    accMed: 76,
    accLong: 62,
    zhDesc: '鼠族工坊研制的齿轮上弦连发重弩，射击安静且箭簇破甲优异。',
    enDesc: 'Gear-driven repeating crossbow crafted by Ratkin engineers, firing twin armor-piercing bolts.',
  },
  {
    id: 'monosword',
    zhName: '单分子等离子剑',
    enName: 'Monosword',
    icon: 'weapon_sword',
    zhQuality: '传奇',
    enQuality: 'Legendary',
    qualityColor: '#f5d451',
    hpPct: 100,
    damage: 29,
    zhDamageType: '单分子刃·极高穿甲',
    enDamageType: 'Mono-Edge Cut',
    armorPenPct: 90,
    range: 1.4,
    burstCount: 1,
    cooldownSec: 1.2,
    dps: 24.2,
    massKg: 2.0,
    accTouch: 96,
    accShort: 0,
    accMed: 0,
    accLong: 0,
    zhDesc: '由超凡科技锻造的单分子晶格长剑，几乎无视一切常规护甲。',
    enDesc: 'Ultratech metallic-crystal longsword condensed to a monomolecular edge that slices through any armor.',
  },
];

export const RIMWORLD_SHELL_APPAREL: readonly ApparelSpec[] = [
  {
    id: 'duster',
    layer: 'Shell',
    zhLayerLabel: '外套层',
    enLayerLabel: 'Shell',
    zhName: '恶魔布防风披风',
    enName: 'Devilstrand Duster',
    icon: 'apparel_duster',
    zhQuality: '优良',
    enQuality: 'Excellent',
    qualityColor: '#7ef09d',
    hpPct: 94,
    sharpPct: 42,
    bluntPct: 18,
    heatPct: 68,
    coldInsulC: 12,
    heatInsulC: 16,
    massKg: 2.2,
  },
  {
    id: 'flak_vest',
    layer: 'Shell',
    zhLayerLabel: '护甲层',
    enLayerLabel: 'Middle',
    zhName: '防弹战术背心',
    enName: 'Flak Vest',
    icon: 'apparel_vest',
    zhQuality: '良好',
    enQuality: 'Good',
    qualityColor: '#cfd8e3',
    hpPct: 88,
    sharpPct: 100,
    bluntPct: 36,
    heatPct: 27,
    coldInsulC: 4,
    heatInsulC: 2,
    massKg: 4.0,
  },
  {
    id: 'marine_armor',
    layer: 'Shell',
    zhLayerLabel: '动力甲层',
    enLayerLabel: 'Shell+Middle',
    zhName: '海军陆战队动力装甲',
    enName: 'Marine Armor',
    icon: 'apparel_power',
    zhQuality: '大师',
    enQuality: 'Masterwork',
    qualityColor: '#64dfdf',
    hpPct: 99,
    sharpPct: 138,
    bluntPct: 62,
    heatPct: 74,
    coldInsulC: 26,
    heatInsulC: 18,
    massKg: 12.5,
  },
  {
    id: 'phoenix_armor',
    layer: 'Shell',
    zhLayerLabel: '特种装甲',
    enLayerLabel: 'Shell+Middle',
    zhName: '凤翼抗热动力装甲',
    enName: 'Phoenix Armor',
    icon: 'apparel_power',
    zhQuality: '传奇',
    enQuality: 'Legendary',
    qualityColor: '#f5d451',
    hpPct: 100,
    sharpPct: 132,
    bluntPct: 58,
    heatPct: 165,
    coldInsulC: 24,
    heatInsulC: 60,
    massKg: 11.8,
  },
  {
    id: 'ratkin_knight',
    layer: 'Shell',
    zhLayerLabel: '骑士礼甲',
    enLayerLabel: 'Shell+Middle',
    zhName: '鼠族圣殿骑士板甲',
    enName: 'Ratkin Knight Plate',
    icon: 'apparel_vest',
    zhQuality: '大师',
    enQuality: 'Masterwork',
    qualityColor: '#64dfdf',
    hpPct: 97,
    sharpPct: 118,
    bluntPct: 54,
    heatPct: 48,
    coldInsulC: 16,
    heatInsulC: 10,
    massKg: 7.4,
  },
];

export const RIMWORLD_HEADGEAR: readonly ApparelSpec[] = [
  {
    id: 'ratkin_helmet',
    layer: 'Headgear',
    zhLayerLabel: '头饰层',
    enLayerLabel: 'Headgear',
    zhName: '鼠族防弹战术耳盔',
    enName: 'Ratkin Flak Helmet',
    icon: 'apparel_helmet',
    zhQuality: '优良',
    enQuality: 'Excellent',
    qualityColor: '#7ef09d',
    hpPct: 96,
    sharpPct: 58,
    bluntPct: 28,
    heatPct: 32,
    coldInsulC: 6,
    heatInsulC: 4,
    massKg: 1.2,
  },
  {
    id: 'marine_helmet',
    layer: 'Headgear',
    zhLayerLabel: '头饰层',
    enLayerLabel: 'Headgear',
    zhName: '海军陆战队全覆头盔',
    enName: 'Marine Helmet',
    icon: 'apparel_helmet',
    zhQuality: '大师',
    enQuality: 'Masterwork',
    qualityColor: '#64dfdf',
    hpPct: 100,
    sharpPct: 106,
    bluntPct: 48,
    heatPct: 62,
    coldInsulC: 10,
    heatInsulC: 8,
    massKg: 2.1,
  },
  {
    id: 'ratkin_nun_hood',
    layer: 'Headgear',
    zhLayerLabel: '头饰层',
    enLayerLabel: 'Headgear',
    zhName: '鼠族修道院防寒耳帽',
    enName: 'Ratkin Thermal Hood',
    icon: 'apparel_helmet',
    zhQuality: '优良',
    enQuality: 'Excellent',
    qualityColor: '#7ef09d',
    hpPct: 98,
    sharpPct: 28,
    bluntPct: 16,
    heatPct: 44,
    coldInsulC: 14,
    heatInsulC: 12,
    massKg: 0.6,
  },
];

const ONSKIN_APPAREL: ApparelSpec = {
  id: 'hyperweave_suit',
  layer: 'OnSkin',
  zhLayerLabel: '贴身层',
  enLayerLabel: 'OnSkin',
  zhName: '超织物野战衬衣与长裤',
  enName: 'Hyperweave Shirt & Pants',
  icon: 'apparel_shirt',
  zhQuality: '优良',
  enQuality: 'Excellent',
  qualityColor: '#7ef09d',
  hpPct: 98,
  sharpPct: 36,
  bluntPct: 16,
  heatPct: 42,
  coldInsulC: 8,
  heatInsulC: 8,
  massKg: 1.1,
};

interface PawnUiHudExtraState {
  healthSubTab: 'overview' | 'operations';
  selfTend: boolean;
  medCareIdx: number;
  queuedOps: { id: string; zhLabel: string; enLabel: string; partId: string; kind: 'bandage' | 'bionic' | 'prosthetic' | 'amputate' }[];
  headgearIdx: number;
  weaponInfoExpanded: boolean;
  apparelInfoExpanded: boolean;
}

const pawnUiExtras = new Map<number, PawnUiHudExtraState>();
const MED_CARE_TIERS = [
  { id: 'herbal', zhLabel: '🌿 草药医疗', enLabel: '🌿 Herbal Meds', color: '#7ef09d' },
  { id: 'industrial', zhLabel: '💊 工业医药', enLabel: '💊 Industrial Meds', color: '#64dfdf' },
  { id: 'glitterworld', zhLabel: '✨ 闪耀医药', enLabel: '✨ Glitterworld Meds', color: '#f5d451' },
  { id: 'nomeds', zhLabel: '🩹 仅徒手止血', enLabel: '🩹 Doctor Care Only', color: '#cfd8e3' },
];

function getPawnExtra(eid: number): PawnUiHudExtraState {
  let st = pawnUiExtras.get(eid);
  if (!st) {
    st = {
      healthSubTab: 'overview',
      selfTend: true,
      medCareIdx: 0,
      queuedOps: [],
      headgearIdx: eid % RIMWORLD_HEADGEAR.length,
      weaponInfoExpanded: false,
      apparelInfoExpanded: false,
    };
    pawnUiExtras.set(eid, st);
  }
  return st;
}

export function getPawnHudSignature(pawn: PawnState, showAllAnatomyParts: boolean): string {
  const ex = getPawnExtra(pawn.eid);
  const invSig = Object.entries(pawn.inventory ?? {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  return `${getUiLocale()}:${ex.healthSubTab}:${ex.selfTend ? 1 : 0}:${ex.medCareIdx}:${ex.queuedOps.length}:${ex.headgearIdx}:${ex.weaponInfoExpanded ? 1 : 0}:${ex.apparelInfoExpanded ? 1 : 0}:${pawn.equipWeapon ?? ''}:${pawn.equipApparel ?? ''}:${invSig}:${showAllAnatomyParts ? 1 : 0}`;
}

function resolveWeaponSpec(equipWeapon?: string): WeaponSpec {
  if (!equipWeapon || equipWeapon.includes('Unarmed') || equipWeapon.includes('未装备')) {
    return {
      id: 'unarmed',
      zhName: '徒手格斗',
      enName: 'Unarmed Fists',
      icon: 'draft',
      zhQuality: '普通',
      enQuality: 'Normal',
      qualityColor: '#cfd8e3',
      hpPct: 100,
      damage: 6,
      zhDamageType: '钝击',
      enDamageType: 'Blunt',
      armorPenPct: 8,
      range: 1.2,
      burstCount: 1,
      cooldownSec: 1.6,
      dps: 3.8,
      massKg: 0,
      accTouch: 82,
      accShort: 0,
      accMed: 0,
      accLong: 0,
      zhDesc: '未装备主武器，使用拳头进行近身肉搏。点击「切换武器」可从殖民地军械库配发武器。',
      enDesc: 'Currently unarmed. Click "Switch Weapon" to equip a firearm or melee weapon from the colony armory.',
    };
  }
  return (
    RIMWORLD_WEAPONS.find(
      (w) => equipWeapon.includes(w.zhName) || equipWeapon.includes(w.enName) || equipWeapon === w.id,
    ) ?? RIMWORLD_WEAPONS[0]
  );
}

function resolveShellApparelSpec(equipApparel?: string): ApparelSpec {
  if (!equipApparel || equipApparel.includes('None') || equipApparel.includes('未穿戴')) {
    return {
      id: 'none',
      layer: 'Shell',
      zhLayerLabel: '外套层',
      enLayerLabel: 'Shell',
      zhName: '未穿戴外层护甲',
      enName: 'No Outer Apparel',
      icon: 'apparel_shirt',
      zhQuality: '—',
      enQuality: '—',
      qualityColor: '#9fb0c2',
      hpPct: 100,
      sharpPct: 0,
      bluntPct: 0,
      heatPct: 0,
      coldInsulC: 0,
      heatInsulC: 0,
      massKg: 0,
    };
  }
  return (
    RIMWORLD_SHELL_APPAREL.find(
      (a) => equipApparel.includes(a.zhName) || equipApparel.includes(a.enName) || equipApparel === a.id,
    ) ?? RIMWORLD_SHELL_APPAREL[0]
  );
}

function resolveItemLabel(key: string): string {
  const isEn = getUiLocale() === 'en';
  const ing = CULINARY_INGREDIENTS.find((i) => i.id === key);
  if (ing) return isEn ? ing.enName : ing.name;
  const dish = CULINARY_RECIPES.find((r) => r.id === key);
  if (dish) return isEn ? dish.enName : dish.name;
  const zhMap: Record<string, string> = {
    wood: '原木',
    stone: '花岗石块',
    ore: '精炼钢铁',
    gold: '黄金',
    jade: '温润翡翠',
    food: '野生浆果',
    meat: '鲜切生肉',
    leather: '动物毛皮',
    meal: '营养熟食',
    herb: '医疗药草',
    components: '精密零件',
  };
  const enMap: Record<string, string> = {
    wood: 'Wood Log',
    stone: 'Granite Blocks',
    ore: 'Steel',
    gold: 'Gold',
    jade: 'Jade',
    food: 'Raw Berries',
    meat: 'Raw Meat',
    leather: 'Plainleather',
    meal: 'Fine Meal',
    herb: 'Herbal Medicine',
    components: 'Component',
  };
  return (isEn ? enMap[key] : zhMap[key]) ?? key;
}

function localizeBodyPartName(rawName: string): string {
  if (getUiLocale() === 'en') {
    const m = rawName.match(/\(([^)]+)\)/);
    return m ? m[1].trim() : tr(rawName);
  }
  return rawName.split(' (')[0];
}

/**
 * 渲染与 RimWorld 原版 `ITab_Pawn_Health` 截图完全一致的身体健康双栏 HUD。
 */
export function renderRimWorldHealthTab(
  paneEl: HTMLElement,
  sim: Sim,
  pawn: PawnState,
  showAllAnatomyParts: boolean,
  onToggleShowAll: () => void,
  onToast: (m: string) => void,
  onRefresh: () => void,
  setLastInspectKey: (k: string) => void,
): void {
  ensurePawnAnatomy(pawn);
  const isEn = getUiLocale() === 'en';
  const ex = getPawnExtra(pawn.eid);
  const caps = computeAnatomyCapacities(pawn);
  const allParts = Object.values(pawn.anatomy ?? {});
  const abnormalParts = allParts.filter((pt) => pt.hp < pt.maxHp || pt.status !== 'healthy');
  const bleedingParts = allParts.filter(
    (pt) =>
      pt.bleeding ||
      pt.status === 'bleeding' ||
      (pt.hp < pt.maxHp && !pt.bandaged && pt.status !== 'bionic' && pt.status !== 'amputated'),
  );

  const unbandagedDmg = allParts.reduce((acc, pt) => {
    if (pt.status === 'bionic' || pt.status === 'amputated') return acc;
    const lost = Math.max(0, pt.maxHp - pt.hp);
    return acc + (pt.bandaged ? lost * 0.35 : lost);
  }, 0);
  const painPct = Math.min(95, Math.round(unbandagedDmg * 2.8));
  const painTier =
    painPct <= 0
      ? { label: t('无', 'None'), color: '#7ef09d' }
      : painPct < 20
        ? { label: t(`轻微 (${painPct}%)`, `Little (${painPct}%)`), color: '#f5d451' }
        : painPct < 55
          ? { label: t(`中度 (${painPct}%)`, `Medium (${painPct}%)`), color: '#ff9f43' }
          : { label: t(`剧烈 (${painPct}%)`, `Severe (${painPct}%)`), color: '#ff6b6b' };

  const bleedRatePctPerDay = bleedingParts.length * 42;
  const keyPartIds = new Set([
    'skull',
    'brain',
    'left_eye',
    'right_eye',
    'jaw',
    'heart',
    'left_lung',
    'right_lung',
    'liver',
    'stomach',
    'left_arm',
    'right_arm',
    'left_leg',
    'right_leg',
    'left_index',
    'right_index',
    'reproductive_organ',
  ]);
  const visibleParts = showAllAnatomyParts
    ? allParts
    : abnormalParts.length > 0
      ? [
          ...abnormalParts,
          ...allParts.filter((pt) => pt.hp === pt.maxHp && pt.status === 'healthy' && keyPartIds.has(pt.partId)).slice(0, 7),
        ]
      : allParts.filter((pt) => keyPartIds.has(pt.partId));

  const capColor = (pct: number) =>
    pct > 100 ? '#64dfdf' : pct >= 95 ? '#7ef09d' : pct >= 70 ? '#f5d451' : '#ff6b6b';

  const talkingPct = Math.round(((pawn.anatomy?.['jaw']?.hp ?? 15) / 15) * (caps.consciousnessPct / 100) * 100);
  const hearingPct = Math.round(
    (((pawn.anatomy?.['left_ear']?.hp ?? 10) + (pawn.anatomy?.['right_ear']?.hp ?? 10)) / 20) * 100,
  );
  const medTier = MED_CARE_TIERS[ex.medCareIdx % MED_CARE_TIERS.length];
  const culinaryBuff = getActiveCulinaryBuff(pawn, sim.time);

  const capacitiesList = [
    { zh: '意识', en: 'Consciousness', pct: caps.consciousnessPct, tip: t('由大脑、颅骨与心脏供血共同决定', 'Determined by brain, skull, and blood pumping') },
    { zh: '移动', en: 'Moving', pct: caps.movingPct, tip: t('由双腿完好度与意识决定；安装仿生腿可提升至 125%', 'Determined by legs and consciousness; bionic legs boost to 125%') },
    { zh: '操作', en: 'Manipulation', pct: caps.manipulationPct, tip: t('由双臂与 10 根手指共同决定；影响建造、烹饪与射击精度', 'Determined by arms and 10 fingers; affects work and aim') },
    { zh: '语言', en: 'Talking', pct: talkingPct, tip: t('由下颌与意识决定；影响社交、招募与贸易价格', 'Determined by jaw and consciousness; affects social and trade') },
    { zh: '进食', en: 'Eating', pct: caps.digestionPct, tip: t('由下颌咀嚼与胃部消化共同决定', 'Determined by jaw and stomach') },
    { zh: '视觉', en: 'Sight', pct: caps.sightPct, tip: t('由左右眼决定；影响远程射击命中率与手术成功率', 'Determined by eyes; affects ranged accuracy and surgery') },
    { zh: '听觉', en: 'Hearing', pct: hearingPct, tip: t('由左右耳决定；影响社交互动与近身警觉', 'Determined by ears; affects social awareness') },
    { zh: '呼吸', en: 'Breathing', pct: caps.breathingPct, tip: t('由左右肺共同决定；影响氧气供应与移动耐力', 'Determined by lungs; affects oxygenation and speed') },
    { zh: '血液过滤', en: 'Blood Filtration', pct: caps.bloodFiltrationPct, tip: t('由肝脏与左右肾脏共同决定；影响伤口恢复速度', 'Determined by liver and kidneys; affects immunity') },
    { zh: '血液循环', en: 'Blood Pumping', pct: caps.bloodPumpingPct, tip: t('由心脏决定；影响全身供血与意识上限', 'Determined by heart; affects circulation and consciousness') },
    { zh: '消化代谢', en: 'Metabolism', pct: caps.metabolismPct, tip: t('由胃部与肝脏决定；影响食物营养吸收与自愈速度', 'Determined by stomach and liver; affects healing rate') },
    { zh: '生殖能力', en: 'Fertility', pct: caps.fertilityPct, tip: t('由生殖系统与意识共同决定', 'Determined by reproductive organs and consciousness') },
  ];

  const leftColumnHtml =
    ex.healthSubTab === 'overview'
      ? `
        <div class="rw-rwhealth-settings">
          <label class="rw-rwhealth-chk" title="${t('允许该殖民者在受伤时使用随身或库存草药自我包扎', 'Allow this colonist to tend their own wounds using herbal medicine')}">
            <input type="checkbox" id="rw-hlth-selftend" ${ex.selfTend ? 'checked' : ''} />
            <span>${t('允许自我包扎', 'Self-tend')}</span>
          </label>
          <div class="rw-rwhealth-medrow">
            <span>${t('医药策略:', 'Med care:')}</span>
            <button class="rw-collapse-mini" id="rw-hlth-cycle-med" style="color:${medTier.color};border-color:${medTier.color}" title="${t('点击切换允许对该小人使用的最高医药品质', 'Click to cycle medical care tier')}">
              ${isEn ? medTier.enLabel : medTier.zhLabel}
            </button>
          </div>
          <div class="rw-rwhealth-painrow">
            <span>${t('疼痛:', 'Pain:')} <b style="color:${painTier.color}">${painTier.label}</b></span>
            ${
              bleedRatePctPerDay > 0
                ? `<span style="color:#ff6b6b;font-weight:700">🩸 ${t(`失血 ${bleedRatePctPerDay}%/日`, `Bleeding ${bleedRatePctPerDay}%/d`)}</span>`
                : `<span style="color:#8fa2b5">🩸 ${t('无出血', 'No bleeding')}</span>`
            }
          </div>
        </div>
        <div class="rw-rwhealth-cap-list">
          ${capacitiesList
            .map(
              (c) => `
              <div class="rw-rwhealth-cap-item" title="${c.tip}">
                <span>${isEn ? c.en : c.zh}</span>
                <b style="color:${capColor(c.pct)}">${c.pct}%</b>
              </div>
            `,
            )
            .join('')}
        </div>
      `
      : `
        <div class="rw-rwhealth-ops-box">
          <div style="font-size:11px;color:#f5d451;font-weight:700;margin-bottom:4px">
            📋 ${t(`待执行手术法案 (${ex.queuedOps.length}) · 库存草药: ${Math.round(sim.stockpile['herb'] ?? 0)}`, `Queued Operations (${ex.queuedOps.length}) · Herbal Meds: ${Math.round(sim.stockpile['herb'] ?? 0)}`)}
          </div>
          <div class="rw-rwhealth-ops-queue">
            ${
              ex.queuedOps.length === 0
                ? `<div style="color:#8fa2b5;font-size:10.5px;padding:4px 0">${t('当前无排队手术。点击下方按钮添加并执行战地医疗或义体移植手术：', 'No queued operations. Click below to add and execute medical bills:')}</div>`
                : ex.queuedOps
                    .map(
                      (op, idx) => `
                      <div class="rw-rwhealth-op-row">
                        <span>${idx + 1}. ${isEn ? op.enLabel : op.zhLabel}</span>
                        <div style="display:flex;gap:3px">
                          <button class="rw-collapse-mini" data-op-exec="${idx}" style="border-color:#7ef09d;color:#7ef09d">▶ ${t('执行', 'Run')}</button>
                          <button class="rw-collapse-mini" data-op-del="${idx}" style="border-color:#ff6b6b;color:#ff9c9c">✕</button>
                        </div>
                      </div>
                    `,
                    )
                    .join('')
            }
          </div>
          <div style="font-size:10.5px;color:#9fb0c2;margin:5px 0 3px;border-top:1px solid #333d47;padding-top:4px">
            ➕ ${t('添加手术法案：', 'Add Medical Bill:')}
          </div>
          <div class="rw-rwhealth-add-bills">
            <button class="rw-mini-btn" data-add-op="bandage_all">🩹 ${t('草药全面包扎所有伤口 (消耗 1 草药)', 'Tend All Wounds with Herbal Meds (1 Herb)')}</button>
            <button class="rw-mini-btn" data-add-op="bionic:right_leg">🦿 ${t('右腿移植仿生腿 (移动效率 125%)', 'Install Bionic Right Leg (Moving 125%)')}</button>
            <button class="rw-mini-btn" data-add-op="bionic:left_arm">🦾 ${t('左臂移植仿生臂 (操作效率 125%)', 'Install Bionic Left Arm (Manipulation 125%)')}</button>
            <button class="rw-mini-btn" data-add-op="bionic:left_eye">👁 ${t('左眼安装仿生眼 (视觉效率 125%)', 'Install Bionic Left Eye (Sight 125%)')}</button>
            <button class="rw-mini-btn" data-add-op="bionic:heart">🫀 ${t('心脏移植仿生心 (造血效率 125%)', 'Install Bionic Heart (Blood Pumping 125%)')}</button>
            <button class="rw-mini-btn" data-add-op="amputate:left_pinky">🪚 ${t('左手小指外科截肢术', 'Amputate Left Pinky')}</button>
          </div>
        </div>
      `;

  paneEl.innerHTML = `
    <div class="rw-insp-title" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="display:flex;align-items:center;gap:6px">
        ${svgIcon('medical', 15)} ${pawn.name} · ${t(`身体健康 (草药:${Math.round(sim.stockpile['herb'] ?? 0)})`, `Health (Meds: ${Math.round(sim.stockpile['herb'] ?? 0)})`)}
      </span>
      <div style="display:flex;gap:4px;align-items:center">
        <button class="rw-collapse-mini" id="rw-hlth-band-all" style="border-color:#7ef09d;color:#7ef09d" title="${t('使用草药一键包扎全部受损部位', 'Tend all injured body parts with herbal medicine')}">🩹 ${t('一键包扎', 'Tend All')}</button>
        <button class="rw-collapse-mini" id="rw-hlth-sim-wound" title="${t('模拟战伤以测试包扎与义体手术', 'Simulate combat injuries to test tending and bionics')}">⚡ ${t('模拟战伤', 'Test Wound')}</button>
        <button class="rw-collapse-mini ${showAllAnatomyParts ? 'active' : ''}" id="rw-hlth-toggle-all">
          ${showAllAnatomyParts ? t('仅看伤患/关键', 'Injured / Key') : t(`显示全身(${allParts.length})`, `Show All (${allParts.length})`)}
        </button>
      </div>
    </div>

    <div class="rw-rwhealth-grid">
      <div class="rw-rwhealth-left">
        <div class="rw-rwhealth-subtabs">
          <button class="rw-rwhealth-subtab ${ex.healthSubTab === 'overview' ? 'active' : ''}" id="rw-hlth-sub-overview">
            ${t('生理概览', 'Overview')}
          </button>
          <button class="rw-rwhealth-subtab ${ex.healthSubTab === 'operations' ? 'active' : ''}" id="rw-hlth-sub-ops">
            ${t('手术清单', 'Operations')}${ex.queuedOps.length > 0 ? ` (${ex.queuedOps.length})` : ''}
          </button>
        </div>
        ${leftColumnHtml}
      </div>

      <div class="rw-rwhealth-right">
        <div class="rw-hediff-row rw-hediff-wholebody">
          <div class="rw-hediff-part">
            <b style="color:#8cd4ff">${t('全身状态', 'Whole Body')}</b>
          </div>
          <div class="rw-hediff-cond">
            ${
              culinaryBuff
                ? `<span style="color:#7ef09d" title="${culinaryBuff.summary}">${culinaryBuff.dishIcon} ${tr(culinaryBuff.dishName)} (${culinaryBuff.summary})</span>`
                : `<span style="color:#d8ccb8">🧬 ${t('鼠鼠族血统 · 灵巧代谢', 'Ratkin Xenotype · Agile Metabolism')}</span>`
            }
            <button class="rw-collapse-mini" id="rw-hlth-eat-buff" title="${t('品尝库存佳肴获取全身料理属性增益', 'Consume a culinary dish for whole-body stat buffs')}">🍛 ${t('进补', 'Eat Dish')}</button>
          </div>
        </div>

        ${visibleParts
          .map((pt) => {
            const def = BODY_PART_DEFS.find((d) => d.id === pt.partId);
            const partLabel = localizeBodyPartName(def?.name ?? pt.partId);
            const hpRatio = pt.maxHp > 0 ? pt.hp / pt.maxHp : 1;
            const partCol =
              pt.status === 'bionic'
                ? '#64dfdf'
                : pt.status === 'amputated'
                  ? '#868e96'
                  : hpRatio >= 0.99 && pt.status === 'healthy'
                    ? '#cfd8e3'
                    : hpRatio >= 0.65
                      ? '#f5d451'
                      : '#ff6b6b';

            const woundTxt = tr(pt.woundNote ?? t('开放创伤', 'Open Wound'));
            const condBadge =
              pt.status === 'healthy' && pt.hp >= pt.maxHp
                ? `<span style="color:#7ef09d">${t('完好', 'Healthy')}</span>`
                : pt.status === 'bionic'
                  ? `<span style="color:#64dfdf;font-weight:700">★ ${t('仿生义体 (125%)', 'Bionic Implant (125%)')}</span>`
                  : pt.status === 'prosthetic'
                    ? `<span style="color:#8cd4ff">${t('人工假肢 (85%)', 'Prosthetic (85%)')}</span>`
                    : pt.status === 'amputated'
                      ? `<span style="color:#adb5bd">${t('已截除', 'Missing Part')}</span>`
                      : pt.bandaged || pt.status === 'bandaged'
                        ? `<span style="color:#8cd4ff">● ${t(`已包扎 (${woundTxt}·愈合中)`, `Tended (${woundTxt})`)}</span>`
                        : `<span style="color:#ff6b6b;font-weight:700">🩸 ${woundTxt} (${t('流血受损', 'Bleeding')})</span>`;

            return `
              <div class="rw-hediff-row">
                <div class="rw-hediff-part">
                  <span style="color:${partCol};font-weight:600">${partLabel}</span>
                  <span class="rw-hediff-hp">${pt.hp}/${pt.maxHp}</span>
                </div>
                <div class="rw-hediff-cond">
                  ${condBadge}
                  <div class="rw-bpart-actions">
                    ${pt.hp < pt.maxHp && pt.status !== 'amputated' ? `<button class="rw-collapse-mini" data-hlth-band="${pt.partId}" title="${t('使用草药包扎该部位', 'Tend part with herbal medicine')}">🩹${t('包扎', 'Tend')}</button>` : ''}
                    ${def?.amputatable && pt.status !== 'amputated' ? `<button class="rw-collapse-mini" data-hlth-amp="${pt.partId}" title="${t('外科截肢', 'Surgical amputation')}">🪚${t('截肢', 'Amp')}</button>` : ''}
                    ${def?.transplantable && pt.status !== 'bionic' ? `<button class="rw-collapse-mini" data-hlth-bionic="${pt.partId}" title="${t('移植仿生义体 (效率提升至 125%)', 'Install bionic part (125% efficiency)')}">🫀${t('义体', 'Bionic')}</button>` : ''}
                  </div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;

  document.getElementById('rw-hlth-sub-overview')?.addEventListener('click', () => {
    ex.healthSubTab = 'overview';
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-sub-ops')?.addEventListener('click', () => {
    ex.healthSubTab = 'operations';
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-selftend')?.addEventListener('change', (ev) => {
    ex.selfTend = (ev.target as HTMLInputElement).checked;
    onToast(
      t(
        `${pawn.name} 自我包扎已设为：${ex.selfTend ? '开启 ✔' : '关闭'}`,
        `${pawn.name} Self-tend set to: ${ex.selfTend ? 'ON ✔' : 'OFF'}`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-cycle-med')?.addEventListener('click', () => {
    ex.medCareIdx = (ex.medCareIdx + 1) % MED_CARE_TIERS.length;
    const next = MED_CARE_TIERS[ex.medCareIdx];
    onToast(
      t(
        `${pawn.name} 医药策略已切换为：${next.zhLabel}`,
        `${pawn.name} medical care set to: ${next.enLabel}`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-toggle-all')?.addEventListener('click', () => {
    onToggleShowAll();
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-sim-wound')?.addEventListener('click', () => {
    inflictBodyPartInjury(pawn, 'left_index', 5, 'cut', t('利刃割伤', 'Knife Cut'));
    inflictBodyPartInjury(pawn, 'right_leg', 7, 'gunshot', t('步枪枪伤', 'Rifle Gunshot'));
    onToast(
      t(
        `⚡ 已对 ${pawn.name} 模拟战地创伤（左食指割伤、右腿枪伤）`,
        `⚡ Simulated combat wounds on ${pawn.name} (Left Index Cut, Right Leg Gunshot)`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-band-all')?.addEventListener('click', () => {
    sim.stockpile['herb'] = Math.max(3, sim.stockpile['herb'] ?? 0);
    let count = 0;
    for (const pt of allParts) {
      if (pt.hp < pt.maxHp && pt.status !== 'amputated') {
        bandageBodyPartWithHerb(sim, pawn.eid, pt.partId);
        count++;
      }
    }
    onToast(
      count > 0
        ? t(`🩹 已使用药草为 ${pawn.name} 包扎全部 ${count} 处受损部位！`, `🩹 Tended all ${count} wounds on ${pawn.name}!`)
        : t(`✨ ${pawn.name} 当前全身完好，无需包扎`, `✨ ${pawn.name} has no wounds to tend`),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-hlth-eat-buff')?.addEventListener('click', () => {
    const res = consumeCulinaryDish(sim, pawn.eid);
    onToast(tr(res.message));
    setLastInspectKey('');
    onRefresh();
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-add-op]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = String(btn.dataset.addOp);
      if (raw === 'bandage_all') {
        ex.queuedOps.push({
          id: `op_${Date.now()}`,
          zhLabel: '草药全面包扎伤口',
          enLabel: 'Tend All Wounds (Herbal)',
          partId: 'all',
          kind: 'bandage',
        });
      } else {
        const [kind, partId] = raw.split(':') as ['bionic' | 'amputate', string];
        const def = BODY_PART_DEFS.find((d) => d.id === partId);
        const zhP = (def?.name ?? partId).split(' (')[0];
        const enP = def?.name.match(/\(([^)]+)\)/)?.[1] ?? partId;
        ex.queuedOps.push({
          id: `op_${Date.now()}`,
          zhLabel: kind === 'bionic' ? `${zhP} 移植仿生义体` : `${zhP} 外科截肢术`,
          enLabel: kind === 'bionic' ? `Install Bionic (${enP})` : `Amputate ${enP}`,
          partId,
          kind,
        });
      }
      onToast(
        t(
          `📋 已为 ${pawn.name} 添加手术法案（点击「▶ 执行」即可立即完成手术）`,
          `📋 Added operation bill for ${pawn.name}`,
        ),
      );
      setLastInspectKey('');
      onRefresh();
    });
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-op-exec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.opExec);
      const op = ex.queuedOps[idx];
      if (!op) return;
      ex.queuedOps.splice(idx, 1);
      sim.stockpile['herb'] = Math.max(2, sim.stockpile['herb'] ?? 0);
      if (op.kind === 'bandage') {
        for (const pt of allParts) {
          if (pt.hp < pt.maxHp && pt.status !== 'amputated') {
            bandageBodyPartWithHerb(sim, pawn.eid, pt.partId);
          }
        }
        onToast(t(`🩹 已完成对 ${pawn.name} 的全面伤口包扎手术！`, `🩹 Completed full wound tending on ${pawn.name}!`));
      } else if (op.kind === 'bionic') {
        onToast(tr(transplantBodyPart(sim, pawn.eid, op.partId, true).message));
      } else if (op.kind === 'amputate') {
        onToast(tr(amputateBodyPart(sim, pawn.eid, op.partId).message));
      }
      setLastInspectKey('');
      onRefresh();
    });
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-op-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.opDel);
      ex.queuedOps.splice(idx, 1);
      setLastInspectKey('');
      onRefresh();
    });
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-hlth-band]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sim.stockpile['herb'] = Math.max(1, sim.stockpile['herb'] ?? 0);
      onToast(tr(bandageBodyPartWithHerb(sim, pawn.eid, String(btn.dataset.hlthBand)).message));
      setLastInspectKey('');
      onRefresh();
    });
  });
  paneEl.querySelectorAll<HTMLButtonElement>('[data-hlth-amp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onToast(tr(amputateBodyPart(sim, pawn.eid, String(btn.dataset.hlthAmp)).message));
      setLastInspectKey('');
      onRefresh();
    });
  });
  paneEl.querySelectorAll<HTMLButtonElement>('[data-hlth-bionic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sim.stockpile['herb'] = Math.max(1, sim.stockpile['herb'] ?? 0);
      onToast(tr(transplantBodyPart(sim, pawn.eid, String(btn.dataset.hlthBionic), true).message));
      setLastInspectKey('');
      onRefresh();
    });
  });
}

/**
 * 渲染与 RimWorld 原版 `ITab_Pawn_Gear` 截图完全一致的装备、武器与随身行囊 HUD。
 */
export function renderRimWorldGearTab(
  paneEl: HTMLElement,
  sim: Sim,
  pawn: PawnState,
  onToast: (m: string) => void,
  onRefresh: () => void,
  setLastInspectKey: (k: string) => void,
): void {
  const isEn = getUiLocale() === 'en';
  const ex = getPawnExtra(pawn.eid);
  const weapon = resolveWeaponSpec(pawn.equipWeapon);
  const shellApparel = resolveShellApparelSpec(pawn.equipApparel);
  const headgear = RIMWORLD_HEADGEAR[ex.headgearIdx % RIMWORLD_HEADGEAR.length];
  const culinaryBuff = getActiveCulinaryBuff(pawn, sim.time);

  const overallSharp = Math.min(200, Math.round(shellApparel.sharpPct * 0.65 + headgear.sharpPct * 0.25 + ONSKIN_APPAREL.sharpPct * 0.35));
  const overallBlunt = Math.min(200, Math.round(shellApparel.bluntPct * 0.65 + headgear.bluntPct * 0.25 + ONSKIN_APPAREL.bluntPct * 0.35));
  const overallHeat = Math.min(200, Math.round(shellApparel.heatPct * 0.65 + headgear.heatPct * 0.25 + ONSKIN_APPAREL.heatPct * 0.35));

  const buffTemp = culinaryBuff?.coldHeatResistC ?? 0;
  const minComfortC = -(4 + shellApparel.coldInsulC + headgear.coldInsulC + ONSKIN_APPAREL.coldInsulC + buffTemp);
  const maxComfortC = 26 + shellApparel.heatInsulC + headgear.heatInsulC + ONSKIN_APPAREL.heatInsulC + buffTemp;

  const invEntries = Object.entries(pawn.inventory ?? {}).filter(([, qty]) => qty > 0);
  const invMassKg = invEntries.reduce((acc, [k, qty]) => acc + (ITEM_WEIGHT_KG[k] ?? 0.5) * qty, 0);
  const totalMassKg = weapon.massKg + shellApparel.massKg + headgear.massKg + ONSKIN_APPAREL.massKg + invMassKg;
  const maxCarryKg = computePawnMaxCarryKg(pawn);
  const massPct = Math.min(100, Math.round((totalMassKg / Math.max(1, maxCarryKg)) * 100));
  const massBarCol = massPct > 90 ? '#ff6b6b' : massPct > 70 ? '#f5d451' : '#4ea8de';

  const wName = isEn ? weapon.enName : weapon.zhName;
  const wQual = isEn ? weapon.enQuality : weapon.zhQuality;
  const wDmgType = isEn ? weapon.enDamageType : weapon.zhDamageType;
  const wDesc = isEn ? weapon.enDesc : weapon.zhDesc;

  const hName = isEn ? headgear.enName : headgear.zhName;
  const hLayer = isEn ? headgear.enLayerLabel : headgear.zhLayerLabel;
  const hQual = isEn ? headgear.enQuality : headgear.zhQuality;

  const sName = isEn ? shellApparel.enName : shellApparel.zhName;
  const sLayer = isEn ? shellApparel.enLayerLabel : shellApparel.zhLayerLabel;
  const sQual = isEn ? shellApparel.enQuality : shellApparel.zhQuality;

  const oName = isEn ? ONSKIN_APPAREL.enName : ONSKIN_APPAREL.zhName;
  const oLayer = isEn ? ONSKIN_APPAREL.enLayerLabel : ONSKIN_APPAREL.zhLayerLabel;
  const oQual = isEn ? ONSKIN_APPAREL.enQuality : ONSKIN_APPAREL.zhQuality;

  paneEl.innerHTML = `
    <div class="rw-rwgear-top">
      <div class="rw-rwgear-mass-row">
        <span style="display:inline-flex;align-items:center;gap:4px">
          ${svgIcon('haul', 13)} <b>${t('当前负重:', 'Mass carried:')}</b>
        </span>
        <div class="rw-rwgear-mass-track">
          <i style="width:${massPct}%;background:${massBarCol}"></i>
        </div>
        <b style="color:${massBarCol};font-variant-numeric:tabular-nums">${totalMassKg.toFixed(1)} / ${maxCarryKg.toFixed(1)} kg</b>
      </div>

      <div class="rw-rwgear-stat-strip">
        <div class="rw-rwgear-stat-pill" title="${t('由基础体质、穿戴服饰隔热层与特色料理共同决定的舒适环境温度区间', 'Comfortable ambient temperature range determined by apparel insulation and culinary buffs')}">
          ${svgIcon('temp_comfort', 13)}
          <span>${t('舒适温度:', 'Comfort Temp:')} <b style="color:#8cd4ff">${minComfortC.toFixed(1)}°C ~ +${maxComfortC.toFixed(1)}°C</b></span>
        </div>
        <div class="rw-rwgear-stat-pill" title="${t('整体利器护甲：抵御子弹、刀剑、箭矢等锐器穿透伤害', 'Overall Sharp Armor: Deflects or reduces bullets, blades, and piercing attacks')}">
          ${svgIcon('armor_sharp', 13)}
          <span>${t('利器护甲:', 'Armor Sharp:')} <b style="color:#7ef09d">${overallSharp}%</b></span>
        </div>
        <div class="rw-rwgear-stat-pill" title="${t('整体钝器护甲：抵御锤击、爆炸冲击波与落石钝伤', 'Overall Blunt Armor: Reduces clubs, explosions, and rockfall trauma')}">
          ${svgIcon('armor_blunt', 13)}
          <span>${t('钝器护甲:', 'Armor Blunt:')} <b style="color:#f5d451">${overallBlunt}%</b></span>
        </div>
        <div class="rw-rwgear-stat-pill" title="${t('整体热能护甲：抵御火焰、等离子与高温灼烧', 'Overall Heat Armor: Protects against fire, plasma, and thermal burns')}">
          ${svgIcon('armor_heat', 13)}
          <span>${t('热能护甲:', 'Armor Heat:')} <b style="color:#ff9f43">${overallHeat}%</b></span>
        </div>
      </div>
    </div>

    <div class="rw-rwgear-scroll">
      <div class="rw-rwgear-sec-head">
        <span>⚔ ${t('主武器装具', 'Equipment')}</span>
        <span style="font-size:10px;color:#9fb0c2;font-weight:400">${t('查看弹道详情、切换军械库武器或卸下至地面', 'Inspect stats, switch weapons, or drop to ground')}</span>
      </div>
      <div class="rw-rwgear-item-card">
        <div class="rw-rwgear-item-main">
          <div class="rw-rwgear-icon-box">${svgIcon(weapon.icon, 20)}</div>
          <div class="rw-rwgear-item-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <b style="color:#ffffff;font-size:12px">${wName}</b>
              <span class="rw-rwgear-qbadge" style="color:${weapon.qualityColor};border-color:${weapon.qualityColor}">${wQual}</span>
              <span style="font-size:10.5px;color:#9fb0c2">HP ${weapon.hpPct}% · ${weapon.massKg.toFixed(1)} kg</span>
            </div>
            <div style="font-size:10.5px;color:#cfd8e3;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${t('伤害:', 'Dmg:')} <b style="color:#f5d451">${weapon.damage}</b> (${wDmgType})</span>
              <span>${t('穿甲:', 'AP:')} <b style="color:#64dfdf">${weapon.armorPenPct}%</b></span>
              <span>${t('射程:', 'Range:')} <b>${weapon.range}</b></span>
              <span>${t('连发:', 'Burst:')} <b>×${weapon.burstCount}</b> (${weapon.cooldownSec}s)</span>
              <span>DPS: <b style="color:#7ef09d">${weapon.dps}</b></span>
            </div>
          </div>
          <div class="rw-rwgear-item-btns">
            <button class="rw-collapse-mini ${ex.weaponInfoExpanded ? 'active' : ''}" id="rw-gear-wpn-info" title="${t('查看武器详细弹道参数', 'Show weapon ballistics info card')}">ℹ ${t('详情', 'Info')}</button>
            <button class="rw-collapse-mini" id="rw-gear-wpn-switch" style="border-color:#7ef09d;color:#7ef09d" title="${t('从殖民地军械库切换主武器', 'Switch primary weapon from armory')}">🔄 ${t('切换武器', 'Switch')}</button>
            ${weapon.id !== 'unarmed' ? `<button class="rw-collapse-mini" id="rw-gear-wpn-drop" style="border-color:#ff9f43;color:#ffcb77" title="${t('将当前武器卸下丢弃至脚下地面', 'Drop weapon onto the ground')}">⬇ ${t('卸下', 'Drop')}</button>` : ''}
          </div>
        </div>
        ${
          ex.weaponInfoExpanded
            ? `<div class="rw-rwgear-infocard">
                <div><b>${t('武器简介：', 'Description: ')}</b>${wDesc}</div>
                <div style="margin-top:3px;display:flex;gap:12px;flex-wrap:wrap;color:#8cd4ff">
                  <span>${t('贴身精度:', 'Acc Touch:')} <b>${weapon.accTouch}%</b></span>
                  <span>${t('近距精度:', 'Acc Short:')} <b>${weapon.accShort}%</b></span>
                  <span>${t('中距精度:', 'Acc Med:')} <b>${weapon.accMed}%</b></span>
                  <span>${t('远距精度:', 'Acc Long:')} <b>${weapon.accLong}%</b></span>
                </div>
              </div>`
            : ''
        }
      </div>

      <div class="rw-rwgear-sec-head">
        <span>🛡 ${t('穿戴服饰与护甲 (三层防护)', 'Apparel (3-Layer Protection)')}</span>
        <button class="rw-collapse-mini" id="rw-gear-app-info" style="font-size:10px;padding:0 5px">
          ${ex.apparelInfoExpanded ? t('收起说明', 'Hide Info') : t('ℹ 护甲层说明', 'ℹ Layer Info')}
        </button>
      </div>
      ${
        ex.apparelInfoExpanded
          ? `<div class="rw-rwgear-infocard" style="margin-bottom:4px">
              ${t(
                '护甲按由外向内分层结算：<b>头饰层</b>保护头部与感官，<b>外套与装甲层</b>提供躯干与四肢主要防弹/防刺保护，<b>贴身层</b>提供内衬防护与恒温。',
                'Armor resolves from outer to inner layers: <b>Headgear</b> protects the head, <b>Shell/Middle</b> protects torso & limbs, and <b>OnSkin</b> provides base insulation.',
              )}
            </div>`
          : ''
      }

      <div class="rw-rwgear-item-card">
        <div class="rw-rwgear-item-main">
          <div class="rw-rwgear-icon-box">${svgIcon(headgear.icon, 18)}</div>
          <div class="rw-rwgear-item-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:10px;color:#8cd4ff">[${hLayer}]</span>
              <b style="color:#ffffff;font-size:11.5px">${hName}</b>
              <span class="rw-rwgear-qbadge" style="color:${headgear.qualityColor};border-color:${headgear.qualityColor}">${hQual}</span>
            </div>
            <div style="font-size:10.5px;color:#cfd8e3;margin-top:1px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${t('利器', 'Sharp')} <b>${headgear.sharpPct}%</b></span>
              <span>${t('钝器', 'Blunt')} <b>${headgear.bluntPct}%</b></span>
              <span>${t('热能', 'Heat')} <b>${headgear.heatPct}%</b></span>
              <span>${t('隔热', 'Insul')} <b style="color:#8cd4ff">-${headgear.coldInsulC}°C / +${headgear.heatInsulC}°C</b></span>
              <span>${t('重量', 'Mass')} <b>${headgear.massKg}kg</b></span>
            </div>
          </div>
          <div class="rw-rwgear-item-btns">
            <button class="rw-collapse-mini" id="rw-gear-head-switch" title="${t('切换头盔/防寒耳帽', 'Cycle headgear')}">🔄 ${t('换头饰', 'Cycle')}</button>
          </div>
        </div>
      </div>

      <div class="rw-rwgear-item-card">
        <div class="rw-rwgear-item-main">
          <div class="rw-rwgear-icon-box">${svgIcon(shellApparel.icon, 18)}</div>
          <div class="rw-rwgear-item-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:10px;color:#f5d451">[${sLayer}]</span>
              <b style="color:#ffffff;font-size:11.5px">${sName}</b>
              <span class="rw-rwgear-qbadge" style="color:${shellApparel.qualityColor};border-color:${shellApparel.qualityColor}">${sQual}</span>
            </div>
            <div style="font-size:10.5px;color:#cfd8e3;margin-top:1px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${t('利器', 'Sharp')} <b style="color:#7ef09d">${shellApparel.sharpPct}%</b></span>
              <span>${t('钝器', 'Blunt')} <b style="color:#f5d451">${shellApparel.bluntPct}%</b></span>
              <span>${t('热能', 'Heat')} <b style="color:#ff9f43">${shellApparel.heatPct}%</b></span>
              <span>${t('隔热', 'Insul')} <b style="color:#8cd4ff">-${shellApparel.coldInsulC}°C / +${shellApparel.heatInsulC}°C</b></span>
              <span>${t('重量', 'Mass')} <b>${shellApparel.massKg}kg</b></span>
            </div>
          </div>
          <div class="rw-rwgear-item-btns">
            <button class="rw-collapse-mini" id="rw-gear-shell-switch" style="border-color:#7ef09d;color:#7ef09d" title="${t('切换防风披风/防弹背心/动力装甲', 'Switch outer armor')}">🔄 ${t('换护甲', 'Switch')}</button>
            ${shellApparel.id !== 'none' ? `<button class="rw-collapse-mini" id="rw-gear-shell-drop" style="border-color:#ff9f43;color:#ffcb77" title="${t('脱下外层护甲至地面', 'Drop outer apparel')}">⬇ ${t('脱下', 'Drop')}</button>` : ''}
          </div>
        </div>
      </div>

      <div class="rw-rwgear-item-card">
        <div class="rw-rwgear-item-main">
          <div class="rw-rwgear-icon-box">${svgIcon(ONSKIN_APPAREL.icon, 18)}</div>
          <div class="rw-rwgear-item-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:10px;color:#9fb0c2">[${oLayer}]</span>
              <b style="color:#dce4ee;font-size:11.5px">${oName}</b>
              <span class="rw-rwgear-qbadge" style="color:${ONSKIN_APPAREL.qualityColor};border-color:${ONSKIN_APPAREL.qualityColor}">${oQual}</span>
            </div>
            <div style="font-size:10.5px;color:#cfd8e3;margin-top:1px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${t('利器', 'Sharp')} <b>${ONSKIN_APPAREL.sharpPct}%</b></span>
              <span>${t('钝器', 'Blunt')} <b>${ONSKIN_APPAREL.bluntPct}%</b></span>
              <span>${t('热能', 'Heat')} <b>${ONSKIN_APPAREL.heatPct}%</b></span>
              <span>${t('隔热', 'Insul')} <b style="color:#8cd4ff">-${ONSKIN_APPAREL.coldInsulC}°C / +${ONSKIN_APPAREL.heatInsulC}°C</b></span>
            </div>
          </div>
        </div>
      </div>

      <div class="rw-rwgear-sec-head">
        <span>🎒 ${t(`随身行囊物资 (${invEntries.length} 项 · ${invMassKg.toFixed(1)} kg)`, `Inventory (${invEntries.length} items · ${invMassKg.toFixed(1)} kg)`)}</span>
        <button class="rw-collapse-mini" id="rw-gear-pack-supply" style="border-color:#f5d451;color:#f5d451;font-size:10px;padding:0 6px">
          ➕ ${t('配发口粮与草药', 'Pack Rations & Meds')}
        </button>
      </div>
      <div class="rw-rwgear-inv-list">
        ${
          invEntries.length === 0
            ? `<div style="font-size:11px;color:#8fa2b5;padding:4px 6px;background:rgba(14,18,23,0.7);border:1px dashed #38424d">
                ${t('行囊为空。可点击右上角「➕ 配发口粮与草药」或派遣小人搬运物资。', 'Inventory is empty. Click "➕ Pack Rations & Meds" above to supply field provisions.')}
              </div>`
            : invEntries
                .map(([k, qty]) => {
                  const unitKg = ITEM_WEIGHT_KG[k] ?? 0.5;
                  const totKg = (unitKg * qty).toFixed(1);
                  const isEdible = k === 'meal' || k === 'food' || k.startsWith('dish_');
                  return `
                    <div class="rw-rwgear-inv-row">
                      <span style="display:inline-flex;align-items:center;gap:5px">
                        ${svgIcon(k, 14)}
                        <b>${resolveItemLabel(k)}</b>
                        <span style="color:#f5d451">×${qty}</span>
                      </span>
                      <div style="display:flex;align-items:center;gap:5px">
                        <span style="font-size:10.5px;color:#9fb0c2">${totKg} kg</span>
                        ${isEdible ? `<button class="rw-collapse-mini" data-inv-eat="${k}" style="border-color:#7ef09d;color:#7ef09d">🍽 ${t('食用', 'Eat')}</button>` : ''}
                        <button class="rw-collapse-mini" data-inv-drop="${k}" title="${t('将该随身物品丢弃至脚下地面', 'Drop item onto ground')}">⬇ ${t('丢弃', 'Drop')}</button>
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    </div>
  `;

  document.getElementById('rw-gear-wpn-info')?.addEventListener('click', () => {
    ex.weaponInfoExpanded = !ex.weaponInfoExpanded;
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-app-info')?.addEventListener('click', () => {
    ex.apparelInfoExpanded = !ex.apparelInfoExpanded;
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-wpn-switch')?.addEventListener('click', () => {
    const curIdx = RIMWORLD_WEAPONS.findIndex((w) => w.id === weapon.id);
    const nextWpn = RIMWORLD_WEAPONS[(curIdx + 1) % RIMWORLD_WEAPONS.length];
    pawn.equipWeapon = `${nextWpn.zhName} (${nextWpn.enName})`;
    const nextLabel = isEn ? nextWpn.enName : nextWpn.zhName;
    onToast(
      t(
        `⚔ ${pawn.name} 已换装武器：【${nextLabel}】(DPS ${nextWpn.dps} · 穿甲 ${nextWpn.armorPenPct}%)`,
        `⚔ ${pawn.name} equipped [${nextLabel}] (DPS ${nextWpn.dps} · AP ${nextWpn.armorPenPct}%)`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-wpn-drop')?.addEventListener('click', () => {
    if (weapon.id === 'unarmed') return;
    spawnOutdoorItem(sim, 'ore', 3, Math.round(pawn.pos.x), Math.round(pawn.pos.y));
    pawn.equipWeapon = '未装备 (Unarmed)';
    onToast(
      t(
        `⬇ ${pawn.name} 已卸下武器【${wName}】并放置于地面 (${Math.round(pawn.pos.x)}, ${Math.round(pawn.pos.y)})`,
        `⬇ ${pawn.name} dropped [${wName}] at (${Math.round(pawn.pos.x)}, ${Math.round(pawn.pos.y)})`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-head-switch')?.addEventListener('click', () => {
    ex.headgearIdx = (ex.headgearIdx + 1) % RIMWORLD_HEADGEAR.length;
    const nextHead = RIMWORLD_HEADGEAR[ex.headgearIdx];
    const nextLabel = isEn ? nextHead.enName : nextHead.zhName;
    onToast(t(`🪖 ${pawn.name} 已更换头饰：【${nextLabel}】`, `🪖 ${pawn.name} equipped headgear: [${nextLabel}]`));
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-shell-switch')?.addEventListener('click', () => {
    const curIdx = RIMWORLD_SHELL_APPAREL.findIndex((a) => a.id === shellApparel.id);
    const nextApp = RIMWORLD_SHELL_APPAREL[(curIdx + 1) % RIMWORLD_SHELL_APPAREL.length];
    pawn.equipApparel = `${nextApp.zhName} (${nextApp.enName})`;
    const nextLabel = isEn ? nextApp.enName : nextApp.zhName;
    onToast(
      t(
        `🛡 ${pawn.name} 已换装护甲：【${nextLabel}】(利器 ${nextApp.sharpPct}% · 钝器 ${nextApp.bluntPct}%)`,
        `🛡 ${pawn.name} equipped armor: [${nextLabel}] (Sharp ${nextApp.sharpPct}% · Blunt ${nextApp.bluntPct}%)`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-shell-drop')?.addEventListener('click', () => {
    if (shellApparel.id === 'none') return;
    spawnOutdoorItem(sim, 'leather', 2, Math.round(pawn.pos.x), Math.round(pawn.pos.y));
    pawn.equipApparel = '未穿戴外套 (None)';
    onToast(t(`⬇ ${pawn.name} 已脱下【${sName}】并放置于地面`, `⬇ ${pawn.name} dropped [${sName}]`));
    setLastInspectKey('');
    onRefresh();
  });
  document.getElementById('rw-gear-pack-supply')?.addEventListener('click', () => {
    if (!pawn.inventory) pawn.inventory = {};
    pawn.inventory['meal'] = (pawn.inventory['meal'] ?? 0) + 2;
    pawn.inventory['herb'] = (pawn.inventory['herb'] ?? 0) + 2;
    onToast(
      t(
        `🎒 已为 ${pawn.name} 随身行囊配发：营养熟食 ×2、医疗药草 ×2`,
        `🎒 Packed Fine Meal ×2 and Herbal Medicine ×2 into ${pawn.name}'s inventory`,
      ),
    );
    setLastInspectKey('');
    onRefresh();
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-inv-eat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = String(btn.dataset.invEat);
      if (!pawn.inventory || (pawn.inventory[k] ?? 0) <= 0) return;
      pawn.inventory[k] -= 1;
      if (pawn.inventory[k] <= 0) delete pawn.inventory[k];
      pawn.needs.food = Math.min(100, pawn.needs.food + 35);
      pawn.needs.mood = Math.min(100, pawn.needs.mood + 10);
      onToast(
        t(
          `🍽 ${pawn.name} 食用了随身携带的【${resolveItemLabel(k)}】，饮食与心情大幅恢复！`,
          `🍽 ${pawn.name} ate [${resolveItemLabel(k)}], restoring food and mood!`,
        ),
      );
      setLastInspectKey('');
      onRefresh();
    });
  });

  paneEl.querySelectorAll<HTMLButtonElement>('[data-inv-drop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = String(btn.dataset.invDrop);
      const qty = pawn.inventory?.[k] ?? 0;
      if (!pawn.inventory || qty <= 0) return;
      delete pawn.inventory[k];
      spawnOutdoorItem(sim, k, qty, Math.round(pawn.pos.x), Math.round(pawn.pos.y));
      onToast(
        t(
          `⬇ ${pawn.name} 已将随身携带的 ${resolveItemLabel(k)} ×${qty} 丢弃至地面 (${Math.round(pawn.pos.x)}, ${Math.round(pawn.pos.y)})`,
          `⬇ ${pawn.name} dropped ${resolveItemLabel(k)} ×${qty} at (${Math.round(pawn.pos.x)}, ${Math.round(pawn.pos.y)})`,
        ),
      );
      setLastInspectKey('');
      onRefresh();
    });
  });
}
