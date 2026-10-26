/**
 * client/ui-drawers.ts —— RimWorld 底部抽屉渲染器：
 *  - 工作指派 (`work`) 全宽展开，隐藏两侧遮挡面板；
 *  - 遗迹搜刮逻辑已独立为 `dlc-ruin-scavenge`（默认禁用）；
 *  - 身体部位 (`anatomy`) 与电网负荷已分别整合至左下角检视面板的「健康」页签与「电网负荷」快捷高亮栏中。
 */

import type { Sim } from '../sim';
import {
  ARCHITECT_BUILDABLES,
  DLC_CATALOG,
  MAX_ROOM_SIDE,
  MAX_ZOOM_FOG_RADIUS,
  RIMWORLD_WORK_TYPES,
  TRIAD_CATALOG,
  assaultNpcBase,
  assignPawnToGroup,
  benchmarkHundredPawnsSim,
  createColonistGroup,
  ensurePawnTriads,
  getActiveSimDlcs,
  getColonistGroups,
  getDeadPawns,
  getFactionBehaviorByRelation,
  getNpcBases,
  getRuinScavengeableBuildings,
  getRuinSites,
  giftNpcBase,
  isAiModeDlcEnabled,
  isRuinScavengeDlcEnabled,
  isStrangerPawn,
  kidnapFromFaction,
  loadCustomModJsonOnSim,
  refreshGroupCarryMetrics,
  requestAllyReinforcements,
  orderScavengeRuinBuilding,
  scavengeRuinBuilding,
  setPawnWorkPriority,
  spawnHundredPawnColony,
  stealFromFaction,
  toggleSimDlc,
} from '../sim';
import { MIN_ZOOM_TILE_PX } from './render';
import { localizeHtml, t, tr } from './i18n';
import { svgIcon } from './ui-icons';
import { makeModalDraggable, openCorpseLootModal, openFactionTradeModal, openZeroPriceGroupTradeModal } from './ui-modals';
import {
  isManualWorkPriorityMode,
  renderScheduleDrawer,
  setManualWorkPriorityMode,
} from './ui-schedule-bills';

export interface DrawerRenderContext {
  sim: Sim;
  activeTab: string;
  architectCategory: string;
  setArchitectCategory: (cat: string) => void;
  buildRotation: number;
  rotateBuildOrientation: () => void;
  selectBuildDesignator: (defId: string, name: string) => void;
  selectOrderDesignator: (orderKind: 'mine' | 'chop' | 'harvest' | 'deconstruct', label: string) => void;
  centerCameraOn: (x: number, y: number) => void;
  setZoomTilePx?: (px: number) => void;
  getZoomTilePx?: () => number;
  onSave: () => void;
  onLoad: () => void;
  onNewWorld: () => void;
  closeDrawer: () => void;
  showToast: (msg: string) => void;
  forceRefresh: () => void;
}

function bindDrawerDragAndClose(el: HTMLElement, closeDrawer: () => void): void {
  el.innerHTML = localizeHtml(el.innerHTML);
  document.getElementById('rw-drawer-collapse-btn')?.addEventListener('click', closeDrawer);
  const head = el.querySelector<HTMLElement>('.rw-drawer-head');
  if (head) makeModalDraggable(el, head, 'rw-main-drawer');
}

