/**
 * anatomy-health.ts —— 逐根手指 / 内脏 / 四肢 / 头部 / 生殖能力独立建模 + 截肢移植 + 草药包扎系统。
 *
 * 严格响应需求：
 *  - 「逐根手指/内脏独立建模与截肢移植；本项目采用 HP + 伤病状态与草药包扎——至少做出内脏四肢头，还有生殖能力。」
 *  - 包含 26 个独立解剖部位：
 *      1. 头部 (head)：颅骨、大脑、左眼、右眼、左耳、右耳、下颌
 *      2. 内脏 (organs)：心脏、左肺、右肺、肝脏、左肾、右肾、胃
 *      3. 四肢 (limbs)：左臂、右臂、左腿、右腿
 *      4. 逐根手指 (fingers, 共10根)：左拇指/食指/中指/无名指/小指、右拇指/食指/中指/无名指/小指
 *      5. 生殖系统 (reproductive)：生殖器官（决定生殖能力 fertilityPct 0%..100%）
 */
import type { Eid, PawnState } from './types';
import type { Sim } from './sim';

export type BodyPartGroup = 'head' | 'organs' | 'limbs' | 'fingers' | 'reproductive';

export type BodyPartCondition =
  | 'healthy'
  | 'injured'
  | 'bruised'
  | 'bleeding'
  | 'bandaged'
  | 'fractured'
  | 'infected'
  | 'amputated'
  | 'prosthetic'
  | 'bionic';

export interface BodyPartDef {
  id: string;
  name: string;
  group: BodyPartGroup;
  maxHp: number;
  parentLimbId?: string;
  amputatable?: boolean;
  transplantable?: boolean;
}

export interface BodyPartState {
  id: string;
  partId: string;
  name: string;
  group: BodyPartGroup;
  hp: number;
  maxHp: number;
  condition: BodyPartCondition;
  status: BodyPartCondition;
  bandaged: boolean;
  bleeding: boolean;
  woundNote?: string;
  parentLimbId?: string;
}

export interface AnatomyCapacities {
  consciousnessPct: number;
  movingPct: number;
  manipulationPct: number;
  sightPct: number;
  breathingPct: number;
  bloodPumpingPct: number;
  bloodFiltrationPct: number;
  digestionPct: number;
  metabolismPct: number;
  /** 生殖能力 (0..100%) */
  fertilityPct: number;
}

