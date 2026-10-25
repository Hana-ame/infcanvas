/**
 * client/ui-schedule-bills.ts —— RimWorld 24 小时日程与管制矩阵 (Schedule & Assign)、
 *                                丰富的食材料理工作台生产清单 (Culinary Workbench Bills)、
 *                                心情想法拆解 (Mood Thoughts) 与多品类农田食材作物切换模块。
 */
import {
  CULINARY_INGREDIENT_MAP,
  CULINARY_RECIPES,
  CULINARY_RECIPE_MAP,
  type Eid,
  type PawnState,
  type Sim,
  cookCulinaryDish,
  dispenseNutrientPasteMeals,
  getActiveCulinaryBuff,
  getDeadPawns,
  haulAndButcherCorpse,
  inspectRoomAt,
  isStrangerPawn,
  performPawnTriadAction,
} from '../sim';
import { localizeHtml } from './i18n';
import { makeModalDraggable } from './ui-modals';

export type ScheduleActivity = 'anything' | 'work' | 'recreation' | 'sleep';
export type HostilityStance = 'attack' | 'flee' | 'ignore';

export interface PawnRimWorldPolicy {
  hours: ScheduleActivity[]; // 24 hours (0..23)
  stance: HostilityStance;
  carryMed: 0 | 1 | 2 | 3;
}

export interface WorkbenchBill {
  id: string;
  recipeId?: string;
  label: string;
  subInfo?: string;
  mode: 'until_x' | 'forever' | 'do_x';
  targetQty: number;
  productKey: string;
  suspended: boolean;
}

export interface CropChoice {
  id: 'rice' | 'corn' | 'wheat' | 'greens' | 'potato' | 'spice' | 'healroot' | 'berries';
  name: string;
  harvestItemKey: string;
  harvestQty: number;
  growDays: number;
  fertilitySens: string;
  yieldTxt: string;
}

export const RIMWORLD_CROPS: CropChoice[] = [
  { id: 'rice', name: '🌾 晶莹水稻 (Rice · 蛋炒饭主料)', harvestItemKey: 'rice_grain', harvestQty: 6, growDays: 3.0, fertilitySens: '100% 肥力敏感', yieldTxt: '6 晶莹稻米' },
  { id: 'corn', name: '🌽 黄金甜玉米 (Sweet Corn · 浓汤/烤串)', harvestItemKey: 'corn_sweet', harvestQty: 10, growDays: 8.5, fertilitySens: '100% 肥力敏感', yieldTxt: '10 黄金甜玉米' },
  { id: 'wheat', name: '🥖 金穗小麦 (Wheat · 烘焙流心派基底)', harvestItemKey: 'wheat_flour', harvestQty: 7, growDays: 5.5, fertilitySens: '90% 肥力敏感', yieldTxt: '7 精磨麦粉' },
  { id: 'greens', name: '🥬 霜叶脆青菜 (Frost Greens · 火锅/刺身配菜)', harvestItemKey: 'frost_greens', harvestQty: 8, growDays: 4.0, fertilitySens: '85% 肥力敏感', yieldTxt: '8 霜叶脆青菜' },
  { id: 'potato', name: '🥔 沙地粉土豆 (Potato · 耐贫瘠炖菜块茎)', harvestItemKey: 'potato_tuber', harvestQty: 8, growDays: 5.0, fertilitySens: '40% 肥力敏感', yieldTxt: '8 沙地粉土豆' },
  { id: 'spice', name: '🌶️ 烈焰香辛椒 (Aromatic Spice · 烤肉/火锅灵魂)', harvestItemKey: 'aromatic_spice', harvestQty: 5, growDays: 6.0, fertilitySens: '80% 肥力敏感', yieldTxt: '5 秘制香辛料' },
  { id: 'berries', name: '🍓 蜜汁草莓丛 (Strawberry · 可生食/甜点)', harvestItemKey: 'food', harvestQty: 8, growDays: 4.6, fertilitySens: '100% 肥力敏感', yieldTxt: '8 林间野浆果' },
  { id: 'healroot', name: '🌿 战地药草根 (Healroot · 医疗包扎)', harvestItemKey: 'herb', harvestQty: 3, growDays: 7.0, fertilitySens: '70% 肥力敏感', yieldTxt: '3 草药包' },
];

