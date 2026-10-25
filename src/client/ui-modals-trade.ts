/**
 * client/ui-modals-trade.ts —— RimWorld 原版《Dialog_Trade》跨组零价调拨 (Price=0) 与派系商队/访客贸易弹窗实现
 *                             （从 ui-modals.ts 拆分出，保持核心模块严格 < 800 行）。
 */
import type { Sim } from '../sim';
import {
  ITEM_WEIGHT_KG,
  executeZeroPriceGroupTrade,
  getColonistGroups,
  refreshGroupCarryMetrics,
} from '../sim/mmo-groups-ruins';
import { getDeadPawns } from '../sim/corpse-youtube-play';
import { getNpcBases } from '../sim/npc-bases';
import { localizeHtml } from './i18n';
import {
  type ItemTradeMeta,
  getItemTradeMeta,
  makeModalDraggable,
  openCorpseLootModal,
} from './ui-modals';

/**
 * RimWorld 原版风格三栏对称跨组零价调拨交易窗（Group P=0 Transfer Dialog）
 * 支持双向划拨：正数向右转入调入组 (Group B)，负数向左转入调出组 (Group A)
 */
export function openZeroPriceGroupTradeModal(
  sim: Sim,
  fromGroupId: string,
  toGroupId: string,
  onToast: (msg: string) => void,
  onRefresh: () => void,
): void {
  const modal = document.getElementById('rw-corpse-modal');
  if (!modal) return;
  refreshGroupCarryMetrics(sim);
  const groups = getColonistGroups(sim);
  const groupList = [...groups.values()];
  const gFrom = groups.get(fromGroupId) ?? groups.get('group_alpha')!;
  const gTo =
    groups.get(toGroupId && toGroupId !== gFrom.id ? toGroupId : 'group_beta') ??
    groupList.find((g) => g.id !== gFrom.id) ??
    groups.get('group_beta')!;

  const allItems = Array.from(
    new Set([
      ...Object.keys(gFrom.inventory),
      ...Object.keys(gTo.inventory),
      'meal',
      'food',
      'meat',
      'herb',
      'wood',
      'stone',
      'ore',
      'leather',
      'gold',
      'components',
    ]),
  );

  let searchQuery = '';
  let activeCat: 'all' | 'food_med' | 'material' | 'combat' | 'luxury' = 'all';
  let sortBy: 'category' | 'name' | 'mass' = 'category';
  const transferMap = new Map<string, number>();

  modal.hidden = false;

  const renderGroupTradeDialog = () => {
    refreshGroupCarryMetrics(sim);
    const filteredItems = allItems
      .map((item) => ({ item, meta: getItemTradeMeta(item) }))
      .filter(({ item, meta }) => {
        if (activeCat !== 'all' && meta.category !== activeCat) return false;
        if (searchQuery.trim() !== '') {
          const q = searchQuery.trim().toLowerCase();
          return (
            meta.name.toLowerCase().includes(q) ||
            meta.enName.toLowerCase().includes(q) ||
            item.toLowerCase().includes(q)
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
      <div class="rw-modal-card rw-bevel-box rw-trade-dialog" id="rw-gtrade-modal-card">
        <div class="rw-drawer-head rw-trade-titlebar" id="rw-gtrade-drag-head">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <b style="font-size:14.5px;color:#f5d451">⚖ RimWorld 殖民地贸易与物资调拨总署 (Dialog_Trade)</b>
            <div class="rw-trade-mode-tabs">
              <button class="rw-subcat-btn" id="rw-gt-mode-faction">🤝 派系商队贸易</button>
              <button class="rw-subcat-btn active">⚖ 跨组零价调拨 (P=0)</button>
              <button class="rw-subcat-btn" id="rw-gt-mode-corpse">🪦 遗体搜刮窗 (P=0)</button>
            </div>
          </div>
          <button class="rw-subcat-btn" id="rw-close-gtrade-modal">✕ 关闭 (ESC)</button>
        </div>

        <div class="rw-trade-header-grid">
          <div class="rw-trade-party-box">
            <div class="rw-trade-party-role">⬅ 左侧调出/接收编组 (Left Colonist Group)</div>
            <div class="rw-trade-party-main">
              <span>左侧编组：</span>
              <b style="color:#f5d451;font-size:13.5px">${gFrom.name} (${gFrom.memberEids.length}人)</b>
            </div>
            <div class="rw-trade-party-sub" id="rw-gt-left-mass-bar">
              当前负重：<b style="color:#8cd4ff">${gFrom.currentWeightKg.toFixed(1)} / ${gFrom.maxWeightKg.toFixed(1)} kg</b>
            </div>
          </div>

          <div class="rw-trade-filter-box">
            <div style="display:flex;gap:6px;width:100%">
              <input id="rw-gt-search-inp" type="text" class="rw-trade-search" placeholder="🔍 搜索物资名称..." value="${searchQuery}" />
              <select id="rw-gt-sort-sel" class="rw-trade-select" style="width:118px">
                <option value="category" ${sortBy === 'category' ? 'selected' : ''}>排序：按分类</option>
                <option value="name" ${sortBy === 'name' ? 'selected' : ''}>排序：按名称</option>
                <option value="mass" ${sortBy === 'mass' ? 'selected' : ''}>排序：按单重</option>
              </select>
            </div>
            <div class="rw-trade-cat-pills">
              <button class="rw-collapse-mini ${activeCat === 'all' ? 'active' : ''}" data-gtcat="all">全部</button>
              <button class="rw-collapse-mini ${activeCat === 'food_med' ? 'active' : ''}" data-gtcat="food_med">🍖 食物医药</button>
              <button class="rw-collapse-mini ${activeCat === 'material' ? 'active' : ''}" data-gtcat="material">🪵 建材矿石</button>
              <button class="rw-collapse-mini ${activeCat === 'combat' ? 'active' : ''}" data-gtcat="combat">🔫 武器护甲</button>
              <button class="rw-collapse-mini ${activeCat === 'luxury' ? 'active' : ''}" data-gtcat="luxury">⚙ 精密贵重</button>
            </div>
          </div>

          <div class="rw-trade-party-box rw-trade-party-right">
            <div class="rw-trade-party-role">右侧调入/调出编组 (Right Colonist Group) ➡</div>
            <div class="rw-trade-party-main" style="justify-content:flex-end">
              <span>右侧编组：</span>
              <b style="color:#7ef09d;font-size:13.5px">${gTo.name} (${gTo.memberEids.length}人)</b>
            </div>
            <div class="rw-trade-party-sub" id="rw-gt-right-mass-bar">
              当前负重：<b style="color:#7ef09d">${gTo.currentWeightKg.toFixed(1)} / ${gTo.maxWeightKg.toFixed(1)} kg</b>
            </div>
          </div>
        </div>

        <div class="rw-trade-currency-bar">
          <div class="rw-trade-curr-left">
            <span class="rw-trade-item-icon">🪙</span>
            <b>银币 (Silver)</b>
            <span class="rw-trade-muted">殖民地内部调拨免收银币</span>
          </div>
          <div class="rw-trade-curr-mid">
            <span class="rw-trade-zero-badge">◄ 0 银币 (内部编组零价调拨 Price = $0.00) ►</span>
          </div>
          <div class="rw-trade-curr-right">
            <span>结算单价：<b style="color:#7ef09d">$0.00</b></span>
          </div>
        </div>

        <div class="rw-trade-table-wrap">
          <table class="rw-trade-table">
            <thead>
              <tr>
                <th style="text-align:left;padding-left:10px">物资名称与分类 (Item)</th>
                <th style="width:68px">单重</th>
                <th style="width:105px;text-align:right">${gFrom.name.split(' ')[0]} 存量</th>
                <th style="width:62px;text-align:right">单价</th>
                <th style="width:285px;text-align:center">◄ 转入左组 (&lt;&lt; &lt; 0 &gt; &gt;&gt;) 转入右组 ►</th>
                <th style="width:62px;text-align:left">单价</th>
                <th style="width:105px;text-align:left">${gTo.name.split(' ')[0]} 存量</th>
              </tr>
            </thead>
            <tbody>
              ${filteredItems
                .map(({ item, meta }) => {
                  const haveFrom = Math.round(gFrom.inventory[item] ?? 0);
                  const haveTo = Math.round(gTo.inventory[item] ?? 0);
                  const unitKg = meta.unitMassKg;
                  const curVal = Math.max(-haveTo, Math.min(haveFrom, transferMap.get(item) ?? 0));
                  return `
                    <tr class="rw-gtrade-row ${curVal > 0 ? 'rw-row-selling' : curVal < 0 ? 'rw-row-buying' : ''}" data-item="${item}" title="${meta.desc}">
                      <td style="text-align:left;padding:6px 10px">
                        <div class="rw-trade-item-cell">
                          <span class="rw-trade-item-icon">${meta.icon}</span>
                          <div>
                            <b class="rw-trade-item-title">${meta.name} <small style="color:#8fa0b3;font-weight:400">(${item})</small></b>
                            <span class="rw-trade-cat-tag">${meta.categoryLabel}</span>
                          </div>
                        </div>
                      </td>
                      <td class="rw-trade-num" style="color:#adb5bd">${unitKg.toFixed(1)} kg</td>
                      <td class="rw-trade-num" style="text-align:right">
                        <b>${haveFrom}</b>
                        <span class="rw-gt-after-left" data-item="${item}" style="color:${curVal < 0 ? '#7ef09d' : '#f5d451'}">${curVal !== 0 ? ` → ${haveFrom - curVal}` : ''}</span>
                      </td>
                      <td class="rw-trade-num" style="text-align:right;color:#7ef09d">$0.0</td>
                      <td class="rw-trade-transfer-td">
                        <div class="rw-trade-transfer-ctrl">
                          <button class="rw-trade-step-btn rw-btn-gt-step" data-item="${item}" data-step="left_all" data-max="${haveFrom}" data-min="${-haveTo}" title="全部调入左组 (<<)">&lt;&lt;</button>
                          <button class="rw-trade-step-btn rw-btn-gt-step" data-item="${item}" data-step="-1" data-max="${haveFrom}" data-min="${-haveTo}" title="向左组调拨 1 件 (<)">&lt;</button>
                          <button class="rw-trade-step-btn rw-btn-gt-step" data-item="${item}" data-step="0" data-max="${haveFrom}" data-min="${-haveTo}" title="归零 (0)">0</button>
                          <div class="rw-trade-Editable-wrap">
                            <span class="rw-trade-dir-arrow" data-gt-arrow="${item}">${curVal > 0 ? '►' : curVal < 0 ? '◄' : '·'}</span>
                            <input type="number" class="rw-gtrade-qty-val rw-trade-qty-input" data-item="${item}" data-unitkg="${unitKg}"
                              min="${-haveTo}" max="${haveFrom}" value="${curVal}" />
                          </div>
                          <button class="rw-trade-step-btn rw-btn-gt-step" data-item="${item}" data-step="+1" data-max="${haveFrom}" data-min="${-haveTo}" title="向右组调拨 1 件 (>)">&gt;</button>
                          <button class="rw-trade-step-btn rw-btn-gt-step" data-item="${item}" data-step="all" data-max="${haveFrom}" data-min="${-haveTo}" title="全部调入右组 (>>)">&gt;&gt;</button>
                        </div>
                      </td>
                      <td class="rw-trade-num" style="text-align:left;color:#7ef09d">$0.0</td>
                      <td class="rw-trade-num" style="text-align:left">
                        <b>${haveTo}</b>
                        <span class="rw-gt-after-right" data-item="${item}" style="color:${curVal > 0 ? '#7ef09d' : '#f5d451'}">${curVal !== 0 ? ` → ${haveTo + curVal}` : ''}</span>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>

        <div class="rw-trade-footer">
          <div class="rw-trade-footer-summary" id="rw-gt-footer-summary">
            <span>结算价格：<b style="color:#7ef09d">0 银币</b> · 双向负重实时校验就绪</span>
          </div>
          <div class="rw-trade-footer-btns">
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-gt-reset-btn">↺ 重置 (Reset)</button>
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-gt-swap-btn">⇄ 对调左右编组</button>
            <button class="rw-mini-btn rw-trade-action-btn rw-trade-accept-btn" id="rw-gtrade-confirm">✓ 确认调拨 (Accept)</button>
          </div>
        </div>
      </div>
    `;

    modal.innerHTML = localizeHtml(modal.innerHTML);
    const cardEl = document.getElementById('rw-gtrade-modal-card');
    const headEl = document.getElementById('rw-gtrade-drag-head');
    if (cardEl && headEl) makeModalDraggable(cardEl, headEl, 'rw-gtrade-modal-card');

    const syncGroupMetrics = () => {
      let deltaWeightToRight = 0;
      modal.querySelectorAll<HTMLInputElement>('.rw-gtrade-qty-val').forEach((inp) => {
        const item = String(inp.dataset.item);
        const minV = Number(inp.min) || 0;
        const maxV = Number(inp.max) || 0;
        const val = Math.max(minV, Math.min(maxV, Math.round(Number(inp.value) || 0)));
        transferMap.set(item, val);
        const unitKg = Number(inp.dataset.unitkg) || (ITEM_WEIGHT_KG[item] ?? 1.0);
        deltaWeightToRight += val * unitKg;

        const haveFrom = Math.round(gFrom.inventory[item] ?? 0);
        const haveTo = Math.round(gTo.inventory[item] ?? 0);
        const arrow = modal.querySelector(`[data-gt-arrow="${item}"]`);
        if (arrow) arrow.textContent = val > 0 ? '►' : val < 0 ? '◄' : '·';
        const row = modal.querySelector(`.rw-gtrade-row[data-item="${item}"]`);
        if (row) {
          row.classList.toggle('rw-row-selling', val > 0);
          row.classList.toggle('rw-row-buying', val < 0);
        }
        const afterL = modal.querySelector(`.rw-gt-after-left[data-item="${item}"]`);
        if (afterL) afterL.textContent = val !== 0 ? ` → ${haveFrom - val}` : '';
        const afterR = modal.querySelector(`.rw-gt-after-right[data-item="${item}"]`);
        if (afterR) afterR.textContent = val !== 0 ? ` → ${haveTo + val}` : '';
      });

      const nextLeftKg = Math.max(0, Number((gFrom.currentWeightKg - deltaWeightToRight).toFixed(1)));
      const nextRightKg = Math.max(0, Number((gTo.currentWeightKg + deltaWeightToRight).toFixed(1)));
      const overL = nextLeftKg > gFrom.maxWeightKg + 1e-6;
      const overR = nextRightKg > gTo.maxWeightKg + 1e-6;

      const leftBar = document.getElementById('rw-gt-left-mass-bar');
      if (leftBar) {
        leftBar.innerHTML = `负重：<b style="color:${overL ? '#ff6b6b' : '#8cd4ff'}">${gFrom.currentWeightKg.toFixed(1)} → ${nextLeftKg.toFixed(1)} / ${gFrom.maxWeightKg.toFixed(1)} kg</b>`;
      }
      const rightBar = document.getElementById('rw-gt-right-mass-bar');
      if (rightBar) {
        rightBar.innerHTML = `负重：<b style="color:${overR ? '#ff6b6b' : '#7ef09d'}">${gTo.currentWeightKg.toFixed(1)} → ${nextRightKg.toFixed(1)} / ${gTo.maxWeightKg.toFixed(1)} kg</b>`;
      }
      const footerSum = document.getElementById('rw-gt-footer-summary');
      if (footerSum) {
        const dirTxt =
          Math.abs(deltaWeightToRight) < 0.01
            ? '未选择调拨物资'
            : deltaWeightToRight > 0
              ? `向【${gTo.name.split(' ')[0]}】净转移 +${deltaWeightToRight.toFixed(1)} kg`
              : `向【${gFrom.name.split(' ')[0]}】净转移 +${Math.abs(deltaWeightToRight).toFixed(1)} kg`;
        footerSum.innerHTML = `<span>价格：<b style="color:#7ef09d">0 银币</b> · ${dirTxt} ${overL || overR ? '<b style="color:#ff6b6b">（⚠ 超出接收组最大负重！）</b>' : ''}</span>`;
      }
    };

    syncGroupMetrics();

    document.getElementById('rw-gt-mode-faction')?.addEventListener('click', () => {
      openFactionTradeModal(sim, undefined, undefined, onToast, onRefresh);
    });
    document.getElementById('rw-gt-mode-corpse')?.addEventListener('click', () => {
      const firstCorpse = getDeadPawns(sim)[0];
      if (firstCorpse) {
        openCorpseLootModal(sim, firstCorpse.eid, undefined, onToast, onRefresh);
      } else {
        onToast('当前地图上没有遗体可搜刮');
      }
    });

    document.getElementById('rw-gt-swap-btn')?.addEventListener('click', () => {
      openZeroPriceGroupTradeModal(sim, gTo.id, gFrom.id, onToast, onRefresh);
    });

    document.getElementById('rw-gt-search-inp')?.addEventListener('input', (ev) => {
      searchQuery = (ev.target as HTMLInputElement).value;
      renderGroupTradeDialog();
      const inp = document.getElementById('rw-gt-search-inp') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        inp.setSelectionRange(searchQuery.length, searchQuery.length);
      }
    });
    document.getElementById('rw-gt-sort-sel')?.addEventListener('change', (ev) => {
      sortBy = (ev.target as HTMLSelectElement).value as 'category' | 'name' | 'mass';
      renderGroupTradeDialog();
    });
    modal.querySelectorAll<HTMLButtonElement>('[data-gtcat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCat = (btn.dataset.gtcat as typeof activeCat) ?? 'all';
        renderGroupTradeDialog();
      });
    });

    modal.querySelectorAll<HTMLButtonElement>('.rw-btn-gt-step').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const item = String(btn.dataset.item);
        const maxVal = Number(btn.dataset.max) || 0;
        const minVal = Number(btn.dataset.min) || 0;
        const step = btn.dataset.step;
        const inp = modal.querySelector<HTMLInputElement>(`.rw-gtrade-qty-val[data-item="${item}"]`);
        if (!inp) return;
        let cur = Number(inp.value) || 0;
        if (step === '0') cur = 0;
        else if (step === 'all') cur = maxVal;
        else if (step === 'left_all') cur = minVal;
        else if (step === '+1') cur = Math.min(maxVal, cur + 1);
        else if (step === '-1') cur = Math.max(minVal, cur - 1);
        inp.value = String(cur);
        syncGroupMetrics();
      });
    });

    modal.querySelectorAll<HTMLTableRowElement>('.rw-gtrade-row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        const tgt = ev.target as HTMLElement;
        if (tgt.tagName === 'BUTTON' || tgt.tagName === 'INPUT' || tgt.closest('button')) return;
        const item = String(row.dataset.item);
        const inp = modal.querySelector<HTMLInputElement>(`.rw-gtrade-qty-val[data-item="${item}"]`);
        if (!inp) return;
        const maxVal = Number(inp.max) || 0;
        const cur = Number(inp.value) || 0;
        inp.value = String(cur !== 0 ? 0 : maxVal);
        syncGroupMetrics();
      });
    });

    modal.querySelectorAll('.rw-gtrade-qty-val').forEach((inp) => {
      inp.addEventListener('input', syncGroupMetrics);
      inp.addEventListener('change', syncGroupMetrics);
    });

    document.getElementById('rw-gt-reset-btn')?.addEventListener('click', () => {
      transferMap.clear();
      modal.querySelectorAll<HTMLInputElement>('.rw-gtrade-qty-val').forEach((inp) => {
        inp.value = '0';
      });
      syncGroupMetrics();
    });

    document.getElementById('rw-close-gtrade-modal')?.addEventListener('click', () => {
      modal.hidden = true;
    });

    document.getElementById('rw-gtrade-confirm')?.addEventListener('click', () => {
      const forwardTransfers: { item: string; qty: number }[] = [];
      const reverseTransfers: { item: string; qty: number }[] = [];
      modal.querySelectorAll<HTMLInputElement>('.rw-gtrade-qty-val').forEach((inp) => {
        const qty = Math.round(Number(inp.value) || 0);
        if (qty > 0) forwardTransfers.push({ item: String(inp.dataset.item), qty });
        else if (qty < 0) reverseTransfers.push({ item: String(inp.dataset.item), qty: Math.abs(qty) });
      });

      if (forwardTransfers.length === 0 && reverseTransfers.length === 0) {
        onToast('未选择任何需要调拨的物资');
        return;
      }

      let okAny = false;
      const msgs: string[] = [];
      if (forwardTransfers.length > 0) {
        const resF = executeZeroPriceGroupTrade(sim, gFrom.id, gTo.id, forwardTransfers);
        msgs.push(resF.message);
        if (resF.ok) okAny = true;
      }
      if (reverseTransfers.length > 0) {
        const resR = executeZeroPriceGroupTrade(sim, gTo.id, gFrom.id, reverseTransfers);
        msgs.push(resR.message);
        if (resR.ok) okAny = true;
      }
      onToast(msgs.join(' ｜ '));
      if (okAny) {
        openZeroPriceGroupTradeModal(sim, gFrom.id, gTo.id, onToast, onRefresh);
      }
      onRefresh();
    });
  };

  renderGroupTradeDialog();
}