export const BODY_PART_DEFS: readonly BodyPartDef[] = [
  // 1. 头部 (head)
  { id: 'skull', name: '颅骨 (Skull)', group: 'head', maxHp: 30, amputatable: false, transplantable: false },
  { id: 'brain', name: '大脑 (Brain)', group: 'head', maxHp: 15, amputatable: false, transplantable: false },
  { id: 'left_eye', name: '左眼 (Left Eye)', group: 'head', maxHp: 12, amputatable: true, transplantable: true },
  { id: 'right_eye', name: '右眼 (Right Eye)', group: 'head', maxHp: 12, amputatable: true, transplantable: true },
  { id: 'left_ear', name: '左耳 (Left Ear)', group: 'head', maxHp: 10, amputatable: true, transplantable: true },
  { id: 'right_ear', name: '右耳 (Right Ear)', group: 'head', maxHp: 10, amputatable: true, transplantable: true },
  { id: 'jaw', name: '下颌 (Jaw)', group: 'head', maxHp: 15, amputatable: true, transplantable: true },

  // 2. 内脏 (organs)
  { id: 'heart', name: '心脏 (Heart)', group: 'organs', maxHp: 20, amputatable: false, transplantable: true },
  { id: 'left_lung', name: '左肺 (Left Lung)', group: 'organs', maxHp: 18, amputatable: true, transplantable: true },
  { id: 'right_lung', name: '右肺 (Right Lung)', group: 'organs', maxHp: 18, amputatable: true, transplantable: true },
  { id: 'liver', name: '肝脏 (Liver)', group: 'organs', maxHp: 20, amputatable: false, transplantable: true },
  { id: 'left_kidney', name: '左肾 (Left Kidney)', group: 'organs', maxHp: 15, amputatable: true, transplantable: true },
  { id: 'right_kidney', name: '右肾 (Right Kidney)', group: 'organs', maxHp: 15, amputatable: true, transplantable: true },
  { id: 'stomach', name: '胃部 (Stomach)', group: 'organs', maxHp: 18, amputatable: true, transplantable: true },

  // 3. 四肢 (limbs)
  { id: 'left_arm', name: '左臂 (Left Arm)', group: 'limbs', maxHp: 28, amputatable: true, transplantable: true },
  { id: 'right_arm', name: '右臂 (Right Arm)', group: 'limbs', maxHp: 28, amputatable: true, transplantable: true },
  { id: 'left_leg', name: '左腿 (Left Leg)', group: 'limbs', maxHp: 30, amputatable: true, transplantable: true },
  { id: 'right_leg', name: '右腿 (Right Leg)', group: 'limbs', maxHp: 30, amputatable: true, transplantable: true },

  // 4. 逐根手指独立建模 (10 Individual Fingers)
  { id: 'left_thumb', name: '左手拇指 (L. Thumb)', group: 'fingers', maxHp: 8, parentLimbId: 'left_arm', amputatable: true, transplantable: true },
  { id: 'left_index', name: '左手食指 (L. Index)', group: 'fingers', maxHp: 8, parentLimbId: 'left_arm', amputatable: true, transplantable: true },
  { id: 'left_middle', name: '左手中指 (L. Middle)', group: 'fingers', maxHp: 8, parentLimbId: 'left_arm', amputatable: true, transplantable: true },
  { id: 'left_ring', name: '左手无名指 (L. Ring)', group: 'fingers', maxHp: 8, parentLimbId: 'left_arm', amputatable: true, transplantable: true },
  { id: 'left_pinky', name: '左手小指 (L. Pinky)', group: 'fingers', maxHp: 7, parentLimbId: 'left_arm', amputatable: true, transplantable: true },
  { id: 'right_thumb', name: '右手拇指 (R. Thumb)', group: 'fingers', maxHp: 8, parentLimbId: 'right_arm', amputatable: true, transplantable: true },
  { id: 'right_index', name: '右手食指 (R. Index)', group: 'fingers', maxHp: 8, parentLimbId: 'right_arm', amputatable: true, transplantable: true },
  { id: 'right_middle', name: '右手中指 (R. Middle)', group: 'fingers', maxHp: 8, parentLimbId: 'right_arm', amputatable: true, transplantable: true },
  { id: 'right_ring', name: '右手无名指 (R. Ring)', group: 'fingers', maxHp: 8, parentLimbId: 'right_arm', amputatable: true, transplantable: true },
  { id: 'right_pinky', name: '右手小指 (R. Pinky)', group: 'fingers', maxHp: 7, parentLimbId: 'right_arm', amputatable: true, transplantable: true },

  // 5. 生殖系统 (Reproductive System -> 生殖能力 Fertility)
  { id: 'reproductive_organ', name: '生殖系统 (Reproductive System)', group: 'reproductive', maxHp: 18, amputatable: true, transplantable: true },
];

export const BODY_PART_TEMPLATES = BODY_PART_DEFS;

const PART_ALIAS: Record<string, string> = {
  left_index_finger: 'left_index',
  left_middle_finger: 'left_middle',
  left_ring_finger: 'left_ring',
  left_pinky_finger: 'left_pinky',
  right_index_finger: 'right_index',
  right_middle_finger: 'right_middle',
  right_ring_finger: 'right_ring',
  right_pinky_finger: 'right_pinky',
};

function normPartId(partId: string): string {
  return PART_ALIAS[partId] ?? partId;
}

export function ensurePawnAnatomy(p: PawnState): Record<string, BodyPartState> {
  if (!p.anatomy || Array.isArray(p.anatomy) || Object.keys(p.anatomy).length === 0) {
    const map: Record<string, BodyPartState> = {};
    for (const t of BODY_PART_DEFS) {
      map[t.id] = {
        id: t.id,
        partId: t.id,
        name: t.name,
        group: t.group,
        hp: t.maxHp,
        maxHp: t.maxHp,
        condition: 'healthy',
        status: 'healthy',
        bandaged: false,
        bleeding: false,
        ...(t.parentLimbId ? { parentLimbId: t.parentLimbId } : {}),
      };
    }
    p.anatomy = map as unknown as PawnState['anatomy'];
  }
  return p.anatomy as unknown as Record<string, BodyPartState>;
}

