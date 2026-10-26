/**
 * client/ui-modals.ts —— 100% 还原 RimWorld 原版《Dialog_Trade》三栏对称双向交易界面入口、
 *                        战地遗体搜刮与屠宰/掩埋、物品目录定义与通用可拖动窗口控制器。
 */
import type { Sim } from '../sim';
import {
  ITEM_WEIGHT_KG,
  getColonistGroups,
  inspectCorpseLootManifest,
  lootSelectedFromCorpse,
  refreshGroupCarryMetrics,
} from '../sim/mmo-groups-ruins';
import { CULINARY_INGREDIENT_MAP, CULINARY_RECIPE_MAP } from '../sim/culinary-dishes';
import { buryCorpseInSitu } from '../sim/corpse-youtube-play';
import { haulAndButcherCorpse } from '../sim/rimworld-ecology-butcher';
import { getUiLocale, localizeHtml, tr } from './i18n';
import { openFactionTradeModal, openZeroPriceGroupTradeModal } from './ui-modals-trade';
export { openFactionTradeModal, openZeroPriceGroupTradeModal };
const savedWindowPositions = new Map<string, { left: number; top: number }>();
let activeDragState: {
  card: HTMLElement;
  handle: HTMLElement;
  key: string;
  startX: number;
  startY: number;
  initialLeft: number;
  initialTop: number;
  dragging: boolean;
} | null = null;
let globalDragBound = false;
export interface ItemTradeMeta {
  key: string;
  name: string;
  enName: string;
  icon: string;
  category: 'food_med' | 'material' | 'combat' | 'luxury';
  categoryLabel: string;
  basePrice: number;
  unitMassKg: number;
  desc: string;
}
export const RIMWORLD_ITEM_CATALOG: Record<string, ItemTradeMeta> = {
  meal: {
    key: 'meal',
    name: '精致熟食',
    enName: 'Fine Meal',
    icon: '🍖',
    category: 'food_med',
    categoryLabel: '食物医药',
    basePrice: 18,
    unitMassKg: ITEM_WEIGHT_KG.meal ?? 0.6,
    desc: '精心烹制的营养膳食，大幅恢复饱食度并带来愉悦心情。',
  },
  food: {
    key: 'food',
    name: '野生浆果',
    enName: 'Raw Berries',
    icon: '🍓',
    category: 'food_med',
    categoryLabel: '食物医药',
    basePrice: 6,
    unitMassKg: ITEM_WEIGHT_KG.food ?? 0.5,
    desc: '林间采集的新鲜浆果，可直接生食或用于炉灶烹饪。',
  },
  meat: {
    key: 'meat',
    name: '新鲜生肉',
    enName: 'Raw Meat',
    icon: '🥩',
    category: 'food_med',
    categoryLabel: '食物医药',
    basePrice: 10,
    unitMassKg: ITEM_WEIGHT_KG.meat ?? 0.8,
    desc: '在屠宰工作台分解猎物获得的生肉，适合烹饪熟食或合成营养膏。',
  },
  herb: {
    key: 'herb',
    name: '草药包',
    enName: 'Herbal Medicine',
    icon: '🌿',
    category: 'food_med',
    categoryLabel: '食物医药',
    basePrice: 22,
    unitMassKg: ITEM_WEIGHT_KG.herb ?? 0.3,
    desc: '野生治疗根茎制成的战地敷药，用于包扎伤口与外科手术。',
  },
  wood: {
    key: 'wood',
    name: '原木建材',
    enName: 'Wood Log',
    icon: '🪵',
    category: 'material',
    categoryLabel: '建材矿石',
    basePrice: 5,
    unitMassKg: ITEM_WEIGHT_KG.wood ?? 1.2,
    desc: '砍伐乔木获得的原木，是建造房屋、家具与添加营火燃料的基础物资。',
  },
  stone: {
    key: 'stone',
    name: '花岗石块',
    enName: 'Granite Blocks',
    icon: '🪨',
    category: 'material',
    categoryLabel: '建材矿石',
    basePrice: 8,
    unitMassKg: ITEM_WEIGHT_KG.stone ?? 2.5,
    desc: '坚固的花岗岩切块，用于修筑斜坡、主堡与永固防线。',
  },
  ore: {
    key: 'ore',
    name: '精炼钢铁',
    enName: 'Steel',
    icon: '⛏',
    category: 'material',
    categoryLabel: '建材矿石',
    basePrice: 14,
    unitMassKg: ITEM_WEIGHT_KG.ore ?? 2.0,
    desc: '边缘世界核心工业金属，用于建造发电机、电网、机枪塔与工作台。',
  },
  leather: {
    key: 'leather',
    name: '动物毛皮',
    enName: 'Plainleather',
    icon: '🧥',
    category: 'material',
    categoryLabel: '建材矿石',
    basePrice: 12,
    unitMassKg: 0.6,
    desc: '屠宰野生动物剥取的柔韧皮革，深受过往商队欢迎。',
  },
  components: {
    key: 'components',
    name: '精密零部件',
    enName: 'Industrial Component',
    icon: '⚙',
    category: 'luxury',
    categoryLabel: '精密贵重',
    basePrice: 45,
    unitMassKg: ITEM_WEIGHT_KG.components ?? 1.0,
    desc: '复杂的齿轮、电容与微电路组件，制造高级电力设施与义体必不可少。',
  },
  gold: {
    key: 'gold',
    name: '黄金',
    enName: 'Gold',
    icon: '🪙',
    category: 'luxury',
    categoryLabel: '精密贵重',
    basePrice: 50,
    unitMassKg: ITEM_WEIGHT_KG.gold ?? 1.5,
    desc: '闪耀的贵金属，硬通货等价物，1 单位黄金折合 50 银币购买力。',
  },
  jade: {
    key: 'jade',
    name: '温润翡翠',
    enName: 'Jade',
    icon: '💎',
    category: 'luxury',
    categoryLabel: '精密贵重',
    basePrice: 38,
    unitMassKg: ITEM_WEIGHT_KG.jade ?? 1.5,
    desc: '稀有的翠绿宝石，极受帝国与商盟收藏家追捧。',
  },
  weapon: {
    key: 'weapon',
    name: '制式武器装具',
    enName: 'Tactical Weapon',
    icon: '🔫',
    category: 'combat',
    categoryLabel: '武器护甲',
    basePrice: 85,
    unitMassKg: ITEM_WEIGHT_KG.weapon ?? 3.5,
    desc: '标准单兵远程步枪或近战利刃，可大幅提升殖民者战斗力。',
  },
  apparel: {
    key: 'apparel',
    name: '防弹护甲服饰',
    enName: 'Flak Apparel',
    icon: '🛡',
    category: 'combat',
    categoryLabel: '武器护甲',
    basePrice: 75,
    unitMassKg: ITEM_WEIGHT_KG.apparel ?? 4.0,
    desc: '嵌入精钢插板的防护背心与披风，有效抵御弹片与利爪。',
  },
};
export function getItemTradeMeta(key: string, customLabel?: string, customWeight?: number): ItemTradeMeta {
  const dish = CULINARY_RECIPE_MAP[key];
  if (dish) {
    return {
      key: dish.id,
      name: customLabel ?? `${dish.name} (${dish.tierLabel})`,
      enName: dish.enName,
      icon: dish.icon,
      category: 'food_med',
      categoryLabel: '特色料理',
      basePrice: dish.basePrice,
      unitMassKg: customWeight ?? dish.unitMassKg,
      desc: `${dish.flavorDesc} [${dish.buff.summary}]`,
    };
  }
  const ing = CULINARY_INGREDIENT_MAP[key];
  if (ing && !RIMWORLD_ITEM_CATALOG[key]) {
    return {
      key: ing.id,
      name: customLabel ?? ing.name,
      enName: ing.enName,
      icon: ing.icon,
      category: 'food_med',
      categoryLabel: ing.categoryLabel,
      basePrice: ing.basePrice,
      unitMassKg: customWeight ?? ing.unitMassKg,
      desc: `${ing.desc}（来源：${ing.sourceHint}）`,
    };
  }
  const known = RIMWORLD_ITEM_CATALOG[key];
  if (known) {
    return {
      ...known,
      name: customLabel ? customLabel.replace(/^(主武器|护甲\/服饰|随身物资)：/, '') : known.name,
      unitMassKg: customWeight ?? known.unitMassKg,
    };
  }
  return {
    key,
    name: customLabel ?? key,
    enName: key,
    icon: '📦',
    category: 'material',
    categoryLabel: '通用物资',
    basePrice: 10,
    unitMassKg: customWeight ?? ITEM_WEIGHT_KG[key] ?? 1.0,
    desc: '边缘世界殖民地通用储备物资。',
  };
}
function ensureGlobalDragListeners(): void {
  if (globalDragBound || typeof window === 'undefined') return;
  globalDragBound = true;
  window.addEventListener('mousemove', (e) => {
    if (!activeDragState) return;
    const { card, handle, key, startX, startY, initialLeft, initialTop } = activeDragState;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!activeDragState.dragging) {
      if (Math.hypot(dx, dy) < 5) return;
      activeDragState.dragging = true;
      handle.style.cursor = 'grabbing';
    }
    const maxW = Math.max(200, (window.innerWidth || 1280) - 80);
    const maxH = Math.max(120, (window.innerHeight || 720) - 50);
    const newLeft = Math.max(4, Math.min(maxW, initialLeft + dx));
    const newTop = Math.max(4, Math.min(maxH, initialTop + dy));
    card.style.position = 'fixed';
    card.style.left = `${newLeft}px`;
    card.style.top = `${newTop}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.style.margin = '0';
    card.style.transform = 'none';
    savedWindowPositions.set(key, { left: newLeft, top: newTop });
  });
  window.addEventListener('mouseup', () => {
    if (activeDragState) {
      activeDragState.handle.style.cursor = 'grab';
      activeDragState = null;
    }
  });
}
export function makeModalDraggable(modalCard: HTMLElement, handle: HTMLElement, storageKey?: string): void {
  ensureGlobalDragListeners();
  const key = storageKey || modalCard.id || 'rw-drag-win';
  const saved = savedWindowPositions.get(key);
  if (saved) {
    modalCard.style.position = 'fixed';
    modalCard.style.left = `${saved.left}px`;
    modalCard.style.top = `${saved.top}px`;
    modalCard.style.right = 'auto';
    modalCard.style.bottom = 'auto';
    modalCard.style.margin = '0';
    modalCard.style.transform = 'none';
  }
  handle.style.cursor = 'grab';
  handle.onmousedown = (e: MouseEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (
      tgt &&
      (tgt.tagName === 'BUTTON' ||
        tgt.tagName === 'INPUT' ||
        tgt.tagName === 'SELECT' ||
        tgt.closest('button') ||
        tgt.closest('select'))
    ) { return; }
    const rect = modalCard.getBoundingClientRect();
    const curLeft = savedWindowPositions.get(key)?.left ?? rect.left;
    const curTop = savedWindowPositions.get(key)?.top ?? rect.top;
    activeDragState = {
      card: modalCard,
      handle,
      key,
      startX: e.clientX,
      startY: e.clientY,
      initialLeft: curLeft,
      initialTop: curTop,
      dragging: false,
    };
  };
}
/**
 * RimWorld 原版风格三栏对称遗体搜刮与屠宰交易窗（Price = $0）
 */
export function openCorpseLootModal(
  sim: Sim,
  corpseEid: number,
  looterEid: number | undefined,
  onToast: (msg: string) => void,
  onRefresh: () => void,
): void {
  const modal = document.getElementById('rw-corpse-modal');
  if (!modal) return;
  const manifest = inspectCorpseLootManifest(sim, corpseEid);
  if (!manifest) {
    onToast('该遗体不存在或已清理完毕');
    return;
  }
  refreshGroupCarryMetrics(sim);
  const groups = getColonistGroups(sim);
  const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
  const actor = (looterEid ? sim.pawn(looterEid) : undefined) ?? colonists[0];
  const gId = actor?.groupId ?? 'group_alpha';
  const group = groups.get(gId) ?? groups.get('group_alpha')!;
  const freeKg = Math.max(0, group.maxWeightKg - group.currentWeightKg);
  let searchQuery = '';
  let activeCat: 'all' | 'food_med' | 'material' | 'combat' | 'luxury' = 'all';
  let sortBy: 'category' | 'name' | 'mass' = 'category';
  const selectedQty = new Map<string, number>();
  for (const e of manifest.entries) { selectedQty.set(e.key, e.availableQty); }
  modal.hidden = false;
  const renderCorpseDialog = () => {
    const filteredEntries = manifest.entries
      .map((e) => ({
        entry: e,
        meta: getItemTradeMeta(e.key, e.label, e.unitWeightKg),
      }))
      .filter(({ entry, meta }) => {
        if (activeCat !== 'all' && meta.category !== activeCat) return false;
        if (searchQuery.trim() !== '') {
          const q = searchQuery.trim().toLowerCase();
          return (
            meta.name.toLowerCase().includes(q) ||
            meta.enName.toLowerCase().includes(q) ||
            entry.label.toLowerCase().includes(q) ||
            entry.key.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.meta.name.localeCompare(b.meta.name);
        if (sortBy === 'mass') return b.meta.unitMassKg - a.meta.unitMassKg;
        return a.meta.category.localeCompare(b.meta.category) || a.meta.name.localeCompare(b.meta.name);
      });
    modal.innerHTML = `
      <div class="rw-modal-card rw-bevel-box rw-trade-dialog" id="rw-corpse-modal-card">
        <div class="rw-drawer-head rw-trade-titlebar" id="rw-corpse-drag-head">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <b style="font-size:14.5px;color:#f5d451">⚖ RimWorld 交易与搜刮总署 (Dialog_Trade)</b>
            <div class="rw-trade-mode-tabs">
              <button class="rw-subcat-btn" id="rw-switch-mode-faction">🤝 派系商队贸易</button>
              <button class="rw-subcat-btn" id="rw-switch-mode-group">⚖ 跨组零价调拨 (P=0)</button>
              <button class="rw-subcat-btn active">🪦 遗体搜刮窗 (P=0)</button>
            </div>
          </div>
          <button class="rw-subcat-btn" id="rw-close-corpse-modal">✕ 关闭 (ESC)</button>
        </div>
        <div class="rw-trade-header-grid">
          <div class="rw-trade-party-box">
            <div class="rw-trade-party-role">🏛 我方接收方 (Colony Looter & Group)</div>
            <div class="rw-trade-party-main">
              <span>搜刮执行人：</span>
              <b style="color:#f5d451;font-size:13.5px">${actor ? `${actor.name} (${actor.groupId === 'group_beta' ? '组2' : actor.groupId === 'group_gamma' ? '组3' : '组1'})` : '未指定殖民者'}</b>
            </div>
            <div class="rw-trade-party-sub">
              所属编组：<b>${group.name}</b> · 现有负重：<b style="color:#8cd4ff">${group.currentWeightKg.toFixed(1)} / ${group.maxWeightKg.toFixed(1)} kg</b>
            </div>
          </div>
          <div class="rw-trade-filter-box">
            <div style="display:flex;gap:6px;width:100%">
              <input id="rw-trade-search-inp" type="text" class="rw-trade-search" placeholder="🔍 搜索物品名称..." value="${searchQuery}" />
              <select id="rw-trade-sort-sel" class="rw-trade-select" style="width:118px">
                <option value="category" ${sortBy === 'category' ? 'selected' : ''}>排序：按分类</option>
                <option value="name" ${sortBy === 'name' ? 'selected' : ''}>排序：按名称</option>
                <option value="mass" ${sortBy === 'mass' ? 'selected' : ''}>排序：按单重</option>
              </select>
            </div>
            <div class="rw-trade-cat-pills">
              <button class="rw-collapse-mini ${activeCat === 'all' ? 'active' : ''}" data-tcat="all">全部</button>
              <button class="rw-collapse-mini ${activeCat === 'food_med' ? 'active' : ''}" data-tcat="food_med">🍖 食物医药</button>
              <button class="rw-collapse-mini ${activeCat === 'material' ? 'active' : ''}" data-tcat="material">🪵 建材矿石</button>
              <button class="rw-collapse-mini ${activeCat === 'combat' ? 'active' : ''}" data-tcat="combat">🔫 武器护甲</button>
              <button class="rw-collapse-mini ${activeCat === 'luxury' ? 'active' : ''}" data-tcat="luxury">⚙ 精密贵重</button>
            </div>
          </div>
          <div class="rw-trade-party-box rw-trade-party-right">
            <div class="rw-trade-party-role">🪦 目标遗体库存 (Target Corpse Inventory)</div>
            <div class="rw-trade-party-main" style="justify-content:flex-end">
              <span>搜刮目标：</span>
              <b style="color:#ff9c9c;font-size:13.5px">${manifest.corpseName}</b>
            </div>
            <div class="rw-trade-party-sub">
              剩余可用载重：<b id="rw-corpse-free-kg" style="color:#7ef09d">${freeKg.toFixed(1)} kg</b>
            </div>
          </div>
        </div>
        <div class="rw-trade-currency-bar">
          <div class="rw-trade-curr-left">
            <span class="rw-trade-item-icon">🪙</span>
            <b>银币结算 (Silver)</b>
            <span class="rw-trade-muted">单重 0 kg</span>
            <span class="rw-trade-curr-count">我方折算：<b>${Math.round((sim.stockpile['gold'] ?? 0) * 50)}</b></span>
          </div>
          <div class="rw-trade-curr-mid">
            <span class="rw-trade-zero-badge">◄ 0 银币 (战地搜刮单价 = $0 免费带回储物柜) ►</span>
          </div>
          <div class="rw-trade-curr-right">
            <span>遗体标价：<b style="color:#7ef09d">$0.00</b></span>
          </div>
        </div>
        ${
          manifest.entries.length === 0
            ? `<div class="rw-insp-desc" style="padding:28px 12px;text-align:center;font-size:13px">尸体表面随身物品已全部清空，可点击下方按钮拖回屠宰台屠宰分解或就地掩埋。</div>`
            : `<div class="rw-trade-table-wrap">
                <table class="rw-trade-table">
                  <thead>
                    <tr>
                      <th style="text-align:left;padding-left:10px">物品名称与分类 (Item)</th>
                      <th style="width:68px">单重</th>
                      <th style="width:92px;text-align:right">我方持有</th>
                      <th style="width:68px;text-align:right">我方单价</th>
                      <th style="width:270px;text-align:center">◄ 转入我方 (Colony) ｜ 留置遗体 (Corpse) ►</th>
                      <th style="width:68px;text-align:left">对方单价</th>
                      <th style="width:92px;text-align:left">遗体存量</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredEntries
                      .map(({ entry: e, meta }) => {
                        const curTake = selectedQty.get(e.key) ?? e.availableQty;
                        const colonyHave = Math.round(
                          group.inventory[e.key] ?? sim.stockpile[e.key] ?? 0,
                        );
                        const remainOnCorpse = Math.max(0, e.availableQty - curTake);
                        const subKg = curTake * e.unitWeightKg;
                        return `
                        <tr class="rw-trade-row ${curTake > 0 ? 'rw-row-buying' : ''}" data-row-key="${e.key}" title="${meta.desc}">
                          <td style="text-align:left;padding:6px 10px">
                            <div class="rw-trade-item-cell">
                              <span class="rw-trade-item-icon">${meta.icon}</span>
                              <div>
                                <b class="rw-trade-item-title">${e.label}</b>
                                <span class="rw-trade-cat-tag">${meta.categoryLabel}</span>
                              </div>
                            </div>
                          </td>
                          <td class="rw-trade-num" style="color:#adb5bd">${e.unitWeightKg.toFixed(1)} kg</td>
                          <td class="rw-trade-num" style="text-align:right">
                            <span>${colonyHave}</span>
                            <span class="rw-corpse-after-left" data-key="${e.key}" style="color:#7ef09d;font-weight:700">${curTake > 0 ? ` → ${colonyHave + curTake}` : ''}</span>
                          </td>
                          <td class="rw-trade-num" style="text-align:right;color:#7ef09d">$0.0</td>
                          <td class="rw-trade-transfer-td">
                            <div class="rw-trade-transfer-ctrl">
                              <button class="rw-trade-step-btn rw-btn-large-step" data-btn-step="all" data-key="${e.key}" data-max="${e.availableQty}" title="全部转入我方殖民地 (<<)">&lt;&lt;</button>
                              <button class="rw-trade-step-btn rw-btn-large-step" data-btn-step="+1" data-key="${e.key}" data-max="${e.availableQty}" title="向左多带出 1 件 (<)">&lt;</button>
                              <div class="rw-trade-Editable-wrap">
                                <span class="rw-trade-dir-arrow" data-arrow-key="${e.key}">${curTake > 0 ? '◄' : '·'}</span>
                                <input type="number" class="rw-corpse-qty-val rw-trade-qty-input" data-key="${e.key}" data-unitkg="${e.unitWeightKg}"
                                  min="0" max="${e.availableQty}" value="${curTake}" />
                              </div>
                              <button class="rw-trade-step-btn rw-btn-large-step" data-btn-step="-1" data-key="${e.key}" data-max="${e.availableQty}" title="向右少带出 1 件 (>)">&gt;</button>
                              <button class="rw-trade-step-btn rw-btn-large-step" data-btn-step="zero" data-key="${e.key}" data-max="${e.availableQty}" title="全部留置在遗体上 (>>)">&gt;&gt;</button>
                            </div>
                          </td>
                          <td class="rw-trade-num" style="text-align:left;color:#7ef09d">$0.0</td>
                          <td class="rw-trade-num" style="text-align:left">
                            <b>${e.availableQty}</b>
                            <span class="rw-corpse-after-right" data-key="${e.key}" style="color:#f5d451">${curTake > 0 ? ` → ${remainOnCorpse}` : ''}</span>
                            <small class="rw-corpse-subkg" data-key="${e.key}" style="display:block;font-size:10.5px;color:#9fb0c2">${subKg.toFixed(1)} kg</small>
                          </td>
                        </tr>
                      `;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
        <div class="rw-trade-footer">
          <div class="rw-trade-footer-summary">
            <span>结算总价：<b style="color:#7ef09d">0 银币 (免费搜刮)</b> · </span>
            <span id="rw-corpse-weight-preview" style="font-size:12.5px;color:#f5d451">
              带出总重：<b>${manifest.totalAvailableWeightKg.toFixed(1)} kg</b>
            </span>
          </div>
          <div class="rw-trade-footer-btns">
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-corpse-reset-zero">↺ 重置 (Reset)</button>
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-btn-corpse-butcher" style="background:#5c2b29;border-color:#ff9f43;color:#fff">🔪 拖回屠宰台屠宰</button>
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-btn-insitu-bury" style="background:#4a3f2c;border-color:#d4af37;color:#fff">⚰ 原地掩埋</button>
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-corpse-take-all" style="background:#2b4736;border-color:#5cb85c;color:#fff">⚡ 全部带回储物柜</button>
            <button class="rw-mini-btn rw-trade-action-btn rw-trade-accept-btn" id="rw-corpse-confirm-take">✓ 确认交易带走 (Accept)</button>
          </div>
        </div>
      </div>
    `;
    modal.innerHTML = localizeHtml(modal.innerHTML);
    const cardEl = document.getElementById('rw-corpse-modal-card');
    const headEl = document.getElementById('rw-corpse-drag-head');
    if (cardEl && headEl) makeModalDraggable(cardEl, headEl, 'rw-corpse-modal-card');
    const updateMetrics = () => {
      let sumKg = 0;
      modal.querySelectorAll<HTMLInputElement>('.rw-corpse-qty-val').forEach((inp) => {
        const key = String(inp.dataset.key);
        const maxVal = Number(inp.max) || 0;
        const qty = Math.max(0, Math.min(maxVal, Number(inp.value) || 0));
        selectedQty.set(key, qty);
        const u = Number(inp.dataset.unitkg) || 1;
        const sub = qty * u;
        sumKg += sub;
        const cell = modal.querySelector(`.rw-corpse-subkg[data-key="${key}"]`);
        if (cell) cell.textContent = `${sub.toFixed(1)} kg`;
        const arrow = modal.querySelector(`.rw-trade-dir-arrow[data-arrow-key="${key}"]`);
        if (arrow) arrow.textContent = qty > 0 ? '◄' : '·';
        const row = modal.querySelector(`.rw-trade-row[data-row-key="${key}"]`);
        if (row) row.classList.toggle('rw-row-buying', qty > 0);
        const colonyHave = Math.round(group.inventory[key] ?? sim.stockpile[key] ?? 0);
        const afterL = modal.querySelector(`.rw-corpse-after-left[data-key="${key}"]`);
        if (afterL) afterL.textContent = qty > 0 ? ` → ${colonyHave + qty}` : '';
        const afterR = modal.querySelector(`.rw-corpse-after-right[data-key="${key}"]`);
        if (afterR) afterR.textContent = qty > 0 ? ` → ${Math.max(0, maxVal - qty)}` : '';
      });
      sumKg = Number(sumKg.toFixed(2));
      const prev = document.getElementById('rw-corpse-weight-preview');
      if (prev) {
        const over = sumKg > freeKg + 1e-6;
        prev.innerHTML = `带出总重：<b style="color:${over ? '#ff6b6b' : '#7ef09d'}">${sumKg.toFixed(1)} kg</b> / 剩余可用 ${freeKg.toFixed(1)} kg ${over ? '（⚠ 超出小队负重上限）' : ''}`;
      }
    };
    updateMetrics();
    document.getElementById('rw-switch-mode-faction')?.addEventListener('click', () => {
      openFactionTradeModal(sim, undefined, actor?.eid, onToast, onRefresh);
    });
    document.getElementById('rw-switch-mode-group')?.addEventListener('click', () => {
      openZeroPriceGroupTradeModal(sim, 'group_alpha', 'group_beta', onToast, onRefresh);
    });
    document.getElementById('rw-trade-search-inp')?.addEventListener('input', (ev) => {
      searchQuery = (ev.target as HTMLInputElement).value;
      renderCorpseDialog();
      const inp = document.getElementById('rw-trade-search-inp') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        inp.setSelectionRange(searchQuery.length, searchQuery.length);
      }
    });
    document.getElementById('rw-trade-sort-sel')?.addEventListener('change', (ev) => {
      sortBy = (ev.target as HTMLSelectElement).value as 'category' | 'name' | 'mass';
      renderCorpseDialog();
    });
    modal.querySelectorAll<HTMLButtonElement>('[data-tcat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCat = (btn.dataset.tcat as typeof activeCat) ?? 'all';
        renderCorpseDialog();
      });
    });
    modal.querySelectorAll<HTMLButtonElement>('.rw-btn-large-step').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = String(btn.dataset.key);
        const maxVal = Number(btn.dataset.max) || 0;
        const step = btn.dataset.btnStep;
        const inp = modal.querySelector<HTMLInputElement>(`.rw-corpse-qty-val[data-key="${key}"]`);
        if (!inp) return;
        let cur = Number(inp.value) || 0;
        if (step === 'zero') cur = 0;
        else if (step === 'all') cur = maxVal;
        else if (step === '+1') cur = Math.min(maxVal, cur + 1);
        else if (step === '-1') cur = Math.max(0, cur - 1);
        inp.value = String(cur);
        updateMetrics();
      });
    });
    modal.querySelectorAll<HTMLTableRowElement>('.rw-trade-row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        const tgt = ev.target as HTMLElement;
        if (tgt.tagName === 'BUTTON' || tgt.tagName === 'INPUT' || tgt.closest('button')) return;
        const key = String(row.dataset.rowKey);
        const inp = modal.querySelector<HTMLInputElement>(`.rw-corpse-qty-val[data-key="${key}"]`);
        if (!inp) return;
        const maxVal = Number(inp.max) || 0;
        const cur = Number(inp.value) || 0;
        inp.value = String(cur > 0 ? 0 : maxVal);
        updateMetrics();
      });
    });
    modal.querySelectorAll('.rw-corpse-qty-val').forEach((inp) => {
      inp.addEventListener('input', updateMetrics);
      inp.addEventListener('change', updateMetrics);
    });
    document.getElementById('rw-corpse-reset-zero')?.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('.rw-corpse-qty-val').forEach((inp) => { inp.value = '0'; });
      updateMetrics();
    });
    document.getElementById('rw-close-corpse-modal')?.addEventListener('click', () => { modal.hidden = true; });
    document.getElementById('rw-btn-corpse-butcher')?.addEventListener('click', () => {
      const res = haulAndButcherCorpse(sim, corpseEid, actor?.eid);
      onToast(res.message);
      modal.hidden = true;
      onRefresh();
    });
    document.getElementById('rw-btn-insitu-bury')?.addEventListener('click', () => {
      const res = buryCorpseInSitu(sim, corpseEid, actor?.eid);
      onToast(res.message);
      modal.hidden = true;
      onRefresh();
    });
    document.getElementById('rw-corpse-confirm-take')?.addEventListener('click', () => {
      const picks: { key: string; qty: number }[] = [];
      modal.querySelectorAll<HTMLInputElement>('.rw-corpse-qty-val').forEach((inp) => {
        const qty = Math.max(0, Math.round(Number(inp.value) || 0));
        if (qty > 0) picks.push({ key: String(inp.dataset.key), qty });
      });
      const res = lootSelectedFromCorpse(sim, corpseEid, actor?.eid ?? 1, picks, { requireProximity: true });
      onToast(`${res.message}（已入储物柜）`);
      if (res.ok) {
        if (res.corpseFullyStripped) modal.hidden = true;
        else openCorpseLootModal(sim, corpseEid, actor?.eid, onToast, onRefresh);
      }
      onRefresh();
    });
    document.getElementById('rw-corpse-take-all')?.addEventListener('click', () => {
      const picks = manifest.entries.map((e) => ({ key: e.key, qty: e.availableQty }));
      const res = lootSelectedFromCorpse(sim, corpseEid, actor?.eid ?? 1, picks, { requireProximity: true });
      onToast(`${res.message}（已入储物柜）`);
      if (res.ok) modal.hidden = true;
      onRefresh();
    });
  };
  renderCorpseDialog();
}
