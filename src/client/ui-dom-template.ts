/**
 * client/ui-dom-template.ts —— RimWorld 1.5 原版风格根 UI DOM 骨架模板（内置 i18n 双语支持）：
 *  - 顶部：殖民者肖像编组栏（支持动态新建自定义编组）；
 *  - 左上：分类折叠物资栏；
 *  - 左下：RimWorld 标志性检视窗（含身体部位健康面板 + 装备/武器面板 + 电网负荷高亮检视）；
 *  - 右下：RimWorld 原版无框悬浮信息读数 + 小图标开关行（含 `🌐 中文/EN` 语言切换） + 时间速度按钮组 (`‖`, `▶`, `▶▶`, `▶▶▶`)；
 *  - 底部：精简纯粹的 RimWorld 主标签栏。
 */
import { getUiLocale, t } from './i18n';
import { svgIcon } from './ui-icons';

export function createRootDomHtml(): string {
  const isEn = getUiLocale() === 'en';
  return `
    <div id="rw-colonist-bar-wrap">
      <button id="rw-toggle-colonist" class="rw-collapse-pill">${t('▾ 殖民者顶栏', '▾ Colonists')}</button>
      <div id="rw-colonist-bar" class="rw-panel-strip"></div>
    </div>
    <div id="rw-resource-readout" class="rw-bevel-box"></div>
    <div id="rw-designator-banner" hidden></div>
    <div id="rw-alerts-wrap">
      <button id="rw-toggle-alerts" class="rw-collapse-pill">${t('▾ 信封与警报', '▾ Letters & Alerts')}</button>
      <div id="rw-alerts-stack"></div>
    </div>
    <div id="rw-inspect-wrap">
      <div id="rw-inspect-top-bar" style="cursor:grab;user-select:none">
        <div id="rw-inspect-tabs"></div>
        <button id="rw-toggle-inspect" class="rw-collapse-pill">${t('▾ 检视面板', '▾ Inspect')}</button>
      </div>
      <div id="rw-inspect-body">
        <div id="rw-floor-pane" class="rw-bevel-box" style="margin-bottom:5px;padding:7px 10px"></div>
        <div id="rw-inspect-pane" class="rw-bevel-box"></div>
      </div>
    </div>
    <div id="rw-gizmo-wrap">
      <button id="rw-toggle-gizmos" class="rw-collapse-pill">${t('▾ 快捷指令栏', '▾ Gizmos')}</button>
      <div id="rw-gizmo-bar"></div>
    </div>
    <div id="rw-main-drawer" class="rw-bevel-box" hidden></div>
    <div id="rw-corpse-modal" class="rw-modal-backdrop" hidden></div>
    <div id="rw-bottom-right">
      <div id="rw-br-readouts">
        <div id="rw-cell-inspector">${t('悬停地面查看环境信息', 'Hover over terrain to inspect cell')}</div>
        <div id="rw-clock-readout">
          <span id="rw-clock-text">${t('第 1 天 · 00:00', 'Day 1 · 00:00')}</span>
          <span id="rw-perf-readout">60 FPS</span>
        </div>
      </div>
      <div id="rw-overlay-toggles">
        <button id="rw-lang-toggle" class="rw-br-icon-btn" title="${t('切换界面语言：简体中文 / English (快捷键 L)', 'Switch UI Language: 简体中文 / English (Hotkey L)')}">${isEn ? '🌐 EN' : '🌐 中文'}</button>
        <button class="rw-br-icon-btn" data-ovmode="fertility" title="${t('土壤肥力叠加层', 'Soil Fertility Overlay')}">${svgIcon('fertility', 14)}</button>
        <button class="rw-br-icon-btn" data-ovmode="roof" title="${t('屋顶与室内叠加层 (≤13×13封顶)', 'Roof & Indoor Overlay (≤13×13)')}">${svgIcon('roof', 14)}</button>
        <button class="rw-br-icon-btn" data-ovmode="power" title="${t('电网负荷与电缆叠加层', 'Power Grid Overlay')}">${svgIcon('power', 14)}</button>
      </div>
      <div id="rw-speed-controls" role="group" aria-label="${t('时间速度控制', 'Time Speed Controls')}">
        <button data-speed="0" id="rw-spd-0" title="${t('暂停时间 (Space)', 'Pause (Space)')}">‖</button>
        <button data-speed="1" id="rw-spd-1" title="${t('1x 正常速度 (按键 1)', '1x Normal Speed (Key 1)')}">▶</button>
        <button data-speed="3" id="rw-spd-3" title="${t('2x 快进速度 (按键 2)', '2x Fast Speed (Key 2)')}">▶▶</button>
        <button data-speed="8" id="rw-spd-8" title="${t('3x 极速推进 (按键 3)', '3x Ultrafast Speed (Key 3)')}">▶▶▶</button>
      </div>
    </div>
    <div id="rw-main-tabbar">
      <button class="rw-tab-btn" data-tab="architect">${svgIcon('architect', 15)} <span data-i18n-tab="architect">${t('建筑规划', 'Architect')}</span></button>
      <button class="rw-tab-btn" data-tab="work">${svgIcon('work', 15)} <span data-i18n-tab="work">${t('工作指派', 'Work')}</span></button>
      <button class="rw-tab-btn" data-tab="schedule">${svgIcon('schedule', 15)} <span data-i18n-tab="schedule">${t('日程管制', 'Schedule')}</span></button>
      <button class="rw-tab-btn" data-tab="groups">${svgIcon('groups', 15)} <span data-i18n-tab="groups">${t('小队行囊', 'Squads')}</span></button>
      <button class="rw-tab-btn rw-tab-accent" data-tab="world_mmo">${svgIcon('trade', 15)} <span data-i18n-tab="world_mmo">${t('派系外交', 'Factions')}</span></button>
      <button class="rw-tab-btn rw-tab-dlc" data-tab="dlc">${svgIcon('dlc', 15)} <span data-i18n-tab="dlc">${t('DLC与存档', 'DLC & Saves')}</span></button>
      <button class="rw-tab-btn" data-tab="help">${svgIcon('help', 15)} <span data-i18n-tab="help">${t('百科指南', 'Wiki Guide')}</span></button>
    </div>
    <div id="rw-float-menu" class="rw-bevel-box" hidden></div>
    <div id="rw-toast"></div>
  `;
}