/**
 * RimWorld 原版风格派系据点 / 访客行商贸易窗（Faction Caravan & Visitor Dialog_Trade）
 */
export function openFactionTradeModal(
  sim: Sim,
  baseId: string | undefined,
  negotiatorEid: number | undefined,
  onToast: (msg: string) => void,
  onRefresh: () => void,
): void {
  const modal = document.getElementById('rw-corpse-modal');
  if (!modal) return;
  refreshGroupCarryMetrics(sim);
  const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
  const negotiator = (negotiatorEid ? sim.pawn(negotiatorEid) : undefined) ?? colonists[0];
  const socialLv = negotiator?.skills?.find((s) => s.id === 'medical_social')?.level ?? 6;
  const socialBonusPct = Math.min(28, Math.round(socialLv * 1.5));

  const friendlyBases = [...getNpcBases(sim).values()].filter((b) => !b.defeated && b.reputation > -25);
  const strangerPawn = [...sim.pawns()].find((p) => p.isStranger);
  const selectedTargetId = baseId ?? friendlyBases[0]?.id ?? 'stranger_caravan';
  const targetBase = friendlyBases.find((b) => b.id === selectedTargetId);

  const traderName = targetBase
    ? `${targetBase.name} · ${targetBase.factionName}`
    : `${strangerPawn?.name ?? '旅鼠·墨菲'} (过境行商 Caravan)`;
  const traderStock: Record<string, number> = targetBase
    ? targetBase.lootStock
    : (strangerPawn?.inventory ?? { food: 15, herb: 6, gold: 4, wood: 10 });

  const allItems = ['meal', 'food', 'meat', 'herb', 'wood', 'stone', 'ore', 'leather', 'components', 'jade'];
  const tradeDeltas = new Map<string, number>();

  let searchQuery = '';
  let activeCat: 'all' | 'food_med' | 'material' | 'combat' | 'luxury' = 'all';
  let sortBy: 'category' | 'name' | 'price' | 'mass' = 'category';

  modal.hidden = false;

  const computePrices = (meta: ItemTradeMeta) => {
    const repBonus = targetBase && targetBase.reputation >= 40 ? 0.1 : 0;
    const sellFactor = Math.min(0.95, 0.72 + socialBonusPct / 100 + repBonus);
    const buyFactor = Math.max(1.05, 1.28 - socialBonusPct / 100 - repBonus);
    return {
      sellPrice: Math.max(1, Math.round(meta.basePrice * sellFactor)),
      buyPrice: Math.max(2, Math.round(meta.basePrice * buyFactor)),
    };
  };

  const renderFactionTrade = () => {
    const colonySilver = Math.round((sim.stockpile['gold'] ?? 0) * 50 + (sim.stockpile['silver'] ?? 200));
    const traderSilver = Math.round((traderStock['gold'] ?? 8) * 50 + 450);

    const rows = allItems
      .map((key) => {
        const meta = getItemTradeMeta(key);
        const { sellPrice, buyPrice } = computePrices(meta);
        const haveColony = Math.max(0, Math.floor(sim.stockpile[key] ?? 0));
        const haveTrader = Math.max(0, Math.floor(traderStock[key] ?? 0));
        return { key, meta, sellPrice, buyPrice, haveColony, haveTrader };
      })
      .filter((r) => {
        if (activeCat !== 'all' && r.meta.category !== activeCat) return false;
        if (searchQuery.trim() !== '') {
          const q = searchQuery.trim().toLowerCase();
          return (
            r.meta.name.toLowerCase().includes(q) ||
            r.meta.enName.toLowerCase().includes(q) ||
            r.key.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.meta.name.localeCompare(b.meta.name);
        if (sortBy === 'price') return b.meta.basePrice - a.meta.basePrice;
        if (sortBy === 'mass') return b.meta.unitMassKg - a.meta.unitMassKg;
        return a.meta.category.localeCompare(b.meta.category) || a.meta.name.localeCompare(b.meta.name);
      });

    modal.innerHTML = `
      <div class="rw-modal-card rw-bevel-box rw-trade-dialog" id="rw-ftrade-modal-card">
        <div class="rw-drawer-head rw-trade-titlebar" id="rw-ftrade-drag-head">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <b style="font-size:14.5px;color:#f5d451">⚖ RimWorld 殖民地贸易与物资调拨总署 (Dialog_Trade)</b>
            <div class="rw-trade-mode-tabs">
              <button class="rw-subcat-btn active">🤝 派系商队贸易</button>
              <button class="rw-subcat-btn" id="rw-ft-mode-group">⚖ 跨组零价调拨 (P=0)</button>
              <button class="rw-subcat-btn" id="rw-ft-mode-corpse">🪦 遗体搜刮窗 (P=0)</button>
            </div>
          </div>
          <button class="rw-subcat-btn" id="rw-close-ftrade-modal">✕ 关闭 (ESC)</button>
        </div>

        <div class="rw-trade-header-grid">
          <div class="rw-trade-party-box">
            <div class="rw-trade-party-role">🏛 我方殖民地与谈判代表 (Colony Negotiator)</div>
            <div class="rw-trade-party-main">
              <span>谈判代表：</span>
              <b style="color:#f5d451;font-size:13.5px">${negotiator?.name ?? '殖民者'} (社交 Lv.${socialLv})</b>
            </div>
            <div class="rw-trade-party-sub">
              社交价格改善：<b style="color:#7ef09d">+${socialBonusPct}%</b> · 黄金储备：<b style="color:#f5d451">${Math.round(sim.stockpile['gold'] ?? 0)} 黄金 (折合 ${colonySilver} 银币)</b>
            </div>
          </div>

          <div class="rw-trade-filter-box">
            <div style="display:flex;gap:6px;width:100%">
              <input id="rw-ft-search-inp" type="text" class="rw-trade-search" placeholder="🔍 搜索商品名称..." value="${searchQuery}" />
              <select id="rw-ft-sort-sel" class="rw-trade-select" style="width:118px">
                <option value="category" ${sortBy === 'category' ? 'selected' : ''}>排序：按分类</option>
                <option value="name" ${sortBy === 'name' ? 'selected' : ''}>排序：按名称</option>
                <option value="price" ${sortBy === 'price' ? 'selected' : ''}>排序：按价值</option>
                <option value="mass" ${sortBy === 'mass' ? 'selected' : ''}>排序：按单重</option>
              </select>
            </div>
            <div class="rw-trade-cat-pills">
              <button class="rw-collapse-mini ${activeCat === 'all' ? 'active' : ''}" data-ftcat="all">全部</button>
              <button class="rw-collapse-mini ${activeCat === 'food_med' ? 'active' : ''}" data-ftcat="food_med">🍖 食物医药</button>
              <button class="rw-collapse-mini ${activeCat === 'material' ? 'active' : ''}" data-ftcat="material">🪵 建材矿石</button>
              <button class="rw-collapse-mini ${activeCat === 'luxury' ? 'active' : ''}" data-ftcat="luxury">⚙ 精密贵重</button>
            </div>
          </div>

          <div class="rw-trade-party-box rw-trade-party-right">
            <div class="rw-trade-party-role">⛺ 交易商队与友方派系据点 (Faction Trader)</div>
            <div class="rw-trade-party-main" style="justify-content:flex-end">
              <span>贸易对象：</span>
              <b style="color:#f5d451;font-size:13.5px">${traderName}</b>
            </div>
            <div class="rw-trade-party-sub">
              商队银币：<b style="color:#7ef09d">${traderSilver} 银币</b>
            </div>
          </div>
        </div>

        <div class="rw-trade-currency-bar">
          <div class="rw-trade-curr-left">
            <span class="rw-trade-item-icon">🪙</span>
            <b>银币 / 黄金通货 (Silver)</b>
            <span class="rw-trade-curr-count">我方持有：<b>${colonySilver}</b></span>
          </div>
          <div class="rw-trade-curr-mid" id="rw-ft-silver-flow">
            <span class="rw-trade-zero-badge">· 0 银币 (收支平衡) ·</span>
          </div>
          <div class="rw-trade-curr-right">
            <span>商队持有：<b>${traderSilver}</b></span>
          </div>
        </div>

        <div class="rw-trade-table-wrap">
          <table class="rw-trade-table">
            <thead>
              <tr>
                <th style="text-align:left;padding-left:10px">商品名称与分类 (Item)</th>
                <th style="width:65px">单重</th>
                <th style="width:95px;text-align:right">我方库存</th>
                <th style="width:72px;text-align:right">出售价</th>
                <th style="width:285px;text-align:center">◄ 买入回营 (&lt;&lt; &lt; 0 &gt; &gt;&gt;) 卖出换银 ►</th>
                <th style="width:72px;text-align:left">收购价</th>
                <th style="width:95px;text-align:left">商队库存</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((r) => {
                  const cur = Math.max(-r.haveColony, Math.min(r.haveTrader, tradeDeltas.get(r.key) ?? 0));
                  return `
                    <tr class="rw-ftrade-row ${cur > 0 ? 'rw-row-buying' : cur < 0 ? 'rw-row-selling' : ''}" data-item="${r.key}" title="${r.meta.desc}">
                      <td style="text-align:left;padding:6px 10px">
                        <div class="rw-trade-item-cell">
                          <span class="rw-trade-item-icon">${r.meta.icon}</span>
                          <div>
                            <b class="rw-trade-item-title">${r.meta.name} <small style="color:#8fa0b3;font-weight:400">(${r.meta.enName})</small></b>
                            <span class="rw-trade-cat-tag">${r.meta.categoryLabel}</span>
                          </div>
                        </div>
                      </td>
                      <td class="rw-trade-num" style="color:#adb5bd">${r.meta.unitMassKg.toFixed(1)} kg</td>
                      <td class="rw-trade-num" style="text-align:right">
                        <b>${r.haveColony}</b>
                        <span class="rw-ft-after-left" data-item="${r.key}" style="color:${cur > 0 ? '#7ef09d' : '#f5d451'}">${cur !== 0 ? ` → ${r.haveColony + cur}` : ''}</span>
                      </td>
                      <td class="rw-trade-num" style="text-align:right;color:#dce3ec">$${r.sellPrice}</td>
                      <td class="rw-trade-transfer-td">
                        <div class="rw-trade-transfer-ctrl">
                          <button class="rw-trade-step-btn rw-btn-ft-step" data-item="${r.key}" data-step="buy_all" data-max="${r.haveTrader}" data-min="${-r.haveColony}" title="全部买入我方 (<<)">&lt;&lt;</button>
                          <button class="rw-trade-step-btn rw-btn-ft-step" data-item="${r.key}" data-step="+1" data-max="${r.haveTrader}" data-min="${-r.haveColony}" title="向左买入 +1 件 (<)">&lt;</button>
                          <button class="rw-trade-step-btn rw-btn-ft-step" data-item="${r.key}" data-step="0" data-max="${r.haveTrader}" data-min="${-r.haveColony}" title="归零 (0)">0</button>
                          <div class="rw-trade-Editable-wrap">
                            <span class="rw-trade-dir-arrow" data-ft-arrow="${r.key}">${cur > 0 ? '◄' : cur < 0 ? '►' : '·'}</span>
                            <input type="number" class="rw-ftrade-qty-val rw-trade-qty-input" data-item="${r.key}"
                              data-sell="${r.sellPrice}" data-buy="${r.buyPrice}" data-unitkg="${r.meta.unitMassKg}"
                              min="${-r.haveColony}" max="${r.haveTrader}" value="${cur}" />
                          </div>
                          <button class="rw-trade-step-btn rw-btn-ft-step" data-item="${r.key}" data-step="-1" data-max="${r.haveTrader}" data-min="${-r.haveColony}" title="向右卖出 +1 件 (>)">&gt;</button>
                          <button class="rw-trade-step-btn rw-btn-ft-step" data-item="${r.key}" data-step="sell_all" data-max="${r.haveTrader}" data-min="${-r.haveColony}" title="全部卖出给商队 (>>)">&gt;&gt;</button>
                        </div>
                      </td>
                      <td class="rw-trade-num" style="text-align:left;color:#f5d451">$${r.buyPrice}</td>
                      <td class="rw-trade-num" style="text-align:left">
                        <b>${r.haveTrader}</b>
                        <span class="rw-ft-after-right" data-item="${r.key}" style="color:${cur < 0 ? '#7ef09d' : '#f5d451'}">${cur !== 0 ? ` → ${r.haveTrader - cur}` : ''}</span>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>

        <div class="rw-trade-footer">
          <div class="rw-trade-footer-summary" id="rw-ft-footer-summary">
            <span>调整中央数量进行买卖（左正◄为买入，右负►为卖出）</span>
          </div>
          <div class="rw-trade-footer-btns">
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-ft-reset-btn">↺ 重置 (Reset)</button>
            <button class="rw-mini-btn rw-trade-action-btn" id="rw-ft-gift-btn" style="background:#3d4b30;border-color:#9cc98a;color:#fff">🎁 赠送超额物资 (+好感)</button>
            <button class="rw-mini-btn rw-trade-action-btn rw-trade-accept-btn" id="rw-ftrade-confirm">✓ 确认交易 (Accept)</button>
          </div>
        </div>
      </div>
    `;

    modal.innerHTML = localizeHtml(modal.innerHTML);
    const cardEl = document.getElementById('rw-ftrade-modal-card');
    const headEl = document.getElementById('rw-ftrade-drag-head');
    if (cardEl && headEl) makeModalDraggable(cardEl, headEl, 'rw-ftrade-modal-card');

    const updateFactionTradePreview = () => {
      let netSilver = 0;
      let netMassDelta = 0;
      modal.querySelectorAll<HTMLInputElement>('.rw-ftrade-qty-val').forEach((inp) => {
        const key = String(inp.dataset.item);
        const minV = Number(inp.min) || 0;
        const maxV = Number(inp.max) || 0;
        const val = Math.max(minV, Math.min(maxV, Math.round(Number(inp.value) || 0)));
        tradeDeltas.set(key, val);
        const sellP = Number(inp.dataset.sell) || 5;
        const buyP = Number(inp.dataset.buy) || 8;
        const unitKg = Number(inp.dataset.unitkg) || 1;
        if (val > 0) netSilver -= val * buyP;
        else if (val < 0) netSilver += Math.abs(val) * sellP;
        netMassDelta += val * unitKg;

        const haveC = Math.max(0, Math.floor(sim.stockpile[key] ?? 0));
        const haveT = Math.max(0, Math.floor(traderStock[key] ?? 0));
        const arrow = modal.querySelector(`[data-ft-arrow="${key}"]`);
        if (arrow) arrow.textContent = val > 0 ? '◄' : val < 0 ? '►' : '·';
        const row = modal.querySelector(`.rw-ftrade-row[data-item="${key}"]`);
        if (row) {
          row.classList.toggle('rw-row-buying', val > 0);
          row.classList.toggle('rw-row-selling', val < 0);
        }
        const afterL = modal.querySelector(`.rw-ft-after-left[data-item="${key}"]`);
        if (afterL) afterL.textContent = val !== 0 ? ` → ${haveC + val}` : '';
        const afterR = modal.querySelector(`.rw-ft-after-right[data-item="${key}"]`);
        if (afterR) afterR.textContent = val !== 0 ? ` → ${haveT - val}` : '';
      });

      const silverEl = document.getElementById('rw-ft-silver-flow');
      const cannotAfford = netSilver < -colonySilver;
      if (silverEl) {
        if (netSilver === 0) {
          silverEl.innerHTML = `<span class="rw-trade-zero-badge">· 0 银币 (以物易物收支平衡) ·</span>`;
        } else if (netSilver > 0) {
          silverEl.innerHTML = `<span class="rw-trade-zero-badge" style="color:#7ef09d;border-color:#5cb85c">◄ 净赚 +${netSilver} 银币 (折合 +${(netSilver / 50).toFixed(1)} 黄金)</span>`;
        } else {
          silverEl.innerHTML = `<span class="rw-trade-zero-badge" style="color:${cannotAfford ? '#ff6b6b' : '#f5d451'};border-color:${cannotAfford ? '#ff6b6b' : '#f5d451'}">需支付 ${Math.abs(netSilver)} 银币 ► ${cannotAfford ? '(⚠ 我方银币/黄金不足！请多卖出物资冲抵)' : ''}</span>`;
        }
      }

      const footerEl = document.getElementById('rw-ft-footer-summary');
      if (footerEl) {
        footerEl.innerHTML = `<span>净收支：<b style="color:${netSilver >= 0 ? '#7ef09d' : cannotAfford ? '#ff6b6b' : '#f5d451'}">${netSilver >= 0 ? `+${netSilver}` : netSilver} 银币</b> · 殖民地库存质量变化：<b>${netMassDelta >= 0 ? `+${netMassDelta.toFixed(1)}` : netMassDelta.toFixed(1)} kg</b></span>`;
      }
    };

    updateFactionTradePreview();

    document.getElementById('rw-ft-mode-group')?.addEventListener('click', () => {
      openZeroPriceGroupTradeModal(sim, 'group_alpha', 'group_beta', onToast, onRefresh);
    });
    document.getElementById('rw-ft-mode-corpse')?.addEventListener('click', () => {
      const firstCorpse = getDeadPawns(sim)[0];
      if (firstCorpse) openCorpseLootModal(sim, firstCorpse.eid, negotiator?.eid, onToast, onRefresh);
      else onToast('当前地图上没有遗体可搜刮');
    });

    document.getElementById('rw-ft-search-inp')?.addEventListener('input', (ev) => {
      searchQuery = (ev.target as HTMLInputElement).value;
      renderFactionTrade();
      const inp = document.getElementById('rw-ft-search-inp') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        inp.setSelectionRange(searchQuery.length, searchQuery.length);
      }
    });
    document.getElementById('rw-ft-sort-sel')?.addEventListener('change', (ev) => {
      sortBy = (ev.target as HTMLSelectElement).value as typeof sortBy;
      renderFactionTrade();
    });
    modal.querySelectorAll<HTMLButtonElement>('[data-ftcat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCat = (btn.dataset.ftcat as typeof activeCat) ?? 'all';
        renderFactionTrade();
      });
    });

    modal.querySelectorAll<HTMLButtonElement>('.rw-btn-ft-step').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const item = String(btn.dataset.item);
        const maxVal = Number(btn.dataset.max) || 0;
        const minVal = Number(btn.dataset.min) || 0;
        const step = btn.dataset.step;
        const inp = modal.querySelector<HTMLInputElement>(`.rw-ftrade-qty-val[data-item="${item}"]`);
        if (!inp) return;
        let cur = Number(inp.value) || 0;
        if (step === '0') cur = 0;
        else if (step === 'buy_all') cur = maxVal;
        else if (step === 'sell_all') cur = minVal;
        else if (step === '+1') cur = Math.min(maxVal, cur + 1);
        else if (step === '-1') cur = Math.max(minVal, cur - 1);
        inp.value = String(cur);
        updateFactionTradePreview();
      });
    });

    modal.querySelectorAll('.rw-ftrade-qty-val').forEach((inp) => {
      inp.addEventListener('input', updateFactionTradePreview);
      inp.addEventListener('change', updateFactionTradePreview);
    });

    document.getElementById('rw-ft-reset-btn')?.addEventListener('click', () => {
      tradeDeltas.clear();
      modal.querySelectorAll<HTMLInputElement>('.rw-ftrade-qty-val').forEach((inp) => {
        inp.value = '0';
      });
      updateFactionTradePreview();
    });

    document.getElementById('rw-close-ftrade-modal')?.addEventListener('click', () => {
      modal.hidden = true;
    });

    document.getElementById('rw-ft-gift-btn')?.addEventListener('click', () => {
      let giftedValue = 0;
      const giftedList: string[] = [];
      modal.querySelectorAll<HTMLInputElement>('.rw-ftrade-qty-val').forEach((inp) => {
        const key = String(inp.dataset.item);
        const val = Math.round(Number(inp.value) || 0);
        const sellP = Number(inp.dataset.sell) || 5;
        if (val < 0) {
          const giveQty = Math.min(Math.floor(sim.stockpile[key] ?? 0), Math.abs(val));
          if (giveQty > 0) {
            sim.stockpile[key] = Math.max(0, (sim.stockpile[key] ?? 0) - giveQty);
            traderStock[key] = (traderStock[key] ?? 0) + giveQty;
            giftedValue += giveQty * sellP;
            giftedList.push(`${key}×${giveQty}`);
          }
        }
      });
      if (giftedValue <= 0) {
        onToast('请先用「> / >>」向右侧调出至少 1 件要赠送的物资');
        return;
      }
      const repGain = Math.max(5, Math.round(giftedValue / 6));
      if (targetBase) {
        targetBase.reputation = Math.min(100, targetBase.reputation + repGain);
      }
      const msg = `🎁【商队赠礼】${negotiator?.name ?? '殖民地'} 向【${traderName}】慷慨赠送了 ${giftedList.join(', ')}（总值 $${giftedValue}，派系好感 +${repGain}）！`;
      sim.log(msg);
      onToast(msg);
      tradeDeltas.clear();
      renderFactionTrade();
      onRefresh();
    });

    document.getElementById('rw-ftrade-confirm')?.addEventListener('click', () => {
      let netSilver = 0;
      const actions: { key: string; delta: number }[] = [];
      modal.querySelectorAll<HTMLInputElement>('.rw-ftrade-qty-val').forEach((inp) => {
        const key = String(inp.dataset.item);
        const minV = Number(inp.min) || 0;
        const maxV = Number(inp.max) || 0;
        const val = Math.max(minV, Math.min(maxV, Math.round(Number(inp.value) || 0)));
        const sellP = Number(inp.dataset.sell) || 5;
        const buyP = Number(inp.dataset.buy) || 8;
        if (val !== 0) {
          actions.push({ key, delta: val });
          if (val > 0) netSilver -= val * buyP;
          else netSilver += Math.abs(val) * sellP;
        }
      });

      if (actions.length === 0) {
        onToast('尚未选择任何交易商品');
        return;
      }

      if (netSilver < -colonySilver) {
        onToast(`⚠ 交易失败：需要支付 ${Math.abs(netSilver)} 银币，但我方当前仅折合 ${colonySilver} 银币！请多卖出一些物资`);
        return;
      }

      const boughtTxt: string[] = [];
      const soldTxt: string[] = [];
      for (const { key, delta } of actions) {
        if (delta > 0) {
          sim.stockpile[key] = (sim.stockpile[key] ?? 0) + delta;
          traderStock[key] = Math.max(0, (traderStock[key] ?? 0) - delta);
          boughtTxt.push(`+${delta} ${key}`);
        } else if (delta < 0) {
          const sellQty = Math.abs(delta);
          sim.stockpile[key] = Math.max(0, (sim.stockpile[key] ?? 0) - sellQty);
          traderStock[key] = (traderStock[key] ?? 0) + sellQty;
          soldTxt.push(`-${sellQty} ${key}`);
        }
      }

      if (netSilver > 0) {
        const goldGain = Math.max(1, Math.round(netSilver / 50));
        sim.stockpile['gold'] = (sim.stockpile['gold'] ?? 0) + goldGain;
      } else if (netSilver < 0) {
        const goldCost = Math.ceil(Math.abs(netSilver) / 50);
        sim.stockpile['gold'] = Math.max(0, (sim.stockpile['gold'] ?? 0) - goldCost);
      }

      if (targetBase) {
        targetBase.reputation = Math.min(100, targetBase.reputation + 6);
      }

      const summary = [
        boughtTxt.length > 0 ? `购入 ${boughtTxt.join(', ')}` : '',
        soldTxt.length > 0 ? `售出 ${soldTxt.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('；');
      const msg = `🤝【RimWorld 商队贸易完成】与【${traderName}】达成交易：${summary}（净收支 ${netSilver >= 0 ? `+${netSilver}` : netSilver} 银币）`;
      sim.log(msg);
      onToast(msg);
      tradeDeltas.clear();
      renderFactionTrade();
      onRefresh();
    });
  };

  renderFactionTrade();
}