const pawnPolicies = new Map<Eid, PawnRimWorldPolicy>();
const buildingBills = new Map<string, WorkbenchBill[]>();
const fieldCropChoices = new Map<string, CropChoice['id']>();
let manualWorkPrioritiesMode = true;
let activeScheduleBrush: ScheduleActivity = 'work';

export function isManualWorkPriorityMode(): boolean {
  return manualWorkPrioritiesMode;
}

export function setManualWorkPriorityMode(val: boolean): void {
  manualWorkPrioritiesMode = val;
}

export function getActiveScheduleBrush(): ScheduleActivity {
  return activeScheduleBrush;
}

export function setActiveScheduleBrush(act: ScheduleActivity): void {
  activeScheduleBrush = act;
}

export function getFieldCropChoice(buildingId: string): CropChoice {
  const id = fieldCropChoices.get(buildingId) ?? 'rice';
  return RIMWORLD_CROPS.find((c) => c.id === id) ?? RIMWORLD_CROPS[0];
}

export function cycleFieldCropChoice(buildingId: string): CropChoice {
  const cur = fieldCropChoices.get(buildingId) ?? 'rice';
  const idx = RIMWORLD_CROPS.findIndex((c) => c.id === cur);
  const next = RIMWORLD_CROPS[(idx + 1) % RIMWORLD_CROPS.length];
  fieldCropChoices.set(buildingId, next.id);
  return next;
}

/** 立即收获农田当前种植的特色食材作物 */
export function harvestFieldCropNow(sim: Sim, buildingId: string): string {
  const crop = getFieldCropChoice(buildingId);
  sim.stockpile[crop.harvestItemKey] = (sim.stockpile[crop.harvestItemKey] ?? 0) + crop.harvestQty;
  if (crop.harvestItemKey !== 'food' && crop.harvestItemKey !== 'herb') {
    sim.stockpile['food'] = (sim.stockpile['food'] ?? 0) + 2;
  }
  const msg = `🌾【农田丰收】已收获【${crop.name}】：获得 +${crop.harvestQty} (${crop.yieldTxt}) 入库！`;
  sim.log(msg);
  return msg;
}

function defaultHours(nightOwl = false): ScheduleActivity[] {
  const arr: ScheduleActivity[] = new Array(24).fill('anything');
  if (nightOwl) {
    for (let h = 11; h <= 18; h++) arr[h] = 'sleep';
    arr[19] = 'recreation';
    arr[20] = 'recreation';
    for (let h = 21; h <= 23; h++) arr[h] = 'work';
    for (let h = 0; h <= 6; h++) arr[h] = 'work';
    arr[9] = 'recreation';
    arr[10] = 'recreation';
  } else {
    for (let h = 0; h <= 5; h++) arr[h] = 'sleep';
    arr[6] = 'anything';
    arr[7] = 'recreation';
    for (let h = 8; h <= 17; h++) arr[h] = 'work';
    arr[18] = 'recreation';
    arr[19] = 'recreation';
    arr[20] = 'anything';
    arr[21] = 'anything';
    arr[22] = 'sleep';
    arr[23] = 'sleep';
  }
  return arr;
}

export function ensurePawnPolicy(p: PawnState): PawnRimWorldPolicy {
  let pol = pawnPolicies.get(p.eid);
  if (!pol) {
    pol = {
      hours: defaultHours(p.eid % 5 === 0),
      stance: 'attack',
      carryMed: 2,
    };
    pawnPolicies.set(p.eid, pol);
  }
  return pol;
}

export function applySchedulePreset(p: PawnState, preset: 'standard' | 'night_owl' | 'work_rush' | 'biphasic'): void {
  const pol = ensurePawnPolicy(p);
  if (preset === 'standard') pol.hours = defaultHours(false);
  else if (preset === 'night_owl') pol.hours = defaultHours(true);
  else if (preset === 'work_rush') {
    pol.hours = new Array(24).fill('work');
    for (let h = 1; h <= 5; h++) pol.hours[h] = 'sleep';
    pol.hours[12] = 'recreation';
    pol.hours[20] = 'recreation';
  } else if (preset === 'biphasic') {
    pol.hours = new Array(24).fill('work');
    for (const h of [0, 1, 2, 3, 12, 13, 14, 15]) pol.hours[h] = 'sleep';
    for (const h of [4, 11, 16, 23]) pol.hours[h] = 'recreation';
  }
}

