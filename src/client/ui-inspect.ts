/**
 * client/ui-inspect.ts —— RimWorld 原版左下角检视面板（内置 i18n 双语支持）：
 *  1. 身体部位 (Body Parts) 完整内置于小人检视面板的「健康」页签内；
 *  2. 装备与武器 (Gear / Equipment / Apparel / Inventory) 对齐 RimWorld `ITab_Pawn_Gear` 原版截图；
 *  3. 电网无需独立底栏界面：直接点击检视窗顶部的「⚡ 电网负荷」徽章即可高亮全图电网并查看功率明细；
 *  4. 选中任何封闭房间，均可直接在检视窗页签中切换【内设家具 / 室内装饰 / 室内工作台】布置。
 */
import {
  ARCHITECT_BUILDABLES,
  MAX_POWER_GRID_NODES,
  MAX_POWER_GRID_SPAN,
  type RoomInspection,
  type RoomLayoutSubTab,
  Sim,
  TRIAD_CATALOG,
  constructBlueprint,
  consumeCulinaryDish,
  ensurePawnAnatomy,
  ensurePawnTriads,
  evaluatePowerGrids,
  executeArchitectOrder,
  getActiveCulinaryBuff,
  getBuildingPowerGrid,
  getColonistGroups,
  getDeadPawns,
  getOutdoorItems,
  hasSlopeAt,
  haulAndButcherCorpse,
  inspectFootprintCells,
  inspectRoomAt,
  isRuinScavengeDlcEnabled,
  isStrangerPawn,
  isTileVisibleToPlayer,
  mineralAt,
  orderScavengeRuinBuilding,
  performPawnTriadAction,
  placeArchitectBlueprint,
  placeArchitectBuilding,
  recruitWildFormerColonist,
  terrainMetaAt,
  triggerColonistMentalBreak,
} from '../sim';
import { getUiLocale, localizeHtml, t, tr } from './i18n';
import { svgIcon } from './ui-icons';
import { getPawnHudSignature, renderRimWorldGearTab, renderRimWorldHealthTab } from './ui-inspect-gear-health';
import { openCorpseLootModal, openFactionTradeModal } from './ui-modals';
import { computePawnMoodThoughts, cycleFieldCropChoice, executeBuildingBillNow, getFieldCropChoice, getWorkbenchBills, harvestFieldCropNow } from './ui-schedule-bills';

export type InspectTabId = 'bio' | 'needs' | 'triad' | 'health' | 'gear';
let showAllAnatomyParts = false;
let powerInspectPinned = false;
let activeRoomSubTab: RoomLayoutSubTab = 'furnish';
let roomInspectPinned = false;

export function pinRoomFurnishingPanel(subTab?: RoomLayoutSubTab): void {
  powerInspectPinned = false;
  roomInspectPinned = true;
  if (subTab) activeRoomSubTab = subTab;
}

function resolveRoomAtOrAdjacentWall(sim: Sim, gx: number, gy: number): RoomInspection {
  const direct = inspectRoomAt(sim.world, gx, gy);
  if (direct.indoors && direct.roofed) return direct;
  const bld = sim.world.buildingAt(gx, gy);
  if (bld && (bld.defId === 'wall' || bld.defId === 'door')) {
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const adj = inspectRoomAt(sim.world, gx + dx, gy + dy);
      if (adj.indoors && adj.roofed) return adj;
    }
  }
  return direct;
}