export function renderActiveDrawerContent(el: HTMLElement, ctx: DrawerRenderContext): void {
  const { sim, activeTab } = ctx;
  const closeBtnHtml = `<button class="rw-subcat-btn" id="rw-drawer-collapse-btn">${svgIcon('cancel', 11)} 收起 (ESC)</button>`;

  if (activeTab === 'schedule') {
    renderScheduleDrawer(el, sim, ctx.closeDrawer, ctx.showToast, ctx.forceRefresh);
    return;
  }

  if (activeTab === 'architect') {
    const cats = [
      { id: 'structure', icon: 'wall', label: '墙壁与门' },
      { id: 'exterior', icon: 'solar_generator', label: '外部设施 (禁放室内)' },
      { id: 'zone', icon: 'field', label: '农田与仓储' },
      { id: 'security', icon: 'turret', label: '防卫工事' },
      { id: 'orders', icon: 'mine', label: '作业指令' },
    ];
    const itemsHtml =
      ctx.architectCategory === 'orders'
        ? `
          <button class="rw-arch-card" data-order="mine"><b>${svgIcon('mine', 20)} 开采矿脉 (Mine)</b><span>点击或拖拽矿脉/岩层开采钢铁与黄金</span></button>
          <button class="rw-arch-card" data-order="chop"><b>${svgIcon('chop', 20)} 砍伐树木 (Chop Wood)</b><span>点击或拖拽 1×1 乔木砍伐获取原木、百花蜜与荧光菌</span></button>
          <button class="rw-arch-card" data-order="harvest"><b>${svgIcon('harvest', 20)} 收获植物 (Harvest)</b><span>采集野生浆果丛、香辛料或成熟农作物</span></button>
          <button class="rw-arch-card" data-order="deconstruct"><b>${svgIcon('deconstruct', 20)} 拆除建筑 (Deconstruct)</b><span>拆除墙体、家具或设施并回收 75% 建材</span></button>
        `
        : ARCHITECT_BUILDABLES.filter((b) => b.category === ctx.architectCategory && !b.ruinOnly && !b.interiorOnly)
            .map((b) => {
              const fp = sim.world.footprint(b.defId, ctx.buildRotation as 0 | 1 | 2 | 3);
              const costHtml = Object.entries(b.cost)
                .map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:2px">${svgIcon(k, 12)}${v}</span>`)
                .join(' ');
              return `
                <button class="rw-arch-card" data-build="${b.defId}" data-bname="${b.name}">
                  <b>${svgIcon(b.icon, 20)} ${tr(b.name)}</b>
                  <span style="display:flex;align-items:center;gap:6px">造价：${costHtml} · 占地 <b>${fp.w}×${fp.h}</b></span>
                  <small>${tr(b.desc)}</small>
                </button>
              `;
            })
            .join('');

    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('architect', 16)} 建筑规划菜单 (直接建造墙壁与门 / 外部设施禁放室内 · 室内内设/装饰/工作台请点击封闭房间后在房间面板内布置)</b>
        <div class="rw-subcat-bar">
          ${cats.map((c) => `<button class="rw-subcat-btn ${ctx.architectCategory === c.id ? 'active' : ''}" data-arch-cat="${c.id}" style="display:inline-flex;align-items:center;gap:4px">${svgIcon(c.icon, 13)} ${c.label}</button>`).join('')}
          <button class="rw-subcat-btn" id="rw-arch-rot-btn">${svgIcon('rotate', 13)} 朝向 ${ctx.buildRotation * 90}° (R)</button>
          ${closeBtnHtml}
        </div>
      </div>
      <div class="rw-arch-grid">${itemsHtml}</div>
    `;

    bindDrawerDragAndClose(el, ctx.closeDrawer);
    document.getElementById('rw-arch-rot-btn')?.addEventListener('click', ctx.rotateBuildOrientation);
    el.querySelectorAll<HTMLButtonElement>('[data-arch-cat]').forEach((b) => {
      b.addEventListener('click', () => ctx.setArchitectCategory(b.dataset.archCat!));
    });
    el.querySelectorAll<HTMLButtonElement>('[data-build]').forEach((b) => {
      b.addEventListener('click', () => ctx.selectBuildDesignator(String(b.dataset.build), String(b.dataset.bname)));
    });
    el.querySelectorAll<HTMLButtonElement>('[data-order]').forEach((b) => {
      b.addEventListener('click', () =>
        ctx.selectOrderDesignator(
          b.dataset.order as 'mine' | 'chop' | 'harvest' | 'deconstruct',
          b.querySelector('b')?.textContent?.trim() ?? '作业',
        ),
      );
    });
    return;
  }

  if (activeTab === 'work') {
    const pawns = [...sim.pawns()].filter((p) => !isStrangerPawn(p, sim.activePlayerId));
    const groupsMap = getColonistGroups(sim);
    const isManual = isManualWorkPriorityMode();
    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('work', 16)} 工作指派总表 (全宽模式 · 已自动隐藏侧栏窗口 · 左键调高 / 右键调低 · 从左至右优先执行)</b>
        <div class="rw-subcat-bar">
          <button class="rw-subcat-btn ${isManual ? 'active' : ''}" id="rw-work-manual-toggle">
            ${isManual ? '🔢 数字优先级 (1=最高 · 4=最低)' : '✔ 勾选模式 (点击切换数字 1-4)'}
          </button>
          <button class="rw-subcat-btn" id="rw-work-auto-best">⚡ 按擅长技能自动分配</button>
          ${closeBtnHtml}
        </div>
      </div>
      <div class="rw-table-wrap" style="margin-bottom:8px;overflow-x:auto">
        <table class="rw-work-table" style="width:100%">
          <thead>
            <tr>
              <th style="min-width:110px">殖民者 (编组)</th>
              <th style="min-width:120px">当前作业状态</th>
              <th style="min-width:210px">擅长技能与热情</th>
              ${RIMWORLD_WORK_TYPES.map((w) => `<th title="${w.label}（点击列头整列调整）" style="cursor:pointer;min-width:62px" data-wp-col="${w.id}"><div style="display:flex;flex-direction:column;align-items:center;gap:2px">${svgIcon(w.icon, 15)}<span>${tr(w.label)}</span></div></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${pawns
              .slice(0, 18)
              .map((p) => {
                const triads = ensurePawnTriads(p, sim.world.seed);
                const wp = p.workPriorities ?? {};
                const grpName = groupsMap.get(p.groupId ?? 'group_alpha')?.name.split(' ')[0] ?? '主力组';
                const statusTxt = p.drafted ? '⚔ 征召中' : p.activeWork?.label ?? '空闲/巡视';
                return `
                  <tr>
                    <td><b>${p.name}</b> <small style="color:#8cd4ff">[${grpName}]</small></td>
                    <td style="font-size:11px;color:#cfd8e3">${statusTxt}</td>
                    <td style="text-align:left;font-size:11px">
                      ${triads
                        .map((t) => {
                          const def = TRIAD_CATALOG[t.skillId];
                          const flame = t.passion === 2 ? '🔥🔥' : t.passion === 1 ? '🔥' : '';
                          return `<span class="rw-gene-chip" style="margin-right:4px">${flame}${def?.skillName.split(' ')[0] ?? t.skillId} Lv.${t.level}</span>`;
                        })
                        .join('')}
                    </td>
                    ${RIMWORLD_WORK_TYPES.map((w) => {
                      const val = wp[w.id] ?? 3;
                      const txt = isManual ? (val === 0 ? '—' : String(val)) : val > 0 ? '✔' : '—';
                      return `<td><button class="rw-prio-cell prio-${val}" data-wp-eid="${p.eid}" data-wp-id="${w.id}" title="左键提高优先级 / 右键降低优先级">${txt}</button></td>`;
                    }).join('')}
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    bindDrawerDragAndClose(el, ctx.closeDrawer);
    document.getElementById('rw-work-manual-toggle')?.addEventListener('click', () => {
      setManualWorkPriorityMode(!isManual);
      ctx.showToast(!isManual ? '🔢 已切换为数字优先级模式 (1=最高，4=最低)' : '✔ 已切换为勾选模式');
      ctx.forceRefresh();
    });
    document.getElementById('rw-work-auto-best')?.addEventListener('click', () => {
      setManualWorkPriorityMode(true);
      for (const p of pawns) {
        const triads = ensurePawnTriads(p, sim.world.seed);
        const boundWork = new Set(triads.flatMap((t) => t.boundWorkIds));
        for (const w of RIMWORLD_WORK_TYPES) {
          const prio = w.id === 'firefight' || w.id === 'doctor' ? 1 : boundWork.has(w.id) ? 1 : 3;
          setPawnWorkPriority(sim, p.eid, w.id, prio);
        }
      }
      ctx.showToast('⚡ 已按每位殖民者的擅长技能自动设为优先级 1');
      ctx.forceRefresh();
    });
    el.querySelectorAll<HTMLElement>('[data-wp-col]').forEach((th) => {
      th.addEventListener('click', () => {
        const wid = th.dataset.wpCol as (typeof RIMWORLD_WORK_TYPES)[number]['id'];
        for (const p of pawns) {
          const cur = p.workPriorities?.[wid] ?? 3;
          const next = ((cur + 4) % 5) as 0 | 1 | 2 | 3 | 4;
          setPawnWorkPriority(sim, p.eid, wid, next);
        }
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-wp-eid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const eid = Number(btn.dataset.wpEid);
        const wid = btn.dataset.wpId as (typeof RIMWORLD_WORK_TYPES)[number]['id'];
        const p = sim.pawn(eid);
        const cur = p?.workPriorities?.[wid] ?? 3;
        const next = (isManual ? (cur + 1) % 5 : cur > 0 ? 0 : 3) as 0 | 1 | 2 | 3 | 4;
        setPawnWorkPriority(sim, eid, wid, next);
        ctx.forceRefresh();
      });
      btn.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const eid = Number(btn.dataset.wpEid);
        const wid = btn.dataset.wpId as (typeof RIMWORLD_WORK_TYPES)[number]['id'];
        const p = sim.pawn(eid);
        const cur = p?.workPriorities?.[wid] ?? 3;
        const next = ((cur + 4) % 5) as 0 | 1 | 2 | 3 | 4;
        setPawnWorkPriority(sim, eid, wid, next);
        ctx.forceRefresh();
      });
    });
    return;
  }

  if (activeTab === 'groups') {
    refreshGroupCarryMetrics(sim);
    const groups = [...getColonistGroups(sim).values()];
    const corpses = getDeadPawns(sim);
    const pawns = [...sim.pawns()].filter((p) => !isStrangerPawn(p, sim.activePlayerId));

    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('groups', 16)} 小队编组与行囊负重 (${groups.length} 个编组 · ${corpses.length} 具待处理遗体)</b>
        <div class="rw-subcat-bar">
          <input id="rw-drawer-new-grp-inp" type="text" placeholder="新编组名称(如:采矿队)" style="background:#14181c;border:1px solid #56606b;color:#fff;padding:3px 7px;font-size:11.5px;width:135px" />
          <button class="rw-subcat-btn" id="rw-drawer-create-grp">➕ 新建编组</button>
          <button class="rw-subcat-btn" id="rw-open-faction-trade">${svgIcon('trade', 13)} 商队贸易窗</button>
          <button class="rw-subcat-btn" id="rw-open-zero-trade">${svgIcon('haul', 13)} 小队间物资调配</button>
          ${closeBtnHtml}
        </div>
      </div>
      <div class="rw-arch-grid">
        ${groups
          .map((g) => {
            const invTxt =
              Object.entries(g.inventory)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:2px">${svgIcon(k, 12)}${v}</span>`)
                .join(' ') || '空';
            return `
              <div class="rw-bio-card">
                <div>
                  <b>${svgIcon('groups', 14)} ${g.name}</b>
                  <span style="float:right;color:#8cd4ff">${g.currentWeightKg.toFixed(1)} / ${g.maxWeightKg.toFixed(1)} kg</span>
                </div>
                <div class="rw-insp-meta">小队成员 (${g.memberEids.length}人)：${g.memberEids.map((id) => sim.pawn(id)?.name ?? `#${id}`).join(', ') || '无'}</div>
                <div class="rw-insp-meta" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">携带物资：<b>${invTxt}</b></div>
                <div class="rw-gene-inject-row">
                  ${pawns
                    .slice(0, 6)
                    .map((p) => `<button class="rw-mini-btn ${p.groupId === g.id ? 'active' : ''}" data-assign-grp="${p.eid}:${g.id}">编入 ${p.name}</button>`)
                    .join('')}
                </div>
              </div>
            `;
          })
          .join('')}
        <div class="rw-bio-card">
          <b>${svgIcon('skull', 14)} 地面尸体与猎物 (${corpses.length} 具)</b>
          <div class="rw-gene-inject-row" style="margin-top:6px">
            ${
              corpses.length === 0
                ? '<span class="rw-insp-meta">当前无遗体</span>'
                : corpses
                    .map(
                      (c) =>
                        `<button class="rw-mini-btn" data-open-corpse="${c.eid}">${svgIcon('scavenge', 12)} 处理【${c.name}】</button>`,
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
    `;

    bindDrawerDragAndClose(el, ctx.closeDrawer);
    document.getElementById('rw-drawer-create-grp')?.addEventListener('click', () => {
      const inp = document.getElementById('rw-drawer-new-grp-inp') as HTMLInputElement | null;
      const res = createColonistGroup(sim, inp?.value);
      ctx.showToast(res.message);
      ctx.forceRefresh();
    });
    document.getElementById('rw-open-faction-trade')?.addEventListener('click', () => {
      openFactionTradeModal(sim, undefined, pawns[0]?.eid, ctx.showToast, ctx.forceRefresh);
    });
    document.getElementById('rw-open-zero-trade')?.addEventListener('click', () => {
      openZeroPriceGroupTradeModal(sim, 'group_alpha', 'group_beta', ctx.showToast, ctx.forceRefresh);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-assign-grp]').forEach((b) => {
      b.addEventListener('click', () => {
        const [eidStr, gid] = String(b.dataset.assignGrp).split(':');
        const res = assignPawnToGroup(sim, Number(eidStr), gid);
        ctx.showToast(res.message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-open-corpse]').forEach((b) => {
      b.addEventListener('click', () => {
        openCorpseLootModal(sim, Number(b.dataset.openCorpse), pawns[0]?.eid, ctx.showToast, ctx.forceRefresh);
      });
    });
    return;
  }

  if (activeTab === 'world_mmo') {
    const ruinDlcOn = isRuinScavengeDlcEnabled(sim);
    const ruinBuildings = ruinDlcOn ? getRuinScavengeableBuildings(sim) : [];
    const bases = [...getNpcBases(sim).values()];
    const actor = [...sim.pawns()].find((p) => !isStrangerPawn(p, sim.activePlayerId));

    const ruinSectionHtml = ruinDlcOn
      ? `
        <div class="rw-insp-subhead">${svgIcon('ancient_locker', 14)} 远古遗迹可搜刮设施 (${ruinBuildings.filter((b) => !b.scavenged).length}/${ruinBuildings.length})：</div>
        <div class="rw-arch-grid" style="margin-bottom:10px">
          ${ruinBuildings
            .map((b) => {
              const bName = b.customName ?? sim.tuning.buildings[b.defId]?.name ?? b.defId;
              const hasLoot = !b.scavenged && b.scavengeLoot && Object.keys(b.scavengeLoot).length > 0;
              const lootHtml = hasLoot
                ? Object.entries(b.scavengeLoot!)
                    .map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:2px">${svgIcon(k, 12)}${k}×${v}</span>`)
                    .join(' ')
                : '已搜空';
              return `
                <div class="rw-bio-card">
                  <div>
                    <b>${svgIcon(b.defId, 16)} ${bName}</b>
                    <span style="float:right;color:${hasLoot ? '#f5d451' : '#9fb0c2'}">${hasLoot ? '可搜刮' : '已搜空'}</span>
                  </div>
                  <div class="rw-insp-meta" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">位置 (${b.pos.x}, ${b.pos.y}) · 内含：<b>${lootHtml}</b></div>
                  <div class="rw-gene-inject-row">
                    <button class="rw-mini-btn" data-jump-pos="${b.pos.x},${b.pos.y}">📍 镜头定位</button>
                    <button class="rw-mini-btn" data-scav-bld="${b.id}" ${!hasLoot ? 'disabled' : ''}>${svgIcon('scavenge', 12)} 搜刮此建筑</button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      `
      : `
        <div class="rw-bio-card" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <b>🔒 远古遗迹搜刮扩展包 (Ruin Scavenging DLC) 当前已禁用</b>
            <div class="rw-insp-meta">搜刮逻辑已按要求独立拆分至 DLC 并默认禁用，确保主地图纯净。如需体验可随时开启。</div>
          </div>
          <button class="rw-mini-btn" id="rw-enable-ruin-dlc">启用遗迹搜刮 DLC</button>
        </div>
      `;

    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('trade', 16)} 周边派系据点外交 (${bases.length}) & 遗迹搜刮扩展状态</b>
        ${closeBtnHtml}
      </div>
      <div class="rw-insp-subhead">${svgIcon('trade', 14)} 周边派系据点外交与贸易：</div>
      <div class="rw-arch-grid" style="margin-bottom:10px">
        ${bases
          .map((b) => {
            const beh = getFactionBehaviorByRelation(b.reputation);
            return `
              <div class="rw-bio-card">
                <div>
                  <b>${b.name}</b>
                  <span style="float:right;color:${b.reputation >= 40 ? '#7ef09d' : b.reputation <= -25 ? '#ff6b6b' : '#f5d451'}">关系 ${b.reputation} [${beh.tierLabel}]</span>
                </div>
                <div class="rw-insp-meta">坐标 (${b.pos.x}, ${b.pos.y}) · 态度：<b>${beh.behaviorSummary}</b></div>
                <div class="rw-gene-inject-row">
                  <button class="rw-mini-btn" data-jump-pos="${b.pos.x},${b.pos.y}">📍 定位</button>
                  ${beh.canTrade ? `<button class="rw-mini-btn" data-b-trade="${b.id}">${svgIcon('trade', 12)} 贸易</button>` : ''}
                  ${beh.canRequestAid ? `<button class="rw-mini-btn" data-b-ally="${b.id}">🎺 援军</button>` : ''}
                  <button class="rw-mini-btn" data-b-gift="${b.id}">🎁 赠礼(+18)</button>
                  <button class="rw-mini-btn" data-b-steal="${b.id}" style="color:#ffd94a">🕵 盗窃(-25)</button>
                  <button class="rw-mini-btn" data-b-kidnap="${b.id}" style="color:#ff9c9c">⛓ 绑架(-45)</button>
                  <button class="rw-mini-btn" data-b-assault="${b.id}" style="color:#ff6b6b">⚔ 进攻</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
      ${ruinSectionHtml}
    `;

    bindDrawerDragAndClose(el, ctx.closeDrawer);
    document.getElementById('rw-enable-ruin-dlc')?.addEventListener('click', () => {
      const res = toggleSimDlc(sim, 'dlc-ruin-scavenge', true);
      getRuinSites(sim);
      ctx.showToast(res.message);
      ctx.forceRefresh();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-jump-pos]').forEach((b) => {
      b.addEventListener('click', () => {
        const [x, y] = String(b.dataset.jumpPos).split(',').map(Number);
        ctx.centerCameraOn(x, y);
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-scav-bld]').forEach((b) => {
      b.addEventListener('click', () => {
        const res = orderScavengeRuinBuilding(sim, String(b.dataset.scavBld), actor?.eid ?? 1);
        ctx.showToast(res.message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-trade]').forEach((b) => {
      b.addEventListener('click', () => {
        openFactionTradeModal(sim, String(b.dataset.bTrade), actor?.eid, ctx.showToast, ctx.forceRefresh);
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-ally]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.showToast(requestAllyReinforcements(sim, String(b.dataset.bAlly)).message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-gift]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.showToast(giftNpcBase(sim, String(b.dataset.bGift), 'wood', 10).message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-steal]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.showToast(stealFromFaction(sim, String(b.dataset.bSteal), actor?.eid ?? 1).message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-kidnap]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.showToast(kidnapFromFaction(sim, String(b.dataset.bKidnap), actor?.eid ?? 1).message);
        ctx.forceRefresh();
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-b-assault]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.showToast(assaultNpcBase(sim, String(b.dataset.bAssault)).message);
        ctx.forceRefresh();
      });
    });
    return;
  }

  if (activeTab === 'dlc') {
    const activeDlcs = getActiveSimDlcs(sim);
    const aiEnabled = isAiModeDlcEnabled(sim);
    const ruinEnabled = isRuinScavengeDlcEnabled(sim);
    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('dlc', 16)} 扩展包与存档管理 (遗迹搜刮DLC：${ruinEnabled ? '开启' : '已禁用'} · AI建房DLC：${aiEnabled ? '开启' : '已禁用'})</b>
        <div class="rw-subcat-bar">
          <button class="rw-subcat-btn" id="rw-spawn-100-pawns">🚀 100人同屏压测</button>
          <button class="rw-subcat-btn" id="rw-bench-100-pawns">⏱ 帧率压测</button>
          <button class="rw-subcat-btn" id="rw-zoom-max-fog">🔍 全景视野(R=${MAX_ZOOM_FOG_RADIUS})</button>
          <button class="rw-subcat-btn" id="rw-menu-save">💾 保存存档</button>
          <button class="rw-subcat-btn" id="rw-menu-load">⤴️ 读取存档</button>
          <button class="rw-subcat-btn" id="rw-menu-new">🎲 生成新地图</button>
          ${closeBtnHtml}
        </div>
      </div>
      <div class="rw-arch-grid">
        ${DLC_CATALOG.map((item) => {
          const on = activeDlcs.has(item.id);
          return `
            <div class="rw-bio-card" style="border-left:4px solid ${item.badgeColor}">
              <div>
                <b>${item.title}</b>
                <span style="float:right;color:${on ? '#7ec97e' : '#f5d451'}">${on ? '● 已启用' : '○ 默认禁用'}</span>
              </div>
              <div class="rw-insp-meta">${item.subtitle}</div>
              <div class="rw-insp-meta" style="color:#cfd8e3">${item.description}</div>
              <div class="rw-gene-inject-row">
                <button class="rw-mini-btn" data-toggle-dlc="${item.id}">${on ? '停用此 DLC' : '启用此 DLC'}</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="rw-mod-loader-box">
        <span>挂载 <code>.mod.json</code>：</span>
        <input id="rw-custom-mod-input" type="text" value='{"id":"mod-ratkin-feast","buildings":[{"id":"cheese_vat","name":"奶酪发酵桶","cost":{"wood":6},"hp":90,"w":2,"h":1,"tags":["storage"],"passable":false}]}' />
        <button class="rw-mini-btn" id="rw-btn-load-mod">加载 Mod</button>
      </div>
    `;
    bindDrawerDragAndClose(el, ctx.closeDrawer);
    document.getElementById('rw-menu-save')?.addEventListener('click', ctx.onSave);
    document.getElementById('rw-menu-load')?.addEventListener('click', ctx.onLoad);
    document.getElementById('rw-menu-new')?.addEventListener('click', ctx.onNewWorld);
    document.getElementById('rw-spawn-100-pawns')?.addEventListener('click', () => {
      const total = spawnHundredPawnColony(sim, 100);
      ctx.showToast(`已扩展至 ${total} 名殖民者同屏`);
      ctx.forceRefresh();
    });
    document.getElementById('rw-bench-100-pawns')?.addEventListener('click', () => {
      const res = benchmarkHundredPawnsSim(sim, 20);
      ctx.showToast(`压测完成：${res.pawnCount}人 ${res.ticks}帧，均值 ${res.avgMsPerTick.toFixed(2)} ms/帧`);
      ctx.forceRefresh();
    });
    document.getElementById('rw-zoom-max-fog')?.addEventListener('click', () => {
      ctx.setZoomTilePx?.(MIN_ZOOM_TILE_PX);
      ctx.showToast(`已缩放至全景视野 TILE=${MIN_ZOOM_TILE_PX}px`);
      ctx.forceRefresh();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-toggle-dlc]').forEach((b) => {
      b.addEventListener('click', () => {
        const dlcId = String(b.dataset.toggleDlc);
        const res = toggleSimDlc(sim, dlcId);
        if (dlcId === 'dlc-ruin-scavenge' && res.enabled) {
          getRuinSites(sim);
        }
        ctx.showToast(res.message);
        ctx.forceRefresh();
      });
    });
    document.getElementById('rw-btn-load-mod')?.addEventListener('click', () => {
      const inp = document.getElementById('rw-custom-mod-input') as HTMLInputElement | null;
      if (!inp) return;
      ctx.showToast(loadCustomModJsonOnSim(sim, inp.value).message);
      ctx.forceRefresh();
    });
    return;
  }

  if (activeTab === 'help') {
    el.innerHTML = `
      <div class="rw-drawer-head">
        <b>${svgIcon('help', 16)} RimWorld 操作百科指南</b>
        ${closeBtnHtml}
      </div>
      <div class="rw-arch-grid">
        <div class="rw-bio-card">
          <b>${svgIcon('wall', 15)} 1. 山体与墙体无缝拼接 & 1×1 乔木</b>
          <div class="rw-insp-desc">
            • 天然山体与墙体一样四向无缝融合，仅在外露南侧显现 3D 岩壁立面。<br/>
            • 乔木物理占地为 <b>1×1</b>（不再阻挡 2×2 四格），同时保留丰满的大树冠贴图。<br/>
            • 墙体与房门围合且单边 ≤${MAX_ROOM_SIDE}×${MAX_ROOM_SIDE} 时自动生成室内屋顶。
          </div>
        </div>
        <div class="rw-bio-card">
          <b>${svgIcon('medical', 15)} 2. 健康身体部位与电网检视</b>
          <div class="rw-insp-desc">
            • 选中任意殖民者后，在左下角检视窗点击<b>【健康(部位)】</b>即可查看全身部位伤情、包扎、截肢与义体移植。<br/>
            • 点击左下角检视窗顶部的<b>【⚡ 电网负荷】</b>即可一键高亮全图电网并在检视窗内查看电网节点详情。
          </div>
        </div>
        <div class="rw-bio-card">
          <b>${svgIcon('pawn_ratkin', 15)} 3. 精神崩溃离队求生与顶栏新建编组</b>
          <div class="rw-insp-desc">
            • 殖民者心情极度低落（或点击心情面板的【🧠 模拟崩溃离队】）会脱离派系，在地图周围由 AI 自主管理采果求生，右键可重新招募。<br/>
            • 殖民者顶栏支持点击<b>【➕ 新建组】</b>自由创建自定义编组。
          </div>
        </div>
      </div>
    `;
    bindDrawerDragAndClose(el, ctx.closeDrawer);
  }
}