function partEff(parts: Record<string, BodyPartState>, id: string): number {
  const part = parts[normPartId(id)];
  if (!part) return 1;
  if (part.status === 'amputated' || part.hp <= 0) return 0;
  if (part.status === 'bionic') return 1.25;
  if (part.status === 'prosthetic') return 0.85;
  const base = Math.max(0, Math.min(1, part.hp / part.maxHp));
  const condPenalty =
    part.bleeding || part.status === 'bleeding'
      ? 0.8
      : part.status === 'infected'
        ? 0.72
        : part.status === 'fractured'
          ? 0.65
          : 1.0;
  const bandageBonus = part.bandaged && part.status !== 'healthy' ? 0.12 : 0;
  return Math.min(1, base * condPenalty + bandageBonus);
}

/**
 * 根据头部、内脏、四肢、10 根手指与生殖器官状态，实时计算 Pawn 的生理机能百分比。
 */
export function computeAnatomyCapacities(p: PawnState): AnatomyCapacities {
  const parts = ensurePawnAnatomy(p);

  const brain = partEff(parts, 'brain');
  const skull = partEff(parts, 'skull');
  const heart = partEff(parts, 'heart');
  const lungL = partEff(parts, 'left_lung');
  const lungR = partEff(parts, 'right_lung');
  const liver = partEff(parts, 'liver');
  const kidneyL = partEff(parts, 'left_kidney');
  const kidneyR = partEff(parts, 'right_kidney');
  const stomach = partEff(parts, 'stomach');
  const jaw = partEff(parts, 'jaw');

  const bloodPumpingPct = Math.round(heart * 100);
  const breathingPct = Math.round(((lungL + lungR) / 2) * 100);
  const bloodFiltrationPct = Math.round((liver * 0.5 + ((kidneyL + kidneyR) / 2) * 0.5) * 100);
  const consciousnessPct = Math.round(
    Math.min(1.25, brain * Math.min(1, skull + 0.2) * (0.7 + 0.3 * heart)) * 100,
  );

  const legL = partEff(parts, 'left_leg');
  const legR = partEff(parts, 'right_leg');
  const movingPct = Math.round(((legL + legR) / 2) * (consciousnessPct / 100) * 100);

  const armL = partEff(parts, 'left_arm');
  const armR = partEff(parts, 'right_arm');
  const leftFingers = ['left_thumb', 'left_index', 'left_middle', 'left_ring', 'left_pinky'];
  const rightFingers = ['right_thumb', 'right_index', 'right_middle', 'right_ring', 'right_pinky'];
  const lFingerAvg =
    armL === 0 ? 0 : leftFingers.reduce((s, id) => s + partEff(parts, id), 0) / leftFingers.length;
  const rFingerAvg =
    armR === 0 ? 0 : rightFingers.reduce((s, id) => s + partEff(parts, id), 0) / rightFingers.length;
  const leftHandEff = armL * (0.45 + 0.55 * lFingerAvg);
  const rightHandEff = armR * (0.45 + 0.55 * rFingerAvg);
  const manipulationPct = Math.round(((leftHandEff + rightHandEff) / 2) * (consciousnessPct / 100) * 100);

  const sightPct = Math.round(((partEff(parts, 'left_eye') + partEff(parts, 'right_eye')) / 2) * 100);
  const digestionPct = Math.round((stomach * 0.7 + jaw * 0.3) * 100);

  const repro = partEff(parts, 'reproductive_organ');
  const fertilityPct = Math.round(repro * (0.75 + 0.25 * (consciousnessPct / 100)) * 100);

  return {
    consciousnessPct,
    movingPct,
    manipulationPct,
    sightPct,
    breathingPct,
    bloodPumpingPct,
    bloodFiltrationPct,
    digestionPct,
    metabolismPct: digestionPct,
    fertilityPct,
  };
}

/**
 * 对指定解剖部位造成伤病（如攀爬摔伤左腿、战斗割伤手指/内脏等）。
 */
export function inflictBodyPartInjury(
  p: PawnState,
  partId: string,
  dmg: number,
  woundKind = 'cut',
  woundNote?: string,
): BodyPartState | null {
  const parts = ensurePawnAnatomy(p);
  const part = parts[normPartId(partId)];
  if (!part) return null;
  part.hp = Math.max(0, part.hp - dmg);
  part.bandaged = false;
  part.woundNote = woundNote ?? woundKind;
  if (part.hp <= 0) {
    part.condition = 'amputated';
    part.status = 'amputated';
    part.bleeding = false;
  } else {
    part.condition = 'injured';
    part.status = 'injured';
    part.bleeding = woundKind === 'cut' || woundKind === 'gunshot' || woundKind === 'bleeding';
  }
  p.hp = Math.max(1, p.hp - Math.round(dmg * 0.6));
  return part;
}

