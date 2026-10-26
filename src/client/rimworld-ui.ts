/**
 * client/rimworld-ui.ts —— RimWorld 玩家界面主控制器（含 i18n 实时中英切换）：
 *  - 四角 HUD（左上分类折叠物资栏、右上信封与警报、左下检视与房间布置窗、右下环境读数与时间速度条）独立容错渲染；
 *  - 右下角小图标栏内置 `🌐 中文 / EN` 语言切换按钮（快捷键 `L`），实时无损切换全界面语言；
 *  - 左下角检视面板内建「健康(身体部位)」、「装备/武器」、「电网负荷高亮检视」以及「选中封闭房间布置内设/装饰/工作台」。
 */
import { Sim, XENOTYPES, getColonyCulinarySummary, isInteriorRoomBuilding, assignPawnToGroup, createColonistGroup, ensureRimWorldBuildingsRegistered, executeArchitectOrder, getColonistGroups, getDeadPawns, getNpcBases, inspectFootprintCells, inspectRoomAt, orderPlayerRaiders, setPawnDrafted, terrainMetaAt } from '../sim';
import { getUiLocale, localizeHtml, t, toggleUiLocale, tr } from './i18n';
import { svgIcon } from './ui-icons';
import { makeModalDraggable, openCorpseLootModal, openFactionTradeModal } from './ui-modals';
import { renderActiveDrawerContent } from './ui-drawers';
import { pinRoomFurnishingPanel, renderInspectPaneContent, type InspectTabId } from './ui-inspect';
import { createRootDomHtml } from './ui-dom-template';
import { handleRimWorldRightClickMenu, hideRimWorldFloatMenu } from './ui-float-menu';
import { isManualWorkPriorityMode } from './ui-schedule-bills';
import { placeArchitectBlueprint } from '../sim/rimworld-work';
import type { MapOverlayMode } from './render-overlays';
export type MainTabId = 'none' | 'architect' | 'work' | 'schedule' | 'groups' | 'world_mmo' | 'dlc' | 'help';
export type ActiveDesignator = | { kind: 'none' }
  | { kind: 'build'; defId: string; name: string }
  | { kind: 'order'; orderKind: 'mine' | 'chop' | 'harvest' | 'deconstruct'; label: string }
  | { kind: 'raid_march' };