export function renderInspectPaneContent(
  sim: Sim,
  selectedEids: number[],
  selectedBuildingId: string | null,
  inspectTab: InspectTabId,
  setInspectTab: (t: InspectTabId) => void,
  lastClickedGround: { x: number; y: number },
  lastInspectKey: string,
  setLastInspectKey: (k: string) => void,
  onToast: (m: string) => void,
  onRefresh: () => void,
  onTogglePowerOverlay?: () => boolean,
  isPowerOverlayActive?: boolean,
  onSelectRoomBuildDesignator?: (defId: string, name: string) => void,
): void {
  const floorEl = document.getElementById('rw-floor-pane');
  const tabsEl = document.getElementById('rw-inspect-tabs');
  const paneEl = document.getElementById('rw-inspect-pane');
  const wrapEl = document.getElementById('rw-inspect-wrap');
  if (!tabsEl || !paneEl) return;

  const firstPawn = selectedEids.length > 0 ? sim.pawn(selectedEids[0]) : undefined;
  const selBld = selectedBuildingId ? sim.world.buildings.get(selectedBuildingId) : undefined;
  const gx = firstPawn
    ? Math.round(firstPawn.pos.x)
    : selBld
      ? Math.round(selBld.pos.x)
      : lastClickedGround.x;
  const gy = firstPawn
    ? Math.round(firstPawn.pos.y)
    : selBld
      ? Math.round(selBld.pos.y)
      : lastClickedGround.y;

  const tMeta = terrainMetaAt(sim.world, gx, gy);
  const room = resolveRoomAtOrAdjacentWall(sim, gx, gy);
  const slope = hasSlopeAt(sim.world, gx, gy);
  const bldAtCell = selBld ?? sim.world.buildingAt(gx, gy);
  const corpseAtCell = getDeadPawns(sim).find((c) => Math.hypot(c.pos.x - gx, c.pos.y - gy) <= 1.2);
  const cropId = bldAtCell?.defId === 'field' ? getFieldCropChoice(bldAtCell.id).id : '';
  const allGrids = evaluatePowerGrids(sim.world);
  const totalGridNodes = allGrids.reduce((acc, gr) => acc + gr.nodeCount, 0);
  const anyOverload = allGrids.some((gr) => gr.overloadRefused);

  const anatomySig =
    firstPawn && (inspectTab === 'health' || inspectTab === 'gear')
      ? Object.values(firstPawn.anatomy ?? {})
          .map((pt) => `${pt.partId}:${pt.hp}:${pt.status}`)
          .join(',') +
        '|' +
        getPawnHudSignature(firstPawn, showAllAnatomyParts)
      : '';

  const key = [
    getUiLocale(),
    firstPawn
      ? `p:${firstPawn.eid}:${inspectTab}:${Math.round(firstPawn.hp)}:${Math.round(firstPawn.needs.mood)}:${Math.round(firstPawn.needs.food)}:${firstPawn.groupId ?? ''}:${firstPawn.drafted ? 1 : 0}:${firstPawn.formerColonist ? 1 : 0}:${anatomySig}`
      : 'nop',
    `g:${gx},${gy}:${tMeta.id}:${tMeta.z}:${slope ? 1 : 0}:${room.label}:${room.tileCount}`,
    `pwr:${allGrids.length}:${totalGridNodes}:${anyOverload ? 1 : 0}:${isPowerOverlayActive ? 1 : 0}:${powerInspectPinned ? 1 : 0}:${activeRoomSubTab}:${roomInspectPinned ? 1 : 0}:${firstPawn?.culinaryBuff?.dishId ?? ''}`,
    bldAtCell
      ? `b:${bldAtCell.id}:${Math.round(bldAtCell.hp)}:${bldAtCell.isBlueprint ? 1 : 0}:${Math.round(bldAtCell.workProgress ?? 0)}:${bldAtCell.scavenged ? 1 : 0}:${cropId}`
      : 'nob',
    corpseAtCell ? `c:${corpseAtCell.eid}:${Math.round(corpseAtCell.pos.x)},${Math.round(corpseAtCell.pos.y)}` : 'noc',
  ].join('|');

  if (key === lastInspectKey) return;
  setLastInspectKey(key);

  const vis = isTileVisibleToPlayer(sim, sim.activePlayerId, gx, gy);
  const itemAtCell = getOutdoorItems(sim).find((it) => Math.round(it.pos.x) === gx && Math.round(it.pos.y) === gy);
  const minAtCell = mineralAt(sim.world, gx, gy);
  const featAtCell = sim.world.featureAt(gx, gy);
  const pwrSummaryTxt =
    allGrids.length === 0
      ? t('未建电网', 'No Grid')
      : anyOverload
        ? t(`${allGrids.length}网 · 过载告警`, `${allGrids.length} Grids · Overload!`)
        : t(`${allGrids.length}网/${totalGridNodes}节点 正常`, `${allGrids.length} Grids / ${totalGridNodes} Nodes OK`);

  if (floorEl) {
    floorEl.innerHTML = localizeHtml(`
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #38424d;padding-bottom:3px;margin-bottom:4px">
        <b style="color:#d8ccb8;font-size:12px;display:flex;align-items:center;gap:5px">${svgIcon('fertility', 13)} ${t('地形：', 'Terrain: ')}${tr(tMeta.shortName)} (${gx}, ${gy})</b>
        <button class="rw-collapse-mini ${isPowerOverlayActive || powerInspectPinned ? 'active' : ''}" id="rw-floor-pwr-btn" title="${t('点击高亮全图电网并在检视窗查看电网负荷详情', 'Click to highlight power grids and inspect load')}" style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px">
          ${svgIcon('power', 12)} ${t('电网负荷：', 'Grid: ')}${pwrSummaryTxt}
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px 6px;font-size:11px;color:#cfd8e3;align-items:center">
        <div>${t('移速', 'Move')} <b>${Math.round(tMeta.moveSpeedMul * 100)}%</b></div>
        <div>${t('肥力', 'Fert.')} <b>${Math.round(tMeta.fertility * 100)}%</b></div>
        <div>${tr(room.label)} <b>z=${tMeta.z}${slope ? t('(坡)', '(Ramp)') : ''}</b></div>
        <div>${room.indoors && room.roofed ? `<button class="rw-collapse-mini ${roomInspectPinned ? 'active' : ''}" id="rw-floor-room-btn" style="background:#2b4736;border-color:#7ef09d;color:#fff;padding:1px 5px">🏠 ${t('布置房间', 'Furnish')}</button>` : `${t('视野', 'Vis')} <b>${vis ? t('可见', 'Clear') : t('迷雾', 'Fog')}</b>`}</div>
      </div>
    `);
    document.getElementById('rw-floor-room-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      powerInspectPinned = false;
      roomInspectPinned = !roomInspectPinned;
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-floor-pwr-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const activeNow = onTogglePowerOverlay ? onTogglePowerOverlay() : false;
      powerInspectPinned = activeNow || !powerInspectPinned;
      setLastInspectKey('');
      onRefresh();
    });
  }

  wrapEl?.classList.remove('rw-inspect-wide-hud');

  if (powerInspectPinned) {
    tabsEl.innerHTML = '';
    paneEl.classList.remove('rw-inspect-health-expanded');
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;justify-content:space-between;align-items:center">
        <span style="display:flex;align-items:center;gap:6px;color:#64dfdf">${svgIcon('power', 16)} ${t(`殖民地电网负荷检视 (${allGrids.length} 个独立电网)`, `Colony Power Grids (${allGrids.length} Grids)`)}</span>
        <button class="rw-mini-btn" id="rw-close-pwr-insp">${t('返回常规检视', 'Back')}</button>
      </div>
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px;font-size:11.5px">
        ${
          allGrids.length === 0
            ? `<div class="rw-insp-meta">${t('当前尚未建立电网。点击下方按钮可一键部署示范发电机+电缆+探照灯塔，或在【建筑规划 → 外部设施】中铺设。', 'No power grids built yet. Click below to deploy a demo generator & beacon tower.')}</div>`
            : allGrids
                .map(
                  (gr) =>
                    `<div style="padding:4px 7px;background:rgba(16,22,28,0.85);border-left:3px solid ${gr.overloadRefused ? '#ff6b6b' : '#64dfdf'};display:flex;justify-content:space-between;align-items:center">
                      <span><b>${t(`电网 #${gr.gridId}`, `Grid #${gr.gridId}`)}</b> · ${t('节点', 'Nodes')} <b>${gr.nodeCount}/${MAX_POWER_GRID_NODES}</b> · ${t('跨度', 'Span')} <b>${gr.maxSpan}/${MAX_POWER_GRID_SPAN}</b></span>
                      <b style="color:${gr.overloadRefused ? '#ff6b6b' : '#7ef09d'}">${tr(gr.statusText)}</b>
                    </div>`,
                )
                .join('')
        }
      </div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="rw-mini-btn" id="rw-insp-demo-grid">${svgIcon('wood_generator', 12)} ${t('部署发电机+探照灯塔', 'Deploy Generator + Beacon Tower')}</button>
      </div>
    `);
    document.getElementById('rw-close-pwr-insp')?.addEventListener('click', () => {
      powerInspectPinned = false;
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-insp-demo-grid')?.addEventListener('click', () => {
      sim.stockpile['wood'] = (sim.stockpile['wood'] ?? 0) + 30;
      sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 30;
      placeArchitectBuilding(sim, 'wood_generator', 4, -4, 0, sim.activePlayerId);
      placeArchitectBuilding(sim, 'electric_beacon_tower', 6, -4, 0, sim.activePlayerId);
      onToast(t('⚡ 已部署燃木发电机与电弧探照灯塔，电网已高亮显示', '⚡ Deployed Wood Generator & Electric Beacon Tower'));
      setLastInspectKey('');
      onRefresh();
    });
    return;
  }

  const renderRoomTabsHeader = (includeBldDetailTab: boolean, isBldDetailActive: boolean) => {
    const bldTabHtml = includeBldDetailTab
      ? `<button class="rw-insp-tab ${isBldDetailActive ? 'active' : ''}" id="rw-rm-tab-bld" style="display:flex;align-items:center;gap:4px">${svgIcon(bldAtCell?.defId ?? 'wall', 13)} ${t('建筑详情', 'Building')}</button>`
      : '';
    const rmTabsHtml = [
      { id: 'furnish', icon: 'bed', label: t('内设家具', 'Furniture') },
      { id: 'decor', icon: 'plant_pot', label: t('室内装饰', 'Decor') },
      { id: 'workbench', icon: 'stove', label: t('室内工作台', 'Workbenches') },
    ]
      .map(
        (tb) =>
          `<button class="rw-insp-tab ${!isBldDetailActive && activeRoomSubTab === tb.id ? 'active' : ''}" data-rmtab="${tb.id}" style="display:flex;align-items:center;gap:4px">${svgIcon(tb.icon, 13)} ${tb.label}</button>`,
      )
      .join('');
    tabsEl.innerHTML = bldTabHtml + rmTabsHtml;
    document.getElementById('rw-rm-tab-bld')?.addEventListener('click', () => {
      roomInspectPinned = false;
      setLastInspectKey('');
      onRefresh();
    });
    tabsEl.querySelectorAll<HTMLButtonElement>('.rw-insp-tab[data-rmtab]').forEach((b) => {
      b.onclick = () => {
        activeRoomSubTab = b.dataset.rmtab as RoomLayoutSubTab;
        if (includeBldDetailTab) roomInspectPinned = true;
        setLastInspectKey('');
        onRefresh();
      };
    });
  };

  const renderSelectedRoomFurnishingPanel = () => {
    renderRoomTabsHeader(Boolean(bldAtCell && !firstPawn), false);
    const roomCellSet = new Set(room.cells.map((c) => `${c.x},${c.y}`));
    const interiorBlds = [...sim.world.buildings.values()].filter((b) =>
      roomCellSet.has(`${Math.round(b.pos.x)},${Math.round(b.pos.y)}`),
    );
    const beautyScore = interiorBlds.reduce((acc, b) => {
      if (b.defId === 'art_sculpture') return acc + 45;
      if (b.defId === 'royal_carpet') return acc + 28;
      if (b.defId === 'plant_pot') return acc + 15;
      if (b.defId === 'standing_lamp') return acc + 10;
      return acc + 4;
    }, 10);
    const items = ARCHITECT_BUILDABLES.filter((b) => b.interiorOnly && b.roomSubTab === activeRoomSubTab);
    paneEl.classList.add('rw-inspect-health-expanded');
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;justify-content:space-between;align-items:center">
        <span style="display:flex;align-items:center;gap:6px;color:#7ef09d">
          ${svgIcon('roof', 16)} ${t(`已选中封闭房间 (${room.width}×${room.height} · ${room.tileCount}格 · 美观 +${beautyScore})`, `Enclosed Room (${room.width}×${room.height} · ${room.tileCount} tiles · Beauty +${beautyScore})`)}
        </span>
        <div style="display:flex;gap:4px">
          ${roomInspectPinned ? `<button class="rw-collapse-mini" id="rw-close-rm-pin">${t('返回检视', 'Back')}</button>` : ''}
        </div>
      </div>
      <div class="rw-insp-meta" style="color:#cfd8e3;margin-bottom:4px">
        ${t(`室内已有设施 (${interiorBlds.length})：点击下方卡片可<b>选点布置</b>或<b>⚡ 一键布置在当前房间内</b>。`, `Indoor items (${interiorBlds.length}): Click below to place manually or auto-furnish inside this enclosed room.`)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;max-height:175px;overflow-y:auto;padding-right:2px">
        ${items
          .map((it) => {
            const costTxt = Object.entries(it.cost)
              .map(([k, v]) => `${svgIcon(k, 11)}${v}`)
              .join(' ');
            const itemTitle = tr(it.name);
            const cleanDesc = tr(
              it.desc
                .replace('【室内内设 · 选中房间布置】', '')
                .replace('【室内装饰 · 选中房间布置】', '')
                .replace('【室内工作台 · 选中房间布置】', ''),
            );
            return `
              <div style="background:rgba(18,24,30,0.92);border:1px solid #3c4856;border-radius:4px;padding:5px 7px;display:flex;flex-direction:column;justify-content:space-between;gap:4px">
                <div>
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px">
                    <b style="color:#f5d451;display:inline-flex;align-items:center;gap:4px">${svgIcon(it.icon, 14)} ${itemTitle}</b>
                    <span style="font-size:10.5px;color:#8cd4ff">${it.w}×${it.h} · ${costTxt}</span>
                  </div>
                  <div style="font-size:10px;color:#9fb0c2;line-height:1.25;margin-top:2px">${cleanDesc}</div>
                </div>
                <div style="display:flex;gap:4px">
                  <button class="rw-mini-btn" data-rm-pick="${it.defId}" data-rm-name="${it.name}" style="flex:1;padding:2px 4px;font-size:10.5px">🎯 ${t('选点放置', 'Place')}</button>
                  <button class="rw-mini-btn" data-rm-auto="${it.defId}" data-rm-name="${it.name}" style="flex:1;padding:2px 4px;font-size:10.5px;background:#2b4736;border-color:#7ef09d;color:#fff">⚡ ${t('布置入室', 'Auto-Place')}</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `);
    document.getElementById('rw-close-rm-pin')?.addEventListener('click', () => {
      roomInspectPinned = false;
      setLastInspectKey('');
      onRefresh();
    });
    paneEl.querySelectorAll<HTMLButtonElement>('[data-rm-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const defId = String(btn.dataset.rmPick);
        const name = String(btn.dataset.rmName);
        if (onSelectRoomBuildDesignator) {
          onSelectRoomBuildDesignator(defId, name);
        } else {
          const targetCell = room.cells[0] ?? { x: gx, y: gy };
          const res = placeArchitectBlueprint(sim, defId, targetCell.x, targetCell.y, 0, sim.activePlayerId, { requireIndoorRoom: true });
          onToast(res.message);
        }
        setLastInspectKey('');
        onRefresh();
      });
    });
    paneEl.querySelectorAll<HTMLButtonElement>('[data-rm-auto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const defId = String(btn.dataset.rmAuto);
        const name = String(btn.dataset.rmName);
        let placed = false;
        let lastMsg = t('房间内空间不足或缺少建材', 'Insufficient room space or materials');
        for (const cell of room.cells) {
          const check = inspectFootprintCells(sim, defId, cell.x, cell.y, 0, { requireIndoorRoom: true });
          const allInThisRoom = check.cells.every((fc) => roomCellSet.has(`${fc.x},${fc.y}`));
          if (check.valid && allInThisRoom) {
            const res = placeArchitectBuilding(sim, defId, cell.x, cell.y, 0, sim.activePlayerId);
            lastMsg = res.message;
            if (res.ok) {
              placed = true;
              break;
            }
          } else if (check.reason) {
            lastMsg = check.reason;
          }
        }
        onToast(
          placed
            ? t(`🏠 已在房间 (${room.width}×${room.height}) 内成功布置【${tr(name)}】！`, `🏠 Furnished [${tr(name)}] inside room (${room.width}×${room.height})!`)
            : t(`⚠ 无法布置【${tr(name)}】：${lastMsg}`, `⚠ Cannot furnish [${tr(name)}]: ${lastMsg}`),
        );
        setLastInspectKey('');
        onRefresh();
      });
    });
  };

  if (roomInspectPinned && room.indoors && room.roofed) {
    renderSelectedRoomFurnishingPanel();
    return;
  }

  if (firstPawn) {
    if (isStrangerPawn(firstPawn, sim.activePlayerId)) {
      tabsEl.innerHTML = '';
      paneEl.classList.remove('rw-inspect-health-expanded');
      const traitName = tr(sim.tuning.traits[firstPawn.trait]?.name ?? firstPawn.trait);
      if (firstPawn.formerColonist || firstPawn.mentalBreakState === 'wild_man') {
        const aiJobLabel =
          firstPawn.cardId === 'gather_berry'
            ? t('采摘野果充饥 (AI自管)', 'Foraging Berries (AI)')
            : firstPawn.cardId === 'eat'
              ? t('进食求生 (AI自管)', 'Eating (AI)')
              : firstPawn.cardId === 'sleep'
                ? t('席地露宿 (AI自管)', 'Sleeping Outdoors (AI)')
                : t('在荒野游荡求生 (AI自管)', 'Wandering Wild (AI)');
        paneEl.innerHTML = localizeHtml(`
          <div class="rw-insp-title" style="display:flex;align-items:center;justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${svgIcon('pawn_ratkin', 18)} ${firstPawn.name} <span style="font-size:11px;color:#ff9f43">[${t('精神崩溃 · 荒野求生', 'Mental Break · Wild')}]</span></span>
            <span style="font-size:11px;color:#7ef09d">${aiJobLabel}</span>
          </div>
          <div class="rw-insp-meta">${t('特质：', 'Trait: ')}<b style="color:#7ef09d">${traitName}</b> · ${t('生命：', 'HP: ')}<b>${Math.round(firstPawn.hp)}/${firstPawn.maxHp}</b> · ${t('饮食：', 'Food: ')}<b>${Math.round(firstPawn.needs.food)}%</b></div>
          <div class="rw-insp-meta">${t('状态说明：该小人因精神崩溃离开了殖民地派系，目前由 AI 自主管理生存。', 'This former colonist suffered a mental break and is surviving autonomously in the wild.')}</div>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="rw-mini-btn" id="rw-insp-recruit-wild" style="background:#2b4736;border-color:#7ef09d;color:#fff">🤝 ${t('安抚并重新招募回殖民地', 'Calm & Re-Recruit to Colony')}</button>
          </div>
        `);
        document.getElementById('rw-insp-recruit-wild')?.addEventListener('click', () => {
          const res = recruitWildFormerColonist(sim, firstPawn.eid);
          onToast(res.message);
          setLastInspectKey('');
          onRefresh();
        });
        return;
      }
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon('pawn_ratkin', 18)} ${firstPawn.name} <span style="font-size:11px;color:#f5d451">[${t('过境访客', 'Passing Visitor')}]</span></div>
        <div class="rw-insp-meta">${t('性格特质：', 'Trait: ')}<b style="color:#7ef09d">${traitName}</b> · ${t('坐标：', 'Pos: ')}(${Math.round(firstPawn.pos.x)}, ${Math.round(firstPawn.pos.y)})</div>
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="rw-mini-btn" id="rw-insp-stranger-trade">${svgIcon('trade', 13)} ${t('与访客进行商队贸易', 'Trade with Visitor')}</button>
        </div>
      `);
      document.getElementById('rw-insp-stranger-trade')?.addEventListener('click', () => {
        openFactionTradeModal(sim, 'stranger_caravan', undefined, onToast, onRefresh);
      });
      return;
    }

    const triads = ensurePawnTriads(firstPawn, sim.world.seed);
    ensurePawnAnatomy(firstPawn);
    const groupsMap = getColonistGroups(sim);
    const grpObj = groupsMap.get(firstPawn.groupId ?? 'group_alpha');
    const grpLabel = tr(grpObj ? grpObj.name.split(' ')[0] : '主力组');

    tabsEl.innerHTML = [
      { id: 'bio', icon: 'pawn_ratkin', label: t('概览', 'Bio') },
      { id: 'health', icon: 'medical', label: t('健康', 'Health') },
      { id: 'gear', icon: 'weapon_rifle', label: t('装备/武器', 'Gear') },
      { id: 'needs', icon: 'meal', label: t('心情', 'Needs') },
      { id: 'triad', icon: 'work', label: t('技能', 'Skills') },
    ]
      .map(
        (tb) =>
          `<button class="rw-insp-tab ${inspectTab === tb.id ? 'active' : ''}" data-itab="${tb.id}" style="display:flex;align-items:center;gap:4px">${svgIcon(tb.icon, 13)} ${tb.label}</button>`,
      )
      .join('');
    tabsEl.querySelectorAll<HTMLButtonElement>('.rw-insp-tab').forEach((b) => {
      b.onclick = () => {
        powerInspectPinned = false;
        roomInspectPinned = false;
        setInspectTab(b.dataset.itab as InspectTabId);
      };
    });

    const isWideHud = inspectTab === 'health' || inspectTab === 'gear';
    paneEl.classList.toggle('rw-inspect-health-expanded', isWideHud);
    wrapEl?.classList.toggle('rw-inspect-wide-hud', isWideHud);

    if (inspectTab === 'bio') {
      const hpPct = Math.round((firstPawn.hp / Math.max(1, firstPawn.maxHp)) * 100);
      const moodPct = Math.round(firstPawn.needs.mood);
      const foodPct = Math.round(firstPawn.needs.food);
      const restPct = Math.round(firstPawn.needs.rest);
      const barRow = (icon: string, lbl: string, pct: number, col: string) => `
        <div class="rw-skill-bar-row">
          <span class="rw-sk-name" style="width:74px;display:flex;align-items:center;gap:4px">${svgIcon(icon, 13)} ${lbl}</span>
          <div class="rw-sk-track"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${col}"></i></div>
          <b class="rw-sk-lv">${pct}%</b>
        </div>
      `;
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title" style="display:flex;align-items:center;justify-content:space-between">
          <span style="display:flex;align-items:center;gap:6px">${svgIcon('pawn_ratkin', 18)} ${firstPawn.name} <small style="color:#8cd4ff;font-size:11px">[${grpLabel}]</small></span>
          <span style="font-size:11.5px;color:${firstPawn.drafted ? '#ff6b6b' : '#7ef09d'}">${firstPawn.drafted ? t('⚔ 征召待命', '⚔ Drafted') : tr(firstPawn.activeWork?.label ?? t('自由活动', 'Free Roam'))}</span>
        </div>
        <div style="margin-top:4px">
          ${barRow('medical', t('生命', 'Health'), hpPct, '#5cb85c')}
          ${barRow('gold', t('心情', 'Mood'), moodPct, '#4ea8de')}
          ${barRow('meal', t('饮食', 'Food'), foodPct, '#e6a145')}
          ${barRow('bed', t('睡眠', 'Rest'), restPct, '#8a6fc9')}
        </div>
        ${(() => {
          const cb = getActiveCulinaryBuff(firstPawn, sim.time);
          return `<div style="margin-top:5px;padding-top:4px;border-top:1px dashed #38424d;display:flex;justify-content:space-between;align-items:center;font-size:11px">
            <span>${cb ? `${cb.dishIcon} ${t('料理增益：', 'Culinary Buff: ')}<b style="color:#7ef09d">${tr(cb.dishName)} (${cb.summary})</b>` : `🍽 ${t('尚未品尝特色料理', 'No active culinary buff')}`}</span>
            <button class="rw-mini-btn" id="rw-insp-eat-dish" style="padding:1px 6px;font-size:10.5px;background:#4a3520;border-color:#f5d451;color:#fff">🍛 ${t('品尝佳肴', 'Eat Dish')}</button>
          </div>`;
        })()}
      `);
      document.getElementById('rw-insp-eat-dish')?.addEventListener('click', () => {
        const res = consumeCulinaryDish(sim, firstPawn.eid);
        onToast(res.message);
        setLastInspectKey('');
        onRefresh();
      });
      return;
    }

    if (inspectTab === 'needs') {
      const thoughts = computePawnMoodThoughts(sim, firstPawn);
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>${svgIcon('gold', 15)} ${firstPawn.name} · ${t(`心情 (${Math.round(firstPawn.needs.mood)}% · 崩溃阈值 10%)`, `Mood (${Math.round(firstPawn.needs.mood)}% · Break Threshold 10%)`)}</span>
          <button class="rw-mini-btn" id="rw-insp-force-break" style="border-color:#ff9f43;color:#ffcb77" title="${t('模拟精神崩溃：脱离派系在荒野求生', 'Simulate mental break')}">🧠 ${t('模拟崩溃离队', 'Test Mental Break')}</button>
        </div>
        <div style="font-size:11.5px;display:flex;flex-direction:column;gap:3px;margin-top:5px">
          ${thoughts
            .map(
              (th) =>
                `<div style="display:flex;justify-content:space-between;border-bottom:1px dashed #2e3640;padding-bottom:2px">
                  <span>${tr(th.label)}</span>
                  <b style="color:${th.delta >= 0 ? '#7ef09d' : '#ff7675'}">${th.delta >= 0 ? `+${th.delta}` : th.delta}</b>
                </div>`,
            )
            .join('')}
        </div>
      `);
      document.getElementById('rw-insp-force-break')?.addEventListener('click', () => {
        const res = triggerColonistMentalBreak(sim, firstPawn.eid, t('极端精神压力崩溃', 'Extreme mental stress'));
        onToast(res.message);
        setLastInspectKey('');
        onRefresh();
      });
      return;
    }

    if (inspectTab === 'triad') {
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title">${svgIcon('work', 15)} ${firstPawn.name} · ${t('擅长技能与热情', 'Skills & Passions')}</div>
        ${triads
          .map((trd) => {
            const def = TRIAD_CATALOG[trd.skillId];
            const flame = trd.passion === 2 ? '🔥🔥' : trd.passion === 1 ? '🔥' : '';
            const sName = tr(def?.skillName ?? trd.skillId);
            const tName = tr(def?.traitName ?? trd.traitId);
            return `
              <div class="rw-skill-bar-row">
                <span class="rw-sk-name"><b>${flame}${sName}</b> (${tName})</span>
                <div class="rw-sk-track"><i style="width:${Math.min(100, trd.level * 5)}%"></i></div>
                <b class="rw-sk-lv">Lv.${trd.level}</b>
              </div>
            `;
          })
          .join('')}
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="rw-mini-btn" id="rw-insp-train-bound">${svgIcon('work', 12)} ${t('练习专精技能', 'Practice Skill')}</button>
        </div>
      `);
      document.getElementById('rw-insp-train-bound')?.addEventListener('click', () => {
        const res = performPawnTriadAction(firstPawn, triads[0]?.skillId ?? 'mining_construct', 12, sim.time);
        onToast(res.message);
        onRefresh();
      });
      return;
    }

    if (inspectTab === 'health') {
      renderRimWorldHealthTab(
        paneEl,
        sim,
        firstPawn,
        showAllAnatomyParts,
        () => {
          showAllAnatomyParts = !showAllAnatomyParts;
        },
        onToast,
        onRefresh,
        setLastInspectKey,
      );
      return;
    }

    renderRimWorldGearTab(paneEl, sim, firstPawn, onToast, onRefresh, setLastInspectKey);
    return;
  }

  if (room.indoors && room.roofed && bldAtCell) {
    renderRoomTabsHeader(true, true);
  } else {
    tabsEl.innerHTML = '';
  }
  paneEl.classList.remove('rw-inspect-health-expanded');

  if (bldAtCell) {
    const bDefId = bldAtCell.targetDefId ?? bldAtCell.defId;
    const bName = tr(bldAtCell.customName ?? sim.tuning.buildings[bDefId]?.name ?? bDefId);
    const fp = sim.world.footprint(bDefId, bldAtCell.rot ?? 0);
    const grid = getBuildingPowerGrid(sim.world, bldAtCell.id);
    const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
    const actorEid = selectedEids[0] ?? colonists[0]?.eid;
    if (bldAtCell.isBlueprint) {
      const needTxt =
        Object.entries(bldAtCell.materialsNeeded ?? {})
          .map(([k, v]) => `${svgIcon(k, 13)} ${k} ${bldAtCell.materialsDelivered?.[k] ?? 0}/${v}`)
          .join(' &nbsp; ') || t('已齐备', 'Ready');
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon(bDefId, 18)} ${t('建造蓝图：', 'Blueprint: ')}${bName} (${fp.w}×${fp.h})</div>
        <div class="rw-insp-meta" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${t('所需材料：', 'Materials: ')}<b>${needTxt}</b></div>
        <div class="rw-insp-meta">${t('施工进度：', 'Work Progress: ')}<b>${Math.round(bldAtCell.workProgress ?? 0)} / ${bldAtCell.workTotal ?? 24}</b></div>
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="rw-mini-btn" id="rw-insp-build-now">${svgIcon('architect', 13)} ${t('立即优先建造', 'Prioritize Construction')}</button>
          <button class="rw-mini-btn" id="rw-insp-cancel-bp" style="border-color:#ff6b6b;color:#ff9c9c">${svgIcon('cancel', 12)} ${t('取消蓝图', 'Cancel Blueprint')}</button>
        </div>
      `);
      document.getElementById('rw-insp-build-now')?.addEventListener('click', () => {
        onToast(constructBlueprint(sim, bldAtCell.id, actorEid, 40).message);
        setLastInspectKey('');
        onRefresh();
      });
      document.getElementById('rw-insp-cancel-bp')?.addEventListener('click', () => {
        onToast(executeArchitectOrder(sim, 'deconstruct', bldAtCell.pos.x, bldAtCell.pos.y, actorEid).message);
        setLastInspectKey('');
        onRefresh();
      });
      return;
    }
    if (bldAtCell.isRuinBuilding && isRuinScavengeDlcEnabled(sim)) {
      const hasLoot = !bldAtCell.scavenged && bldAtCell.scavengeLoot && Object.keys(bldAtCell.scavengeLoot).length > 0;
      const lootBadges = hasLoot
        ? Object.entries(bldAtCell.scavengeLoot!)
            .map(([k, v]) => `<span class="rw-gene-chip" style="display:inline-flex;align-items:center;gap:4px">${svgIcon(k, 13)} ${k} ×${v}</span>`)
            .join(' ')
        : `<span style="color:#9fb0c2">${t('已搜刮搬空（可拆解回收建材）', 'Empty (Can deconstruct for salvage)')}</span>`;
      paneEl.innerHTML = localizeHtml(`
        <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon(bDefId, 18)} ${t('遗迹建筑：', 'Ruin: ')}${bName} (${fp.w}×${fp.h})</div>
        <div class="rw-insp-meta">${t('建筑耐久：', 'HP: ')}<b>${Math.round(bldAtCell.hp)}</b> · ${t('状态：', 'Status: ')}<b style="color:${hasLoot ? '#f5d451' : '#9fb0c2'}">${hasLoot ? t('内藏物资待搜刮', 'Unscavenged Loot') : t('已搜空', 'Scavenged')}</b></div>
        <div class="rw-insp-meta" style="margin-top:4px">${t('内部物资：', 'Contents: ')}${lootBadges}</div>
        <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">
          ${hasLoot ? `<button class="rw-mini-btn" id="rw-insp-scav-bld" style="background:#2b4736;border-color:#7ef09d;color:#fff">${svgIcon('scavenge', 14)} ${t('派人搜刮此建筑', 'Order Scavenge')}</button>` : ''}
          <button class="rw-mini-btn" id="rw-insp-decon-bld">${svgIcon('deconstruct', 13)} ${t('拆解回收建材', 'Deconstruct')}</button>
        </div>
      `);
      document.getElementById('rw-insp-scav-bld')?.addEventListener('click', () => {
        onToast(orderScavengeRuinBuilding(sim, bldAtCell.id, actorEid).message);
        setLastInspectKey('');
        onRefresh();
      });
      document.getElementById('rw-insp-decon-bld')?.addEventListener('click', () => {
        onToast(executeArchitectOrder(sim, 'deconstruct', bldAtCell.pos.x, bldAtCell.pos.y, actorEid).message);
        setLastInspectKey('');
        onRefresh();
      });
      return;
    }
    const bills = getWorkbenchBills(bldAtCell.id, bldAtCell.defId);
    const billsHtml =
      bills.length > 0
        ? `<div style="margin-top:5px;border-top:1px solid #38424d;padding-top:4px">
            <div style="font-size:11px;color:#f5d451;margin-bottom:3px">📋 ${t('工作台生产清单：', 'Workbench Bills:')}</div>
            ${bills
              .map(
                (bl) =>
                  `<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;margin-bottom:3px">
                    <span>${tr(bl.label)} ${bl.mode === 'until_x' ? `[${t('维持', 'Target')} ${bl.targetQty}]` : `[${t('持续', 'Forever')}]`}</span>
                    <div style="display:flex;gap:3px">
                      ${bl.mode === 'until_x' ? `<button class="rw-mini-btn" data-bill-adj="${bl.id}:-2">-2</button><button class="rw-mini-btn" data-bill-adj="${bl.id}:+2">+2</button>` : ''}
                      <button class="rw-mini-btn" data-bill-run="${bl.id}">▶ ${t('生产', 'Craft')}</button>
                    </div>
                  </div>`,
              )
              .join('')}
          </div>`
        : '';
    const cropInfo = bldAtCell.defId === 'field' ? getFieldCropChoice(bldAtCell.id) : null;
    const cropHtml = cropInfo
      ? `<div style="margin-top:5px;border-top:1px solid #38424d;padding-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;gap:4px;flex-wrap:wrap">
          <span>${t('食材作物：', 'Crop: ')}<b style="color:#7ef09d">${tr(cropInfo.name)}</b> (${t('产出', 'Yield')} ${tr(cropInfo.yieldTxt)})</span>
          <div style="display:flex;gap:4px">
            <button class="rw-mini-btn" id="rw-insp-cycle-crop">${svgIcon('field', 12)} ${t('切换食材作物', 'Switch Crop')}</button>
            <button class="rw-mini-btn" id="rw-insp-harvest-crop" style="background:#2b4736;border-color:#7ef09d;color:#fff">🌾 ${t('采收食材', 'Harvest Now')}</button>
          </div>
        </div>`
      : '';
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;align-items:center;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:6px">${svgIcon(bDefId, 18)} ${bName} (${fp.w}×${fp.h})</span>
        <div style="display:flex;gap:4px">
          ${room.indoors && room.roofed ? `<button class="rw-mini-btn" id="rw-insp-open-room-layout" style="background:#2b4736;border-color:#7ef09d;color:#fff">🏠 ${t('房间内设布置', 'Room Layout')}</button>` : ''}
          <button class="rw-mini-btn" id="rw-insp-decon-norm" title="${t('拆除此建筑并回收 75% 材料', 'Deconstruct building and salvage 75% materials')}">${svgIcon('deconstruct', 12)} ${t('拆除', 'Deconstruct')}</button>
        </div>
      </div>
      <div class="rw-insp-statgrid">
        <div>${t('耐久：', 'HP: ')}<b>${Math.round(bldAtCell.hp)}</b></div>
        <div>${t('状态：', 'Status: ')}<b>${t('正常运作', 'Operating')}</b></div>
        ${bldAtCell.buriedPawnName ? `<div>${t('安葬者：', 'Buried: ')}<b>${bldAtCell.buriedPawnName}</b></div>` : ''}
        ${grid ? `<div style="grid-column:span 2"><button class="rw-collapse-mini ${isPowerOverlayActive ? 'active' : ''}" id="rw-bld-pwr-highlight" style="width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center"><span>⚡ ${t(`电网 #${grid.gridId} 负荷：`, `Grid #${grid.gridId}: `)}<b>${tr(grid.statusText)}</b></span><span style="color:#64dfdf">[${t('点击高亮电网', 'Highlight Grid')}]</span></button></div>` : ''}
      </div>
      ${cropHtml}
      ${billsHtml}
    `);
    document.getElementById('rw-bld-pwr-highlight')?.addEventListener('click', () => {
      onTogglePowerOverlay?.();
      powerInspectPinned = true;
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-insp-open-room-layout')?.addEventListener('click', () => {
      roomInspectPinned = true;
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-insp-decon-norm')?.addEventListener('click', () => {
      onToast(executeArchitectOrder(sim, 'deconstruct', bldAtCell.pos.x, bldAtCell.pos.y, actorEid).message);
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-insp-cycle-crop')?.addEventListener('click', () => {
      const next = cycleFieldCropChoice(bldAtCell.id);
      onToast(t(`🌱 农田已切换为种植【${tr(next.name)}】`, `🌱 Switched crop to [${tr(next.name)}]`));
      setLastInspectKey('');
      onRefresh();
    });
    document.getElementById('rw-insp-harvest-crop')?.addEventListener('click', () => {
      onToast(harvestFieldCropNow(sim, bldAtCell.id));
      setLastInspectKey('');
      onRefresh();
    });
    paneEl.querySelectorAll<HTMLButtonElement>('[data-bill-adj]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [bid, deltaStr] = String(btn.dataset.billAdj).split(':');
        const bl = bills.find((x) => x.id === bid);
        if (bl) {
          bl.targetQty = Math.max(2, bl.targetQty + Number(deltaStr));
          setLastInspectKey('');
          onRefresh();
        }
      });
    });
    paneEl.querySelectorAll<HTMLButtonElement>('[data-bill-run]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const msg = executeBuildingBillNow(sim, bldAtCell.id, bldAtCell.defId, String(btn.dataset.billRun));
        onToast(msg);
        setLastInspectKey('');
        onRefresh();
      });
    });
    return;
  }

  if (corpseAtCell) {
    const yieldTxt =
      Object.entries(corpseAtCell.butcherYield ?? { meat: 2, leather: 1 })
        .map(([k, v]) => `${k}×${v}`)
        .join(', ') || t('生肉/毛皮', 'Meat / Leather');
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon('skull', 16)} ${corpseAtCell.name}</div>
      <div class="rw-insp-meta">${t('死因：', 'Cause: ')}<b>${corpseAtCell.causeOfDeath ?? t('战死', 'Killed in combat')}</b> · ${t('屠宰产出：', 'Butcher Yield: ')}<b>${yieldTxt}</b></div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="rw-mini-btn" id="rw-insp-butcher-corpse" style="background:#5c2b29;border-color:#ff9f43">${svgIcon('butcher', 13)} ${t('拖回屠宰台分解', 'Haul & Butcher')}</button>
        ${!corpseAtCell.isAnimalCorpse ? `<button class="rw-mini-btn" id="rw-insp-open-corpse">${svgIcon('scavenge', 13)} ${t('搜刮随身装备', 'Strip / Loot Gear')}</button>` : ''}
      </div>
    `);
    document.getElementById('rw-insp-butcher-corpse')?.addEventListener('click', () => {
      const res = haulAndButcherCorpse(sim, corpseAtCell.eid, selectedEids[0]);
      onToast(res.message);
      onRefresh();
    });
    document.getElementById('rw-insp-open-corpse')?.addEventListener('click', () => {
      openCorpseLootModal(sim, corpseAtCell.eid, selectedEids[0], onToast, onRefresh);
    });
    return;
  }

  if (itemAtCell) {
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon(itemAtCell.item, 16)} ${t('散落物资：', 'Dropped Item: ')}${itemAtCell.item} ×${itemAtCell.amount}</div>
      <div class="rw-insp-meta">${t('耐久：', 'HP: ')}<b>${Math.round(itemAtCell.hp)} / ${itemAtCell.maxHp}</b> · (${gx}, ${gy})</div>
    `);
    return;
  }

  if (minAtCell) {
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon('mine', 16)} ${t('矿脉：', 'Vein: ')}${tr(minAtCell.name)}</div>
      <div class="rw-insp-meta">${t('开采产出：', 'Yield: ')}<b>${svgIcon(minAtCell.yieldItem, 13)} ${minAtCell.yieldItem} ×${minAtCell.amount}</b></div>
    `);
    return;
  }

  if (featAtCell) {
    const isTree = featAtCell.kind === 'tree';
    paneEl.innerHTML = localizeHtml(`
      <div class="rw-insp-title" style="display:flex;align-items:center;gap:6px">${svgIcon(isTree ? 'chop' : 'berry', 16)} ${t('自然植物：', 'Plant: ')}${isTree ? t('成熟乔木 (占地 1×1)', 'Mature Tree (1×1)') : t('野生浆果丛', 'Wild Berry Bush')}</div>
      <div class="rw-insp-meta">${t('可收获量：', 'Yield: ')}<b>${svgIcon(isTree ? 'wood' : 'food', 13)} ${featAtCell.amount}</b></div>
    `);
    return;
  }

  if (room.indoors && room.roofed) {
    renderSelectedRoomFurnishingPanel();
    return;
  }

  paneEl.innerHTML = localizeHtml(`
    <div class="rw-insp-title" style="color:#9fb0c2">${t(`室外空置地面 (${gx}, ${gy}) · ${room.label}`, `Outdoor Ground (${gx}, ${gy}) · Outdoors`)}</div>
    <div class="rw-insp-meta">${t('可用【墙壁】与【房门】围合 ≤13×13 的封闭房间，随后点击选中房间内部即可打开【房间内设/装饰/工作台布置界面】！外部设施（太阳能/风电/灯塔/大篝火）只能在室外建造。', 'Enclose an area (≤13×13) with Walls & Doors, then click inside the room to furnish furniture, decor, and workbenches. Exterior facilities can only be placed outdoors.')}</div>
  `);
}