function formatRecipeIngredients(recipeId: string): string {
  const r = CULINARY_RECIPE_MAP[recipeId];
  if (!r) return '';
  const ingTxt = Object.entries(r.ingredients)
    .map(([k, v]) => `${CULINARY_INGREDIENT_MAP[k]?.name ?? k}×${v}`)
    .join('+');
  return `配料：${ingTxt} · 增益：${r.buff.summary}`;
}

export function getWorkbenchBills(buildingId: string, defId: string): WorkbenchBill[] {
  let list = buildingBills.get(buildingId);
  if (!list) {
    if (defId === 'campfire' || defId === 'great_bonfire') {
      const campfireRecipes = CULINARY_RECIPES.filter((r) => r.tier === 'campfire');
      list = campfireRecipes.map((r) => ({
        id: `bill_${r.id}`,
        recipeId: r.id,
        label: `${r.icon} ${r.name} (产${r.yieldQty}份 · 饱食+${r.nutritionGain})`,
        subInfo: formatRecipeIngredients(r.id),
        mode: 'until_x',
        targetQty: 8,
        productKey: r.id,
        suspended: false,
      }));
    } else if (defId === 'stove') {
      list = CULINARY_RECIPES.map((r) => ({
        id: `bill_${r.id}`,
        recipeId: r.id,
        label: `${r.icon} [${r.tierLabel}] ${r.name} (产${r.yieldQty}份)`,
        subInfo: formatRecipeIngredients(r.id),
        mode: r.tier === 'feast' ? 'do_x' : 'until_x',
        targetQty: r.tier === 'feast' ? 4 : 10,
        productKey: r.id,
        suspended: false,
      }));
    } else if (defId === 'spice_prep_table') {
      list = [
        {
          id: 'prep_spice_cheese',
          label: '🌶️ 研磨秘制香辛料 & 发酵窖藏奶酪 (+3 香辛料, +2 奶酪)',
          subInfo: '将野生香草与鲜乳加工为高阶料理调味品',
          mode: 'forever',
          targetQty: 20,
          productKey: 'aromatic_spice',
          suspended: false,
        },
        {
          id: 'prep_prime_fish',
          label: '🥓 精修雪花霜降肉排 & 冷水鱼柳 (+2 霜降肉排, +2 鲜鱼肉)',
          subInfo: '考究刀工精修顶级蛋白食材，供制作刺身船与烤肋排',
          mode: 'forever',
          targetQty: 20,
          productKey: 'prime_cut',
          suspended: false,
        },
        ...CULINARY_RECIPES.filter((r) => r.tier !== 'campfire').map((r) => ({
          id: `bill_${r.id}`,
          recipeId: r.id,
          label: `${r.icon} [${r.tierLabel}] ${r.name}`,
          subInfo: formatRecipeIngredients(r.id),
          mode: 'until_x' as const,
          targetQty: 8,
          productKey: r.id,
          suspended: false,
        })),
      ];
    } else if (defId === 'nutrient_paste_dispenser') {
      list = [
        {
          id: 'dispense_paste_batch',
          label: '🧪 合成应急无菌营养膏 (1:2 高效翻倍)',
          subInfo: '消耗任意生鲜食材合成无菌营养膏，无食物中毒但无特色料理增益',
          mode: 'until_x',
          targetQty: 12,
          productKey: 'meal',
          suspended: false,
        },
      ];
    } else if (defId === 'butcher_table') {
      list = [
        {
          id: 'butcher_forever',
          label: '🔪 屠宰猎物尸体 (分解鲜切兽肉、雪花霜降肉排与毛皮)',
          subInfo: '优先拖回地图上的野鹿/野兔尸体分解，无尸体时整理储备肉排',
          mode: 'forever',
          targetQty: 99,
          productKey: 'meat',
          suspended: false,
        },
      ];
    } else if (defId === 'research_bench') {
      list = [
        {
          id: 'research_tech',
          label: '🔬 持续推进殖民地科技研发',
          subInfo: '提升殖民者智识技能并解锁高阶设施',
          mode: 'forever',
          targetQty: 100,
          productKey: 'tech',
          suspended: false,
        },
      ];
    } else {
      list = [];
    }
    buildingBills.set(buildingId, list);
  }
  return list;
}