export interface BlueprintCellPreview {
  x: number; y: number;
  valid: boolean;
}
export interface RimWorldUiHooks {
  getSim: () => Sim | null; getSelected: () => Set<number>;
  setSelected: (eids: number[]) => void; getSelectedBuilding: () => string | null;
  getSelectedHostile: () => number | null; getSelectedBase: () => string | null;
  setSelectedBase: (baseId: string | null) => void; centerCameraOn: (x: number, y: number) => void;
  getZoomTilePx?: () => number; setZoomTilePx?: (tilePx: number) => void;
  getMapOverlayMode?: () => MapOverlayMode; setMapOverlayMode?: (mode: MapOverlayMode) => void;
  getPerfStats?: () => { fps: number; renderMs: number }; getPaused: () => boolean;
  setPaused: (paused: boolean) => void; getSpeed: () => number;
  setSpeed: (speed: number) => void; onSave: () => void;
  onLoad: () => void; onNewWorld: () => void;
  issueCommand: (type: string, args: Record<string, unknown>) => void;
  setBlueprintPreview?: (preview: {
    kind: 'none' | 'build' | 'order' | 'raid_march'; defId?: string;
    rot?: number; w?: number;
    h?: number; cells?: BlueprintCellPreview[];
  }) => void;
}
export class RimWorldUiController {
  private activeTab: MainTabId = 'none';
  private architectCategory = 'structure';
  private inspectTab: InspectTabId = 'bio';
  public designator: ActiveDesignator = { kind: 'none' };
  public buildRotation: 0 | 1 | 2 | 3 = 0;
  private activeGroupFilter = 'all';
  private showNewGroupInput = false;
  private lastHoverWorld = { x: 0, y: 0 };
  private lastClickedGround = { x: -4, y: -5 };
  private collapsedPanels: Record<string, boolean> = {};
  private lastColonistKey = '';
  private lastResKey = '';
  private lastInspectKey = '';
  private lastGizmoKey = '';
  private lastAlertsKey = '';
  private lastClockKey = '';
  private lastDrawerKey = '';
  private lastHudTickMs = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly hooks: RimWorldUiHooks) {
    const sim = this.hooks.getSim(); if (sim) {
      ensureRimWorldBuildingsRegistered(sim, true); getColonistGroups(sim);
    }
    this.mountDomStructure(); this.bindGlobalShortcuts();
  }
  showToast(msg: string): void {
    const el = document.getElementById('rw-toast'); if (!el) return;
    el.textContent = tr(msg); el.classList.add('visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
  }
  isLineDragDesignatorActive(): boolean {
    if (this.designator.kind === 'order') return true; if (this.designator.kind === 'build') {
      return ['wall', 'door', 'power_conduit', 'trap', 'slope', 'grave'].includes(this.designator.defId);
    }
    return false;
  }
  handleCanvasDragLine(cells: { x: number; y: number }[]): boolean {
    const sim = this.hooks.getSim(); if (!sim || cells.length === 0) return false;
    if (this.designator.kind === 'build') {
      let count = 0; let lastMsg = '';
      for (const c of cells) {
        const res = placeArchitectBlueprint(sim, this.designator.defId, c.x, c.y, this.buildRotation, sim.activePlayerId);
        if (res.ok) count++; else lastMsg = res.message;
      }
      if (count > 0) this.showToast(t(`🏗 已连续规划 ${count} 处【${tr(this.designator.name)}】蓝图`, `🏗 Placed ${count} [${tr(this.designator.name)}] blueprints`));
      else if (lastMsg) this.showToast(lastMsg); this.forceRefresh();
      return true;
    }
    if (this.designator.kind === 'order') {
      const sel = [...this.hooks.getSelected()][0]; let count = 0;
      for (const c of cells) {
        const res = executeArchitectOrder(sim, this.designator.orderKind, c.x, c.y, sel);
        if (res.ok) count++;
      }
      if (count > 0) this.showToast(t(`🔨 已对 ${count} 处目标执行【${tr(this.designator.label)}】`, `🔨 Executed [${tr(this.designator.label)}] on ${count} targets`));
      this.forceRefresh(); return true;
    }
    return false;
  }
  rotateBuildOrientation(): void {
    this.buildRotation = ((this.buildRotation + 1) % 4) as 0 | 1 | 2 | 3;
    const sim = this.hooks.getSim(); if (sim && this.designator.kind === 'build') {
      const { w, h } = sim.world.footprint(this.designator.defId, this.buildRotation);
      this.showToast(t(`↻ 【${tr(this.designator.name)}】朝向：${this.buildRotation * 90}° (${w}×${h})`, `↻ [${tr(this.designator.name)}] Rotation: ${this.buildRotation * 90}° (${w}×${h})`));
    }
    const cellEl = document.getElementById('rw-cell-inspector');
    if (cellEl) {
      const sim = this.hooks.getSim();
      if (sim && (this.lastHoverWorld.x !== 0 || this.lastHoverWorld.y !== 0)) {
        const tm = terrainMetaAt(sim.world, this.lastHoverWorld.x, this.lastHoverWorld.y);
        const rm = inspectRoomAt(sim.world, this.lastHoverWorld.x, this.lastHoverWorld.y);
        cellEl.textContent = `(${this.lastHoverWorld.x}, ${this.lastHoverWorld.y}) ${tr(tm.shortName)} · ${tr(rm.label)} · ${t('移速', 'Move')} ${Math.round(tm.moveSpeedMul * 100)}%`;
      } else {
        cellEl.textContent = t('悬停地面查看环境信息', 'Hover over terrain to inspect cell');
      }
    }
    this.updateDesignatorBanner();
    this.updateCellHover(this.lastHoverWorld.x, this.lastHoverWorld.y);
    this.forceRefresh();
  }
  private openEnclosedRoomInspector(sim: Sim): void {
    let targetRoomPos = { x: -4, y: -5 };
    const curRm = inspectRoomAt(sim.world, this.lastClickedGround.x, this.lastClickedGround.y);
    if (curRm.indoors && curRm.roofed) {
      targetRoomPos = { ...this.lastClickedGround };
    } else {
      for (let rx = -14; rx <= 14; rx++) {
        let found = false; for (let ry = -14; ry <= 14; ry++) {
          const rm = inspectRoomAt(sim.world, rx, ry); if (rm.indoors && rm.roofed) {
            targetRoomPos = { x: rx, y: ry }; found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    this.lastClickedGround = targetRoomPos; this.hooks.setSelected([]);
    pinRoomFurnishingPanel(); if (this.collapsedPanels['inspect']) {
      this.collapsedPanels['inspect'] = false; for (const id of ['rw-inspect-body', 'rw-inspect-tabs']) {
        const el = document.getElementById(id); if (el) el.style.display = '';
      }
      const btn = document.getElementById('rw-toggle-inspect'); if (btn) btn.textContent = t('▾ 检视面板', '▾ Inspect');
    }
    this.lastInspectKey = '';
    this.showToast(t(`🏠 已选中封闭房间 (${targetRoomPos.x}, ${targetRoomPos.y})：可在左下角面板布置【内设家具 / 室内装饰 / 室内工作台】`, `🏠 Selected enclosed room (${targetRoomPos.x}, ${targetRoomPos.y}): Furnish via the bottom-left inspect panel`));
    this.forceRefresh();
  }
  handleCanvasLeftClick(wx: number, wy: number): boolean {
    hideRimWorldFloatMenu(); const sim = this.hooks.getSim();
    if (!sim) return false; const x = Math.round(wx);
    const y = Math.round(wy); this.lastClickedGround = { x, y };
    if (this.designator.kind === 'build') {
      const res = placeArchitectBlueprint(sim, this.designator.defId, x, y, this.buildRotation, sim.activePlayerId, {
        requireIndoorRoom: isInteriorRoomBuilding(this.designator.defId), });
      this.showToast(res.message); this.updateCellHover(wx, wy);
      this.forceRefresh(); return true;
    }
    if (this.designator.kind === 'order') {
      const sel = [...this.hooks.getSelected()][0];
      const res = executeArchitectOrder(sim, this.designator.orderKind, x, y, sel);
      this.showToast(res.message); this.updateCellHover(wx, wy);
      this.forceRefresh(); return true;
    }
    if (this.designator.kind === 'raid_march') {
      const res = orderPlayerRaiders(sim, { mode: 'march', targetPos: { x, y } });
      this.showToast(res.message); this.designator = { kind: 'none' };
      this.syncBlueprintPreview(sim, x, y); this.updateDesignatorBanner();
      this.forceRefresh(); return true;
    }
    let clickedBaseId: string | null = null; for (const base of getNpcBases(sim).values()) {
      if (Math.abs(base.pos.x - wx) <= 2.6 && Math.abs(base.pos.y - wy) <= 2.6) {
        clickedBaseId = base.id; break;
      }
    }
    this.hooks.setSelectedBase(clickedBaseId); this.lastInspectKey = '';
    return false;
  }
  handleCanvasRightClick(screenX: number, screenY: number, wx: number, wy: number): boolean {
    const sim = this.hooks.getSim(); if (this.designator.kind !== 'none') {
      this.designator = { kind: 'none' };
      if (sim) this.syncBlueprintPreview(sim, Math.round(wx), Math.round(wy));
      this.updateDesignatorBanner(); this.showToast(t('已取消当前规划模式', 'Canceled active designator'));
      return true;
    }
    if (!sim) return false;
    return handleRimWorldRightClickMenu(sim, screenX, screenY, wx, wy, {
      getSelected: () => this.hooks.getSelected(), setSelected: (eids) => this.hooks.setSelected(eids),
      issueCommand: (tp, a) => this.hooks.issueCommand(tp, a), showToast: (m) => this.showToast(m),
      forceRefresh: () => this.forceRefresh(), reopenAt: (sx, sy, rx, ry) => this.handleCanvasRightClick(sx, sy, rx, ry),
    });
  }
  private toggleMapOverlay(mode: MapOverlayMode): boolean {
    const cur = this.hooks.getMapOverlayMode?.() ?? 'none'; const next: MapOverlayMode = cur === mode ? 'none' : mode;
    this.hooks.setMapOverlayMode?.(next);
    document.querySelectorAll<HTMLButtonElement>('#rw-overlay-toggles button[data-ovmode]').forEach((b) => { b.classList.toggle('active', b.dataset.ovmode === next); });
    this.showToast( next === 'fertility'
        ? t('🌱 已开启土壤肥力图层', '🌱 Soil Fertility Overlay ON')
        : next === 'roof'
          ? t('🏠 已开启屋顶与室内图层 (≤13×13封顶)', '🏠 Roof & Indoors Overlay ON')
          : next === 'power'
            ? t('⚡ 已开启电网负荷高亮图层', '⚡ Power Grid Overlay ON')
            : t('已关闭地图叠加图层', 'Map Overlay OFF'), ); return next === mode;
  }
  private syncStaticLocaleLabels(): void {
    const isEn = getUiLocale() === 'en';
    const langBtn = document.getElementById('rw-lang-toggle');
    if (langBtn) langBtn.textContent = isEn ? '🌐 EN' : '🌐 中文';
    const tabMap: Record<string, [string, string]> = {
      architect: ['建筑规划', 'Architect'], work: ['工作指派', 'Work'],
      schedule: ['日程管制', 'Schedule'], groups: ['小队行囊', 'Squads'],
      world_mmo: ['派系外交', 'Factions'], dlc: ['DLC与存档', 'DLC & Saves'],
      help: ['百科指南', 'Wiki Guide'],
    };
    for (const [k, [zh, en]] of Object.entries(tabMap)) {
      const span = document.querySelector<HTMLElement>(`[data-i18n-tab="${k}"]`);
      if (span) span.textContent = isEn ? en : zh;
    }
    const pillMap: [string, string, string, string][] = [
      ['rw-toggle-colonist', 'colonist', '殖民者顶栏', 'Colonists'],
      ['rw-toggle-alerts', 'alerts', '信封与警报', 'Letters & Alerts'],
      ['rw-toggle-inspect', 'inspect', '检视面板', 'Inspect'],
      ['rw-toggle-gizmos', 'gizmos', '快捷指令栏', 'Gizmos'],
    ];
    for (const [id, key, zh, en] of pillMap) {
      const el = document.getElementById(id);
      if (el) el.textContent = `${this.collapsedPanels[key] ? '▸' : '▾'} ${isEn ? en : zh}`;
    }
    this.updateDesignatorBanner();
  }
  private handleLanguageToggle(): void {
    const next = toggleUiLocale();
    this.syncStaticLocaleLabels();
    this.forceRefresh();
    this.showToast(next === 'en' ? '🌐 Switched UI Language to English' : '🌐 已切换界面语言为：纯净简体中文');
  }
  private mountDomStructure(): void {
    if (document.getElementById('rw-root')) return; const root = document.createElement('div');
    root.id = 'rw-root'; root.innerHTML = createRootDomHtml();
    document.body.appendChild(root);
    root.querySelectorAll<HTMLButtonElement>('.rw-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => { const tab = btn.dataset.tab as MainTabId; this.activeTab = this.activeTab === tab ? 'none' : tab; this.lastDrawerKey = ''; this.syncTabButtons(); this.renderMainDrawer(); });
    });
    root.querySelectorAll<HTMLButtonElement>('#rw-speed-controls button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const spd = Number(btn.dataset.speed); if (spd === 0) this.hooks.setPaused(!this.hooks.getPaused());
        else {
          this.hooks.setPaused(false); this.hooks.setSpeed(spd);
        }
        this.forceRefresh();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('#rw-overlay-toggles button[data-ovmode]').forEach((btn) => {
      btn.addEventListener('click', () => { const mode = btn.dataset.ovmode as MapOverlayMode; this.toggleMapOverlay(mode); this.lastInspectKey = ''; this.forceRefresh(); });
    });
    document.getElementById('rw-lang-toggle')?.addEventListener('click', () => this.handleLanguageToggle());
    const toggles: [string, string, string[]][] = [
      ['rw-toggle-colonist', 'colonist', ['rw-colonist-bar']],
      ['rw-toggle-alerts', 'alerts', ['rw-alerts-stack']],
      ['rw-toggle-inspect', 'inspect', ['rw-inspect-body', 'rw-inspect-tabs']],
      ['rw-toggle-gizmos', 'gizmos', ['rw-gizmo-bar']],
    ];
    for (const [btnId, key, ids] of toggles) {
      document.getElementById(btnId)?.addEventListener('click', () => {
        const next = (this.collapsedPanels[key] = !this.collapsedPanels[key]);
        for (const id of ids) {
          const el = document.getElementById(id); if (el) el.style.display = next ? 'none' : '';
        }
        this.syncStaticLocaleLabels();
      });
    }
    const inspWrap = document.getElementById('rw-inspect-wrap');
    const inspHead = document.getElementById('rw-inspect-top-bar');
    if (inspWrap && inspHead) makeModalDraggable(inspWrap, inspHead, 'rw-inspect-wrap');
    window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.ctrlKey) return; const fm = document.getElementById('rw-float-menu');
      if (fm && !fm.hidden && e.target instanceof Node && !fm.contains(e.target)) hideRimWorldFloatMenu();
    });
  }
  private bindGlobalShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const sim = this.hooks.getSim();
      if (!sim || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Digit1') {
        this.hooks.setPaused(false); this.hooks.setSpeed(1);
        this.forceRefresh();
      } else if (e.code === 'Digit2') {
        this.hooks.setPaused(false); this.hooks.setSpeed(3);
        this.forceRefresh();
      } else if (e.code === 'Digit3') {
        this.hooks.setPaused(false); this.hooks.setSpeed(8);
        this.forceRefresh();
      } else if (e.code === 'KeyL') {
        this.handleLanguageToggle();
      } else if (e.code === 'KeyR') {
        if (this.designator.kind === 'build') {
          this.rotateBuildOrientation(); return;
        }
        const sel = [...this.hooks.getSelected()];
        const targets = sel.length > 0 ? sel : [...sim.pawns()].filter((p) => !p.isStranger).slice(0, 1).map((p) => p.eid);
        if (targets.length > 0) {
          const first = sim.pawn(targets[0]); const nextDraft = !first?.drafted;
          setPawnDrafted(sim, targets, nextDraft); this.showToast(nextDraft ? t('⚔ 已征召殖民者 (R)', '⚔ Colonist Drafted (R)') : t('🕊 已解除征召 (R)', '🕊 Undrafted (R)'));
          this.forceRefresh();
        }
      } else if (e.code === 'Escape') {
        hideRimWorldFloatMenu(); const modal = document.getElementById('rw-corpse-modal');
        if (modal && !modal.hidden) {
          modal.hidden = true; return;
        }
        if (this.designator.kind !== 'none') {
          this.designator = { kind: 'none' };
          this.syncBlueprintPreview(sim, this.lastHoverWorld.x, this.lastHoverWorld.y);
          this.updateDesignatorBanner();
        } else if (this.activeTab !== 'none') {
          this.activeTab = 'none'; this.lastDrawerKey = '';
          this.syncTabButtons(); this.renderMainDrawer();
        }
      }
    });
  }
  private syncTabButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('#rw-main-tabbar .rw-tab-btn').forEach((btn) => { btn.classList.toggle('active', btn.dataset.tab === this.activeTab); });
    const isWorkFullWidth = this.activeTab === 'work';
    const isLargeModalDrawer = this.activeTab !== 'none' && this.activeTab !== 'architect';
    for (const id of ['rw-inspect-wrap', 'rw-gizmo-wrap']) {
      const panel = document.getElementById(id); if (panel) panel.style.display = isLargeModalDrawer ? 'none' : '';
    }
    const drawer = document.getElementById('rw-main-drawer'); if (drawer) {
      drawer.classList.toggle('rw-work-fullwidth', isWorkFullWidth);
      drawer.classList.toggle('rw-drawer-architect', this.activeTab === 'architect');
      if (isWorkFullWidth || this.activeTab === 'architect') {
        drawer.style.left = ''; drawer.style.top = '';
        drawer.style.right = ''; drawer.style.bottom = '';
      }
    }
  }
  public updateDesignatorBanner(): void {
    const el = document.getElementById('rw-designator-banner'); const sim = this.hooks.getSim();
    if (!el) return; if (this.designator.kind === 'none') {
      el.hidden = true; return;
    }
    el.hidden = false;
    const fp = sim && this.designator.kind === 'build' ? sim.world.footprint(this.designator.defId, this.buildRotation) : { w: 1, h: 1 };
    const dragHint = this.isLineDragDesignatorActive() ? t(' · 支持左键拖拽连续铺设', ' · Drag to place line') : '';
    const text = this.designator.kind === 'build'
        ? `${svgIcon(this.designator.defId, 16)} ${t(`建造规划：【${tr(this.designator.name)}】(${fp.w}×${fp.h}${dragHint} · 右键取消)`, `Build: [${tr(this.designator.name)}] (${fp.w}×${fp.h}${dragHint} · Right-click cancel)`)}`
        : this.designator.kind === 'order'
          ? `${svgIcon(this.designator.orderKind, 16)} ${t(`作业指令：【${tr(this.designator.label)}】(左键点击或拖拽执行 · 右键取消)`, `Order: [${tr(this.designator.label)}] (Click/Drag · Right-click cancel)`)}`
          : t('袭击推进目标点', 'Raid March Target');
    el.innerHTML = `<span style="display:flex;align-items:center;gap:6px">${text}</span>${this.designator.kind === 'build' ? `<button id="rw-rotate-desig">${svgIcon('rotate', 13)} ${t('旋转 (R)', 'Rotate (R)')}</button>` : ''}<button id="rw-cancel-desig">${svgIcon('cancel', 12)} ${t('取消 (ESC)', 'Cancel (ESC)')}</button>`;
    document.getElementById('rw-rotate-desig')?.addEventListener('click', () => this.rotateBuildOrientation());
    document.getElementById('rw-cancel-desig')?.addEventListener('click', () => {
      this.designator = { kind: 'none' };
      if (sim) this.syncBlueprintPreview(sim, this.lastHoverWorld.x, this.lastHoverWorld.y);
      this.updateDesignatorBanner();
    });
  }
  private syncBlueprintPreview(sim: Sim, x: number, y: number): void {
    if (!this.hooks.setBlueprintPreview) return; if (this.designator.kind === 'build') {
      const insp = inspectFootprintCells(sim, this.designator.defId, x, y, this.buildRotation, {
        requireIndoorRoom: isInteriorRoomBuilding(this.designator.defId), });
      this.hooks.setBlueprintPreview({
        kind: 'build', defId: this.designator.defId,
        rot: this.buildRotation, w: insp.w,
        h: insp.h, cells: insp.cells.map((c) => ({ x: c.x, y: c.y, valid: c.valid && insp.canAfford })),
      });
    } else { this.hooks.setBlueprintPreview({ kind: this.designator.kind === 'none' ? 'none' : 'order' }); }
  }
  updateCellHover(wx: number, wy: number): void {
    const sim = this.hooks.getSim(); if (!sim) return;
    const x = Math.round(wx); const y = Math.round(wy);
    if (x === this.lastHoverWorld.x && y === this.lastHoverWorld.y) return;
    this.lastHoverWorld = { x, y }; this.syncBlueprintPreview(sim, x, y);
    const cellEl = document.getElementById('rw-cell-inspector');
    if (cellEl) {
      const tm = terrainMetaAt(sim.world, x, y); const rm = inspectRoomAt(sim.world, x, y);
      cellEl.textContent = `(${x}, ${y}) ${tr(tm.shortName)} · ${tr(rm.label)} · ${t('移速', 'Move')} ${Math.round(tm.moveSpeedMul * 100)}%`;
    }
  }
  forceRefresh(): void {
    this.lastColonistKey = ''; this.lastResKey = '';
    this.lastInspectKey = ''; this.lastGizmoKey = '';
    this.lastAlertsKey = ''; this.lastClockKey = '';
    this.lastDrawerKey = ''; this.lastHudTickMs = 0;
    this.frame();
  }
  frame(): void {
    const sim = this.hooks.getSim(); if (!sim) return;
    const now = performance.now(); if (now - this.lastHudTickMs < 95) return;
    this.lastHudTickMs = now;
    try { this.renderColonistBar(sim); } catch (e) { console.error('ColonistBar err:', e); }
    try { this.renderResourceReadout(sim); } catch (e) { console.error('ResourceReadout err:', e); }
    try { this.renderInspectPane(sim); } catch (e) { console.error('InspectPane err:', e); }
    try { this.renderGizmoBar(sim); } catch (e) { console.error('GizmoBar err:', e); }
    try { this.renderAlerts(sim); } catch (e) { console.error('Alerts err:', e); }
    try { this.renderClockAndSpeed(sim); } catch (e) { console.error('Clock err:', e); }
    if (this.activeTab !== 'none') { try { this.renderMainDrawer(); } catch (e) { console.error('MainDrawer err:', e); } }
  }
  private renderColonistBar(sim: Sim): void {
    const el = document.getElementById('rw-colonist-bar'); if (!el) return;
    if (document.activeElement instanceof HTMLInputElement && el.contains(document.activeElement)) return;
    const allPawns = [...sim.pawns()]; const colonists = allPawns.filter((p) => !p.isStranger);
    const groupsMap = getColonistGroups(sim); const allGroups = [...groupsMap.values()];
    const filteredPawns = this.activeGroupFilter === 'all'
        ? allPawns
        : colonists.filter((p) => (p.groupId ?? 'group_alpha') === this.activeGroupFilter);
    const pawns = filteredPawns.slice(0, 18); const sel = this.hooks.getSelected();
    const grpSig = allGroups.map((g) => `${g.id}:${g.name}:${g.memberEids.length}`).join(';');
    const key = `${getUiLocale()}|${this.activeGroupFilter}|${this.showNewGroupInput ? 1 : 0}|${grpSig}|${pawns.map((p) => `${p.eid}:${p.groupId ?? ''}:${Math.round(p.hp)}:${Math.round(p.needs.mood / 4)}:${p.drafted ? 1 : 0}:${p.formerColonist ? 1 : 0}:${sel.has(p.eid) ? 1 : 0}`).join(',')}`;
    if (key === this.lastColonistKey) return; this.lastColonistKey = key;
    const groupButtonsHtml = allGroups
      .map((g) => {
        const shortName = tr(g.name.split(' ')[0]);
        const count = colonists.filter((p) => (p.groupId ?? 'group_alpha') === g.id).length;
        return `<button class="rw-collapse-mini ${this.activeGroupFilter === g.id ? 'active' : ''}" data-gfilter="${g.id}">${shortName} (${count})</button>`;
      })
      .join(''); const newGroupInlineHtml = this.showNewGroupInput
      ? `<span style="display:inline-flex;align-items:center;gap:3px;background:#14181d;border:1px solid #f5d451;padding:1px 4px;border-radius:3px">
          <input id="rw-top-new-grp-inp" type="text" placeholder="${t('输入新编组名...', 'Squad name...')}" style="width:96px;background:transparent;border:none;color:#fff;font-size:11px;outline:none" />
          <button class="rw-collapse-mini" id="rw-top-new-grp-ok" style="background:#2b543a;color:#fff">${t('创建', 'Create')}</button>
          <button class="rw-collapse-mini" id="rw-top-new-grp-cancel">✕</button>
        </span>`
      : `<button class="rw-collapse-mini" id="rw-top-new-grp-btn" title="${t('创建新的殖民者自定义编组', 'Create new colonist squad')}">${t('➕ 新建组', '➕ New Group')}</button>`;
    const assignToCurrentBtn = this.activeGroupFilter !== 'all' && sel.size > 0
        ? `<button class="rw-collapse-mini" id="rw-top-assign-sel" title="${t('将当前选中的殖民者编入本组', 'Assign selected colonist to this squad')}">📥 ${t(`编入选中(${sel.size})`, `Assign (${sel.size})`)}</button>`
        : '';
    const filterBarHtml = `<div class="rw-col-filter-bar" style="display:flex;gap:4px;margin-bottom:4px;justify-content:center;flex-wrap:wrap;align-items:center">
      <button class="rw-collapse-mini ${this.activeGroupFilter === 'all' ? 'active' : ''}" data-gfilter="all">${svgIcon('groups', 12)} ${t('全部', 'All')} (${allPawns.length})</button>
      ${groupButtonsHtml}
      ${assignToCurrentBtn}
      ${newGroupInlineHtml}
    </div>`; const cardsHtml = pawns.length === 0
        ? `<div class="rw-colonist-card" style="width:auto;min-width:150px;padding:6px 10px"><div style="font-size:11px;color:#cfd8e3;margin-bottom:4px">${t('该编组暂无殖民者', 'No colonists in squad')}</div><button class="rw-mini-btn" id="rw-quick-assign-grp">➕ ${t('编入当前选中殖民者', 'Assign Selected')}</button></div>`
        : pawns
            .map((p) => {
              const isSel = sel.has(p.eid);
              const hpPct = Math.max(0, Math.min(100, Math.round((p.hp / p.maxHp) * 100)));
              const xeno = XENOTYPES[p.xenotype ?? 'ratkin'] ?? XENOTYPES.ratkin;
              const moodPct = Math.max(0, Math.min(100, Math.round(p.needs.mood)));
              const moodCol = moodPct >= 60 ? '#3b7a57' : moodPct >= 35 ? '#b8860b' : '#a83232';
              const grpObj = groupsMap.get(p.groupId ?? 'group_alpha'); const grpBadge = p.formerColonist
                ? t('崩溃离队', 'Wild')
                : p.isStranger
                  ? t('访客', 'Visitor')
                  : grpObj
                    ? tr(grpObj.name.split(' ')[0].slice(0, 4))
                    : t('主力', 'Alpha');
              return `<div class="rw-colonist-card ${isSel ? 'selected' : ''} ${p.drafted ? 'drafted' : ''}" data-eid="${p.eid}" title="${t(`左键选中 ${p.name} · 双击镜头跟随`, `Click to select ${p.name} · Double-click to center`)}">
                <div class="rw-col-mood-bg" style="height:${moodPct}%;background:${moodCol}"></div>
                ${p.drafted ? `<span class="rw-col-draft-badge">${svgIcon('draft', 11)}</span>` : ''}
                <div class="rw-col-avatar">${svgIcon('pawn_ratkin', 34)}</div>
                <div class="rw-col-hpbar"><i style="width:${hpPct}%"></i></div>
                <div class="rw-col-name">${p.name}</div>
                <div class="rw-col-job" style="color:${p.formerColonist ? '#ff9f43' : xeno.accentColor}">${grpBadge}</div>
              </div>`;
            })
            .join('');
    el.innerHTML = localizeHtml(`${filterBarHtml}<div style="display:flex;gap:6px">${cardsHtml}${filteredPawns.length > 18 ? `<div class="rw-colonist-card"><b>+${filteredPawns.length - 18}</b></div>` : ''}</div>`);
    el.querySelectorAll<HTMLButtonElement>('[data-gfilter]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation(); const nextFilter = btn.dataset.gfilter ?? 'all';
        this.activeGroupFilter = nextFilter; if (nextFilter !== 'all') {
          const members = colonists.filter((p) => (p.groupId ?? 'group_alpha') === nextFilter);
          const currentSel = [...this.hooks.getSelected()];
          if (!currentSel.some((eid) => members.some((m) => m.eid === eid)) && members.length > 0) {
            this.hooks.setSelected([members[0].eid]);
          }
        }
        this.forceRefresh();
      };
    });
    document.getElementById('rw-top-new-grp-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); this.showNewGroupInput = true;
      this.lastColonistKey = ''; this.renderColonistBar(sim);
      (document.getElementById('rw-top-new-grp-inp') as HTMLInputElement | null)?.focus();
    }); const confirmCreateGroup = () => {
      const inp = document.getElementById('rw-top-new-grp-inp') as HTMLInputElement | null;
      const selEids = [...this.hooks.getSelected()]; const res = createColonistGroup(sim, inp?.value, selEids);
      this.showNewGroupInput = false; this.activeGroupFilter = res.group.id;
      this.showToast(res.message); this.forceRefresh();
    };
    document.getElementById('rw-top-new-grp-ok')?.addEventListener('click', (e) => { e.stopPropagation(); confirmCreateGroup(); });
    document.getElementById('rw-top-new-grp-inp')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); confirmCreateGroup();
      } else if (e.key === 'Escape') {
        this.showNewGroupInput = false; this.forceRefresh();
      }
    });
    document.getElementById('rw-top-new-grp-cancel')?.addEventListener('click', (e) => { e.stopPropagation(); this.showNewGroupInput = false; this.forceRefresh(); });
    document.getElementById('rw-top-assign-sel')?.addEventListener('click', (e) => {
      e.stopPropagation(); if (this.activeGroupFilter === 'all') return;
      for (const eid of this.hooks.getSelected()) { assignPawnToGroup(sim, eid, this.activeGroupFilter); }
      this.showToast(t('👥 已将选中的殖民者编入当前编组', '👥 Assigned selected colonists to current squad')); this.forceRefresh();
    });
    document.getElementById('rw-quick-assign-grp')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetPawnEid = [...this.hooks.getSelected()][0] ?? colonists[0]?.eid;
      if (targetPawnEid !== undefined && this.activeGroupFilter !== 'all') {
        this.showToast(assignPawnToGroup(sim, targetPawnEid, this.activeGroupFilter).message);
        this.hooks.setSelected([targetPawnEid]); this.forceRefresh();
      }
    });
    el.querySelectorAll<HTMLElement>('.rw-colonist-card[data-eid]').forEach((card) => { const eid = Number(card.dataset.eid); card.onclick = () => { this.hooks.setSelected([eid]); this.forceRefresh(); };
      card.ondblclick = () => {
        const p = sim.pawn(eid); if (p) this.hooks.centerCameraOn(p.pos.x, p.pos.y);
      };
    });
  }
  private renderResourceReadout(sim: Sim): void {
    const el = document.getElementById('rw-resource-readout'); if (!el) return;
    const st = sim.stockpile; const cl = Boolean(this.collapsedPanels['res']);
    const cCul = Boolean(this.collapsedPanels['res_cul']); const cMat = Boolean(this.collapsedPanels['res_mat']);
    const cLux = Boolean(this.collapsedPanels['res_lux']); const cul = getColonyCulinarySummary(sim);
    const key = `${getUiLocale()}:${cl ? 1 : 0}:${cCul ? 1 : 0}:${cMat ? 1 : 0}:${cLux ? 1 : 0}|${cul.totalDishes}|${cul.totalIngredients}|${Math.round(st['food'] ?? 0)}|${Math.round(st['meal'] ?? 0)}|${Math.round(st['meat'] ?? 0)}|${Math.round(st['leather'] ?? 0)}|${Math.round(st['wood'] ?? 0)}|${Math.round(st['stone'] ?? 0)}|${Math.round(st['ore'] ?? 0)}|${Math.round(st['herb'] ?? 0)}|${Math.round(st['gold'] ?? 0)}|${Math.round(st['components'] ?? 0)}`;
    if (key === this.lastResKey) return; this.lastResKey = key;
    const row = (iconId: string, label: string, val: number) =>
      `<div class="rw-res-row"><span style="display:flex;align-items:center;gap:6px">${svgIcon(iconId, 15)} ${label}</span><b>${Math.round(val)}</b></div>`;
    const dishBadges = cul.dishes.slice(0, 4).map((d) => `${d.def.icon}${(getUiLocale() === 'en' ? d.def.enName.split(' ')[0] : d.def.name.slice(0, 4))}×${d.count}`).join(' ');
    const grainTotal = (st['rice_grain'] ?? 0) + Math.max(st['sweet_corn'] ?? 0, st['corn_sweet'] ?? 0) + (st['wheat_flour'] ?? 0) + (st['potato_tuber'] ?? 0);
    const vegTotal = (st['food'] ?? 0) + Math.max(st['cave_mushroom'] ?? 0, st['glow_mushroom'] ?? 0) + Math.max(st['frost_cabbage'] ?? 0, st['frost_greens'] ?? 0);
    el.innerHTML =
      `<div class="rw-res-top-bar" id="rw-res-toggle-bar" style="cursor:pointer;user-select:none"><span style="display:flex;align-items:center;gap:5px">${svgIcon('shelf', 15)} ${t('殖民地物资总览', 'Colony Resources')}</span><button class="rw-collapse-mini" id="rw-res-collapse-btn">${cl ? '▸' : '▾'}</button></div>` +
      (cl
        ? ''
        : `<div class="rw-res-cat"><div class="rw-res-head" data-rcat="res_cul"><span>${t('特色料理与多元食材', 'Meals & Ingredients')}</span><span>${cCul ? '▸' : '▾'}</span></div>` +
          (cCul
            ? ''
            : `${row('meal', t(`特色料理 (${cul.dishes.length}品)`, `Gourmet Dishes (${cul.dishes.length})`), cul.totalDishes || (st['meal'] ?? 0))}` +
              (dishBadges ? `<div style="font-size:10px;color:#f5d451;padding:1px 4px">${dishBadges}</div>` : '') +
              `${row('rice_grain', t('米面谷物储备', 'Grains & Flour'), grainTotal)}` +
              `${row('meat', t('鲜肉/鱼生/禽蛋', 'Meat, Fish & Eggs'), (st['meat'] ?? 0) + (st['prime_cut'] ?? 0) + (st['fresh_fish'] ?? 0) + (st['poultry_egg'] ?? 0))}` +
              `${row('aromatic_spice', t('香料/奶酪/百花蜜', 'Spices, Cheese & Honey'), (st['aromatic_spice'] ?? 0) + (st['aged_cheese'] ?? 0) + (st['wild_honey'] ?? 0))}` +
              `${row('food', t('果蔬与荧光菌', 'Produce & Glow-Caps'), vegTotal)}` +
              `${row('herb', t('战地草药', 'Herbal Medicine'), st['herb'] ?? 0)}`) +
          `</div>` +
          `<div class="rw-res-cat"><div class="rw-res-head" data-rcat="res_mat"><span>${t('建筑与工业材料', 'Construction Materials')}</span><span>${cMat ? '▸' : '▾'}</span></div>` +
          (cMat ? '' : `${row('wood', t('原木建材', 'Wood Logs'), st['wood'] ?? 0)}${row('stone', t('花岗石块', 'Granite Blocks'), st['stone'] ?? 0)}${row('ore', t('精炼钢铁', 'Steel'), st['ore'] ?? 0)}${row('leather', t('动物毛皮', 'Plainleather'), st['leather'] ?? 0)}`) +
          `</div>` +
          `<div class="rw-res-cat"><div class="rw-res-head" data-rcat="res_lux"><span>${t('精密零件与贵金属', 'Components & Valuables')}</span><span>${cLux ? '▸' : '▾'}</span></div>` +
          (cLux ? '' : `${row('components', t('精密零件', 'Components'), st['components'] ?? 0)}${row('gold', t('黄金储备', 'Gold'), st['gold'] ?? 0)}`) +
          `</div>`); const bar = document.getElementById('rw-res-toggle-bar');
    if (bar) {
      makeModalDraggable(el, bar, 'rw-resource-readout'); bar.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement)?.id === 'rw-res-collapse-btn') return;
        this.collapsedPanels['res'] = !this.collapsedPanels['res']; this.lastResKey = '';
        this.renderResourceReadout(sim);
      });
    }
    document.getElementById('rw-res-collapse-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation(); this.collapsedPanels['res'] = !this.collapsedPanels['res'];
      this.lastResKey = ''; this.renderResourceReadout(sim);
    });
    el.querySelectorAll<HTMLElement>('.rw-res-head[data-rcat]').forEach((hd) => {
      hd.addEventListener('click', (ev) => { ev.stopPropagation(); const k = String(hd.dataset.rcat); this.collapsedPanels[k] = !this.collapsedPanels[k]; this.lastResKey = ''; this.renderResourceReadout(sim); });
    });
  }
  private renderInspectPane(sim: Sim): void {
    const isPwrActive = (this.hooks.getMapOverlayMode?.() ?? 'none') === 'power';
    renderInspectPaneContent( sim,
      [...this.hooks.getSelected()], this.hooks.getSelectedBuilding(),
      this.inspectTab, (tp) => {
        this.inspectTab = tp; this.lastInspectKey = '';
        this.renderInspectPane(sim);
      }, this.lastClickedGround,
      this.lastInspectKey, (k) => (this.lastInspectKey = k),
      (m) => this.showToast(m), () => this.forceRefresh(),
      () => this.toggleMapOverlay('power'), isPwrActive,
      (defId, name) => {
        this.designator = { kind: 'build', defId, name }; this.updateDesignatorBanner();
        this.showToast(t(`🏠 已选择房间内设【${tr(name)}】：请在当前封闭房间内点击放置（右键取消）`, `🏠 Selected [${tr(name)}]: Click inside enclosed room to place`)); this.forceRefresh();
      }, );
  }
  private renderGizmoBar(sim: Sim): void {
    const el = document.getElementById('rw-gizmo-bar'); if (!el) return;
    const sel = [...this.hooks.getSelected()];
    const pawn = sel.length > 0 ? sim.pawn(sel[0]) : [...sim.pawns()].find((p) => !p.isStranger);
    const desigKey = this.designator.kind === 'build'
        ? `b:${this.designator.defId}`
        : this.designator.kind === 'order'
          ? `o:${this.designator.orderKind}`
          : 'none';
    const key = `${getUiLocale()}:${pawn?.eid ?? 0}:${pawn?.drafted ? 1 : 0}:${this.buildRotation}:${desigKey}`;
    if (key === this.lastGizmoKey) return; this.lastGizmoKey = key;
    const gizmos = [
      { id: 'rw-gizmo-draft', cls: pawn?.drafted ? 'active-draft' : '', key: 'R', icon: 'draft', label: pawn?.drafted ? t('解除征召', 'Undraft') : t('征召战斗', 'Draft') },
      { id: 'rw-gizmo-wall', cls: this.designator.kind === 'build' && this.designator.defId === 'wall' ? 'active-desig' : '', key: t('墙', 'W'), icon: 'wall', label: t('建造墙体', 'Build Wall') },
      { id: 'rw-gizmo-door', cls: this.designator.kind === 'build' && this.designator.defId === 'door' ? 'active-desig' : '', key: t('门', 'D'), icon: 'door', label: t('建造房门', 'Build Door') },
      { id: 'rw-gizmo-room', cls: '', key: t('室', 'F'), icon: 'roof', label: t('房间内设', 'Furnish') },
      { id: 'rw-gizmo-mine', cls: this.designator.kind === 'order' && this.designator.orderKind === 'mine' ? 'active-desig' : '', key: t('矿', 'M'), icon: 'mine', label: t('开采矿脉', 'Mine') },
      { id: 'rw-gizmo-chop', cls: this.designator.kind === 'order' && this.designator.orderKind === 'chop' ? 'active-desig' : '', key: t('木', 'C'), icon: 'chop', label: t('砍伐乔木', 'Chop Wood') },
      { id: 'rw-gizmo-decon', cls: this.designator.kind === 'order' && this.designator.orderKind === 'deconstruct' ? 'active-desig' : '', key: t('拆', 'X'), icon: 'deconstruct', label: t('拆除建筑', 'Deconstruct') },
      { id: 'rw-gizmo-ftrade', cls: '', key: t('商', 'T'), icon: 'trade', label: t('商队贸易', 'Trade') },
      { id: 'rw-gizmo-rotate', cls: '', key: 'R', icon: 'rotate', label: `${t('朝向', 'Rot')} ${this.buildRotation * 90}°` },
    ]; el.innerHTML = gizmos
      .map( (g) =>
          `<button class="rw-gizmo ${g.cls}" id="${g.id}"><span class="rw-gizmo-hotkey">${g.key}</span><span class="rw-gizmo-icon">${svgIcon(g.icon, 24)}</span><span class="rw-gizmo-label">${g.label}</span></button>`,
      )
      .join('');
    document.getElementById('rw-gizmo-draft')?.addEventListener('click', () => { if (!pawn) return; setPawnDrafted(sim, sel.length > 0 ? sel : [pawn.eid], !pawn.drafted); this.forceRefresh(); });
    document.getElementById('rw-gizmo-wall')?.addEventListener('click', () => {
      this.designator = { kind: 'build', defId: 'wall', name: t('墙体', 'Wall') };
      this.updateDesignatorBanner(); this.showToast(t('已选择【墙体】：左键点击或按住拖拽连续画墙，右键取消', 'Selected [Wall]: Click or drag to build walls'));
      this.forceRefresh();
    });
    document.getElementById('rw-gizmo-door')?.addEventListener('click', () => {
      this.designator = { kind: 'build', defId: 'door', name: t('房门', 'Door') };
      this.updateDesignatorBanner(); this.showToast(t('已选择【房门】：放置在墙体通道口，右键取消', 'Selected [Door]: Place in wall openings'));
      this.forceRefresh();
    });
    document.getElementById('rw-gizmo-room')?.addEventListener('click', () => { this.openEnclosedRoomInspector(sim); });
    document.getElementById('rw-gizmo-mine')?.addEventListener('click', () => {
      this.designator = { kind: 'order', orderKind: 'mine', label: t('开采矿脉', 'Mine') };
      this.updateDesignatorBanner(); this.showToast(t('已选择【开采矿脉】：点击或拖拽矿石格进行开采', 'Selected [Mine]: Click or drag ore veins'));
      this.forceRefresh();
    });
    document.getElementById('rw-gizmo-chop')?.addEventListener('click', () => {
      this.designator = { kind: 'order', orderKind: 'chop', label: t('砍伐乔木', 'Chop Wood') };
      this.updateDesignatorBanner(); this.showToast(t('已选择【砍伐乔木】：点击或拖拽树木格获取原木', 'Selected [Chop Wood]: Click or drag trees'));
      this.forceRefresh();
    });
    document.getElementById('rw-gizmo-decon')?.addEventListener('click', () => {
      this.designator = { kind: 'order', orderKind: 'deconstruct', label: t('拆除建筑', 'Deconstruct') };
      this.updateDesignatorBanner(); this.showToast(t('已选择【拆除建筑】：点击建筑回收建材', 'Selected [Deconstruct]: Click buildings to salvage materials'));
      this.forceRefresh();
    });
    document.getElementById('rw-gizmo-ftrade')?.addEventListener('click', () => { openFactionTradeModal(sim, undefined, pawn?.eid, (m) => this.showToast(m), () => this.forceRefresh()); });
    document.getElementById('rw-gizmo-rotate')?.addEventListener('click', () => this.rotateBuildOrientation());
  }
  private renderMainDrawer(): void {
    const el = document.getElementById('rw-main-drawer'); const sim = this.hooks.getSim();
    if (!el || !sim) return; if (this.activeTab === 'none') {
      el.hidden = true; return;
    }
    el.hidden = false;
    if (document.activeElement instanceof HTMLInputElement && el.contains(document.activeElement)) return;
    const drawerKey = [ getUiLocale(), this.activeTab,
      this.architectCategory, this.buildRotation,
      isManualWorkPriorityMode() ? 1 : 0, sim.pawnMap.size,
      sim.deadPawnMap.size, sim.world.tagVersionNow(),
      Math.floor(sim.time / 5), ].join('|'); if (drawerKey === this.lastDrawerKey) return;
    this.lastDrawerKey = drawerKey; renderActiveDrawerContent(el, {
      sim, activeTab: this.activeTab,
      architectCategory: this.architectCategory, setArchitectCategory: (cat) => {
        this.architectCategory = cat; this.lastDrawerKey = '';
        this.renderMainDrawer();
      }, buildRotation: this.buildRotation,
      rotateBuildOrientation: () => this.rotateBuildOrientation(), selectBuildDesignator: (defId, name) => {
        this.designator = { kind: 'build', defId, name }; this.updateDesignatorBanner();
        const fp = sim.world.footprint(defId, this.buildRotation); this.showToast(t(`已选择【${tr(name)} (${fp.w}×${fp.h})】`, `Selected [${tr(name)} (${fp.w}×${fp.h})]`));
      }, selectOrderDesignator: (orderKind, label) => {
        this.designator = { kind: 'order', orderKind, label }; this.updateDesignatorBanner();
        this.showToast(t(`已选择【${tr(label)}】`, `Selected [${tr(label)}]`));
      }, centerCameraOn: (x, y) => this.hooks.centerCameraOn(x, y),
      setZoomTilePx: this.hooks.setZoomTilePx, getZoomTilePx: this.hooks.getZoomTilePx,
      onSave: this.hooks.onSave, onLoad: this.hooks.onLoad,
      onNewWorld: this.hooks.onNewWorld, closeDrawer: () => {
        this.activeTab = 'none'; this.lastDrawerKey = '';
        this.syncTabButtons(); this.renderMainDrawer();
      }, showToast: (m) => this.showToast(m),
      forceRefresh: () => this.forceRefresh(), });
  }
  private renderAlerts(sim: Sim): void {
    const el = document.getElementById('rw-alerts-stack'); if (!el) return;
    const alerts: { id: string; level: 'threat' | 'warn'; icon: string; text: string }[] = [];
    const hostiles = sim.hostiles();
    if (hostiles.length > 0) alerts.push({ id: 'hostile', level: 'threat', icon: 'draft', text: t(`敌袭/野生生物：${hostiles.length}`, `Hostiles / Wildlife: ${hostiles.length}`) });
    const wildPawns = [...sim.pawns()].filter((p) => p.formerColonist);
    if (wildPawns.length > 0) alerts.push({ id: 'wild', level: 'warn', icon: 'pawn_ratkin', text: t(`精神崩溃游民：${wildPawns.length} 人 (点击定位)`, `Wild Ex-Colonists: ${wildPawns.length} (Click)`) });
    const corpses = getDeadPawns(sim);
    if (corpses.length > 0) alerts.push({ id: 'corpse', level: 'warn', icon: 'skull', text: t(`未处理尸体：${corpses.length} 具 (点击处理)`, `Unburied Corpses: ${corpses.length} (Click)`) });
    const lowFood = (sim.stockpile['meal'] ?? 0) + (sim.stockpile['food'] ?? 0) < 8;
    if (lowFood) alerts.push({ id: 'food', level: 'warn', icon: 'food', text: t('粮食储备偏低 (建议采收/烹饪)', 'Low Food Reserves (Harvest/Cook)') });
    const recentLogs = sim.events.slice(-4).reverse();
    const key = `${getUiLocale()}|${alerts.map((a) => a.text).join('|')}||${recentLogs.map((l) => `${l.time}:${l.text}`).join('|')}`;
    if (key === this.lastAlertsKey) return; this.lastAlertsKey = key;
    el.innerHTML = localizeHtml(`${alerts.map((a) => `<div class="rw-alert-item rw-alert-${a.level}" data-alert-id="${a.id}" style="display:flex;align-items:center;gap:6px;cursor:pointer">${svgIcon(a.icon, 14)} <span>${a.text}</span></div>`).join('')}<div class="rw-letter-stack">${recentLogs.map((l) => `<div class="rw-letter-envelope"><span class="rw-env-icon">✉</span><span>${tr(l.text)}</span></div>`).join('')}</div>`);
    el.querySelectorAll<HTMLElement>('.rw-alert-item[data-alert-id]').forEach((item) => {
      item.addEventListener('click', () => {
        const aid = item.dataset.alertId; if (aid === 'hostile' && hostiles[0]) {
          this.hooks.centerCameraOn(hostiles[0].pos.x, hostiles[0].pos.y);
          this.showToast(t(`⚔ 已将镜头定位至目标 (${Math.round(hostiles[0].pos.x)}, ${Math.round(hostiles[0].pos.y)})`, `⚔ Centered on target (${Math.round(hostiles[0].pos.x)}, ${Math.round(hostiles[0].pos.y)})`));
        } else if (aid === 'wild' && wildPawns[0]) {
          this.hooks.centerCameraOn(wildPawns[0].pos.x, wildPawns[0].pos.y);
          this.hooks.setSelected([wildPawns[0].eid]); this.forceRefresh();
        } else if (aid === 'corpse' && corpses[0]) {
          this.hooks.centerCameraOn(corpses[0].pos.x, corpses[0].pos.y);
          const actor = [...sim.pawns()].find((p) => !p.isStranger);
          openCorpseLootModal(sim, corpses[0].eid, actor?.eid, (m) => this.showToast(m), () => this.forceRefresh());
        } else if (aid === 'food') { this.openEnclosedRoomInspector(sim); }
      });
    });
  }
  private renderClockAndSpeed(sim: Sim): void {
    const clockEl = document.getElementById('rw-clock-text'); if (!clockEl) return;
    const perfEl = document.getElementById('rw-perf-readout'); if (perfEl && this.hooks.getPerfStats) {
      const st = this.hooks.getPerfStats(); perfEl.textContent = `${Math.round(st.fps)} FPS`;
    }
    const day = Math.floor(sim.time / 120) + 1; const hour = Math.floor(((sim.time % 120) / 120) * 24);
    const paused = this.hooks.getPaused(); const speed = this.hooks.getSpeed();
    const key = `${getUiLocale()}:${day}:${hour}:${paused ? 0 : speed}`; if (key === this.lastClockKey) return;
    this.lastClockKey = key;
    clockEl.textContent = t(`第 ${day} 天 · ${String(hour).padStart(2, '0')}时 · 21°C`, `Day ${day} · ${String(hour).padStart(2, '0')}:00 · 21°C`);
    const cellEl = document.getElementById('rw-cell-inspector');
    if (cellEl && (cellEl.textContent === '悬停地面查看环境信息' || cellEl.textContent === 'Hover over terrain to inspect cell')) {
      cellEl.textContent = t('悬停地面查看环境信息', 'Hover over terrain to inspect cell');
    }
    document.querySelectorAll<HTMLButtonElement>('#rw-speed-controls button').forEach((btn) => { const s = Number(btn.dataset.speed); btn.classList.toggle('active', paused ? s === 0 : s === speed); });
  }
}