/**
 * 草药包扎（消耗 1 份 herb，止血并包扎受损部位，恢复部分生命）。
 */
export function bandageBodyPartWithHerb(
  sim: Sim,
  patientEid: Eid,
  partId: string,
  _doctorEid?: Eid,
): { ok: boolean; message: string } {
  const p = sim.pawn(patientEid);
  if (!p) return { ok: false, message: '未找到目标殖民者' };
  const parts = ensurePawnAnatomy(p);
  const part = parts[normPartId(partId)];
  if (!part) return { ok: false, message: `未知部位：${partId}` };
  if (part.status === 'amputated') {
    return { ok: false, message: `${part.name} 已缺失，需进行义体或器官移植手术` };
  }
  if ((sim.stockpile['herb'] ?? 0) < 1) {
    return { ok: false, message: '草药包 (herb) 库存不足，无法包扎' };
  }
  sim.stockpile['herb'] = (sim.stockpile['herb'] ?? 0) - 1;
  part.bandaged = true;
  part.bleeding = false;
  part.status = 'bandaged';
  part.condition = 'bandaged';
  part.hp = Math.min(part.maxHp, part.hp + Math.ceil(part.maxHp * 0.45));
  p.hp = Math.min(p.maxHp, p.hp + 10);
  const msg = `🩹 已使用草药包扎 ${p.name} 的【${part.name}】（当前 ${part.hp}/${part.maxHp}）`;
  sim.log(msg);
  return { ok: true, message: msg };
}

/**
 * 外科截肢手术（Amputation）：切除严重感染或粉碎的手指、四肢或受损器官。
 */
export function amputateBodyPart(
  sim: Sim,
  patientEid: Eid,
  partId: string,
): { ok: boolean; message: string } {
  const p = sim.pawn(patientEid);
  if (!p) return { ok: false, message: '未找到目标殖民者' };
  const parts = ensurePawnAnatomy(p);
  const part = parts[normPartId(partId)];
  if (!part) return { ok: false, message: `未知部位：${partId}` };
  if (part.id === 'brain' || part.id === 'skull' || part.id === 'heart') {
    return { ok: false, message: `【${part.name}】为致命核心器官，不可直接截除！` };
  }
  part.hp = 0;
  part.condition = 'amputated';
  part.status = 'amputated';
  part.bandaged = true;
  part.bleeding = false;
  for (const sub of Object.values(parts)) {
    if (sub.parentLimbId === part.id) {
      sub.hp = 0;
      sub.condition = 'amputated';
      sub.status = 'amputated';
      sub.bandaged = true;
      sub.bleeding = false;
    }
  }
  const msg = `✂ 已对 ${p.name} 的【${part.name}】执行外科截肢/摘除手术`;
  sim.log(msg);
  return { ok: true, message: msg };
}

/**
 * 器官移植 / 仿生义体安装手术（Transplant / Prosthetic / Bionic Implant）。
 */
export function transplantBodyPart(
  sim: Sim,
  patientEid: Eid,
  partId: string,
  bionicOrType: boolean | 'healthy' | 'prosthetic' | 'bionic' = 'bionic',
): { ok: boolean; message: string } {
  const p = sim.pawn(patientEid);
  if (!p) return { ok: false, message: '未找到目标殖民者' };
  const parts = ensurePawnAnatomy(p);
  const part = parts[normPartId(partId)];
  if (!part) return { ok: false, message: `未知部位：${partId}` };

  const implantType: BodyPartCondition =
    typeof bionicOrType === 'boolean' ? (bionicOrType ? 'bionic' : 'healthy') : bionicOrType;

  part.hp = part.maxHp;
  part.condition = implantType;
  part.status = implantType;
  part.bandaged = false;
  part.bleeding = false;
  part.woundNote = implantType === 'bionic' ? '仿生强化' : '移植器官';

  for (const sub of Object.values(parts)) {
    if (sub.parentLimbId === part.id && sub.status === 'amputated') {
      sub.hp = sub.maxHp;
      sub.condition = implantType;
      sub.status = implantType;
      sub.bandaged = false;
      sub.bleeding = false;
    }
  }

  const label =
    implantType === 'bionic' ? '仿生部件' : implantType === 'prosthetic' ? '人工义体' : '健康供体器官';
  const msg = `🧬 成功为 ${p.name} 的【${part.name}】移植了${label}！`;
  sim.log(msg);
  return { ok: true, message: msg };
}