export function executeBuildingBillNow(sim: Sim, buildingId: string, defId: string, billId: string): string {
  const bills = getWorkbenchBills(buildingId, defId);
  const bill = bills.find((b) => b.id === billId);
  if (!bill) return '未找到对应生产清单';
  const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
  const worker = colonists[0];

  if (bill.recipeId) {
    const res = cookCulinaryDish(sim, bill.recipeId, worker?.eid, true);
    return res.message;
  }

  if (bill.id === 'prep_spice_cheese') {
    sim.stockpile['aromatic_spice'] = (sim.stockpile['aromatic_spice'] ?? 0) + 3;
    sim.stockpile['aged_cheese'] = (sim.stockpile['aged_cheese'] ?? 0) + 2;
    sim.stockpile['wheat_flour'] = (sim.stockpile['wheat_flour'] ?? 0) + 2;
    const msg = `🌶️【备菜与香料研磨】${worker?.name ?? '厨师'} 制备了 +3 秘制香辛料、+2 窖藏醇香奶酪、+2 精磨麦粉！`;
    sim.log(msg);
    return msg;
  }

  if (bill.id === 'prep_prime_fish') {
    sim.stockpile['prime_cut'] = (sim.stockpile['prime_cut'] ?? 0) + 2;
    sim.stockpile['fresh_fish'] = (sim.stockpile['fresh_fish'] ?? 0) + 2;
    sim.stockpile['poultry_egg'] = (sim.stockpile['poultry_egg'] ?? 0) + 2;
    const msg = `🥓【刀工精修】${worker?.name ?? '厨师'} 精修产出了 +2 雪花霜降肉排、+2 冷水鲜鱼肉、+2 野禽鲜蛋！`;
    sim.log(msg);
    return msg;
  }

  if (defId === 'butcher_table') {
    const corpses = getDeadPawns(sim);
    if (corpses.length > 0) {
      return haulAndButcherCorpse(sim, corpses[0].eid, worker?.eid).message;
    }
    sim.stockpile['meat'] = (sim.stockpile['meat'] ?? 0) + 3;
    sim.stockpile['prime_cut'] = (sim.stockpile['prime_cut'] ?? 0) + 1;
    sim.stockpile['leather'] = (sim.stockpile['leather'] ?? 0) + 2;
    return `🔪 已执行【${bill.label}】：分解储备猎物，产出 +3 鲜切生兽肉、+1 雪花霜降肉排、+2 毛皮`;
  }
  if (defId === 'research_bench' && worker) {
    return performPawnTriadAction(worker, 'research_craft', 15, sim.time).message;
  }
  const res = dispenseNutrientPasteMeals(sim, 2);
  return `🍖 已执行清单【${bill.label}】：${res.message}`;
}

export interface MoodThoughtEntry {
  label: string;
  delta: number;
}

export function computePawnMoodThoughts(sim: Sim, p: PawnState): MoodThoughtEntry[] {
  const list: MoodThoughtEntry[] = [];
  if (sim.time < 600) list.push({ label: '初到边缘世界的乐观期望 (New Colony Optimism)', delta: +12 });
  const rm = inspectRoomAt(sim.world, Math.round(p.pos.x), Math.round(p.pos.y));
  if (rm.roofed && rm.indoors) {
    list.push({ label: `身处舒适封顶室内 (${rm.width}×${rm.height})`, delta: +5 });
  } else {
    list.push({ label: '暴露在野外露天环境 (Outdoors)', delta: -3 });
  }
  const cBuff = getActiveCulinaryBuff(p, sim.time);
  if (cBuff) {
    list.push({
      label: `${cBuff.dishIcon} 品尝了特色料理【${cBuff.dishName}】(${cBuff.buffName})`,
      delta: +cBuff.moodBonus,
    });
  } else if (p.needs.food >= 75) {
    list.push({ label: '享用了美味熟食 (Ate Fine Meal)', delta: +6 });
  } else if (p.needs.food < 30) {
    list.push({ label: '饥肠辘辘 (Ravenously Hungry)', delta: -12 });
  }

  if (p.needs.rest >= 75) list.push({ label: '精力充沛 (Well Rested)', delta: +5 });
  else if (p.needs.rest < 28) list.push({ label: '极度困倦疲惫 (Exhausted)', delta: -10 });

  if ((sim.stockpile['meal'] ?? 0) >= 4) list.push({ label: '殖民地佳肴与食材储备充裕', delta: +4 });
  if (getDeadPawns(sim).length > 0) list.push({ label: '目睹未掩埋的遗体 (Observed Corpse)', delta: -6 });
  if (p.hp < p.maxHp) list.push({ label: '身体负伤疼痛 (In Pain)', delta: -8 });
  return list;
}

export function renderScheduleDrawer(
  el: HTMLElement,
  sim: Sim,
  closeDrawer: () => void,
  showToast: (msg: string) => void,
  forceRefresh: () => void,
): void {
  const pawns = [...sim.pawns()].filter((p) => !isStrangerPawn(p, sim.activePlayerId));
  const curHour = Math.floor(((sim.time % 120) / 120) * 24);
  const brushes: { id: ScheduleActivity; label: string; color: string }[] = [
    { id: 'anything', label: '⬜ 任意 (Anything)', color: '#6c757d' },
    { id: 'work', label: '🟨 工作 (Work)', color: '#d4a017' },
    { id: 'recreation', label: '🟦 娱乐 (Joy)', color: '#3b82f6' },
    { id: 'sleep', label: '🟪 睡眠 (Sleep)', color: '#6d28d9' },
  ];

  el.innerHTML = `
    <div class="rw-drawer-head">
      <b>📅 RimWorld 24小时日程与管制策略 (Schedule & Assign · 当前时刻 ${String(curHour).padStart(2, '0')}:00)</b>
      <div class="rw-subcat-bar">
        ${brushes
          .map(
            (b) =>
              `<button class="rw-subcat-btn ${activeScheduleBrush === b.id ? 'active' : ''}" data-sbrush="${b.id}" style="border-bottom:3px solid ${b.color}">${b.label}</button>`,
          )
          .join('')}
        <button class="rw-subcat-btn" id="rw-sched-all-std">☀ 全员标准作息</button>
        <button class="rw-subcat-btn" id="rw-sched-all-biphasic">🌓 全员双相睡眠 (+心情)</button>
        <button class="rw-subcat-btn" id="rw-drawer-collapse-btn">▾ 收起 (ESC)</button>
      </div>
    </div>
    <div class="rw-table-wrap">
      <table class="rw-work-table">
        <thead>
          <tr>
            <th style="width:88px">殖民者</th>
            <th style="width:130px">作息预设</th>
            <th style="width:92px">遇敌姿态</th>
            <th style="width:88px">随身携药</th>
            ${Array.from({ length: 24 }, (_, h) => `<th style="width:20px;font-size:10px;background:${h === curHour ? '#4a3b18' : ''};color:${h === curHour ? '#f5d451' : ''}">${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${pawns
            .slice(0, 12)
            .map((p) => {
              const pol = ensurePawnPolicy(p);
              const stanceIcon = pol.stance === 'attack' ? '🗡 迎击' : pol.stance === 'flee' ? '🏃 逃跑' : '🛡 忽略';
              return `
                <tr>
                  <td><b>${p.name}</b></td>
                  <td>
                    <button class="rw-mini-btn" data-preset="${p.eid}:standard" title="日出而作日落而息">标准</button>
                    <button class="rw-mini-btn" data-preset="${p.eid}:night_owl" title="夜猫子专享白昼睡眠">夜班</button>
                    <button class="rw-mini-btn" data-preset="${p.eid}:biphasic" title="RimWorld 高玩推荐双相睡眠">双相</button>
                  </td>
                  <td><button class="rw-mini-btn" data-stance="${p.eid}">${stanceIcon}</button></td>
                  <td><button class="rw-mini-btn" data-carrymed="${p.eid}">🌿 ×${pol.carryMed}</button></td>
                  ${pol.hours
                    .map((act, h) => {
                      const bg =
                        act === 'work'
                          ? '#b8860b'
                          : act === 'recreation'
                            ? '#2563eb'
                            : act === 'sleep'
                              ? '#5b21b6'
                              : '#495057';
                      const short = act === 'work' ? '工' : act === 'recreation' ? '娱' : act === 'sleep' ? '眠' : '任';
                      return `<td style="padding:1px"><button class="rw-sched-cell" data-scell="${p.eid}:${h}" style="width:19px;height:20px;padding:0;font-size:10px;border-radius:2px;background:${bg};color:#fff;border:1px solid ${h === curHour ? '#f5d451' : '#2b3036'}" title="${p.name} ${h}:00 — ${act}">${short}</button></td>`;
                    })
                    .join('')}
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  el.innerHTML = localizeHtml(el.innerHTML);
  document.getElementById('rw-drawer-collapse-btn')?.addEventListener('click', closeDrawer);
  const head = el.querySelector<HTMLElement>('.rw-drawer-head');
  if (head) makeModalDraggable(el, head, 'rw-main-drawer');

  el.querySelectorAll<HTMLButtonElement>('[data-sbrush]').forEach((b) => {
    b.addEventListener('click', () => {
      activeScheduleBrush = b.dataset.sbrush as ScheduleActivity;
      forceRefresh();
    });
  });

  document.getElementById('rw-sched-all-std')?.addEventListener('click', () => {
    for (const p of pawns) applySchedulePreset(p, 'standard');
    showToast('☀ 已为全员应用 RimWorld 标准日程表');
    forceRefresh();
  });

  document.getElementById('rw-sched-all-biphasic')?.addEventListener('click', () => {
    for (const p of pawns) {
      applySchedulePreset(p, 'biphasic');
      p.needs.mood = Math.min(100, p.needs.mood + 4);
    }
    showToast('🌓 已应用 veequeue 教程推荐【双相睡眠作息 (Biphasic Schedule)】：全员精神与心情提升！');
    forceRefresh();
  });

  el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const [eidStr, pr] = String(b.dataset.preset).split(':');
      const p = sim.pawn(Number(eidStr));
      if (!p) return;
      applySchedulePreset(p, pr as 'standard' | 'night_owl' | 'biphasic');
      showToast(`已为 ${p.name} 切换【${pr}】作息表`);
      forceRefresh();
    });
  });

  el.querySelectorAll<HTMLButtonElement>('[data-stance]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = sim.pawn(Number(b.dataset.stance));
      if (!p) return;
      const pol = ensurePawnPolicy(p);
      pol.stance = pol.stance === 'attack' ? 'flee' : pol.stance === 'flee' ? 'ignore' : 'attack';
      showToast(`${p.name} 遇敌反应切换为：${pol.stance}`);
      forceRefresh();
    });
  });

  el.querySelectorAll<HTMLButtonElement>('[data-carrymed]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = sim.pawn(Number(b.dataset.carrymed));
      if (!p) return;
      const pol = ensurePawnPolicy(p);
      pol.carryMed = ((pol.carryMed + 1) % 4) as 0 | 1 | 2 | 3;
      showToast(`🌿 ${p.name} 随身携带草药上限设为 ${pol.carryMed} 包`);
      forceRefresh();
    });
  });

  el.querySelectorAll<HTMLButtonElement>('[data-scell]').forEach((b) => {
    b.addEventListener('click', () => {
      const [eidStr, hStr] = String(b.dataset.scell).split(':');
      const p = sim.pawn(Number(eidStr));
      if (!p) return;
      const pol = ensurePawnPolicy(p);
      pol.hours[Number(hStr)] = activeScheduleBrush;
      forceRefresh();
    });
  });
}
