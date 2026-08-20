// HUD 层（DOM 覆盖在 Pixi canvas 之上）
// 设计要点：
//  - 面板骨架一次创建，update 只改 textContent/显隐 → 每帧渲染不销毁按钮
//    （旧版每帧 innerHTML 重建导致"指派职业/发布神谕"按钮在 mousedown/up 之间被替换，点击丢失）
//  - 按钮事件用委托挂在静态容器上（容器永不销毁 → 点击必达）
//  - 样式全部走注入的 CSS 类（不用内联 cssText 满天飞）
import type { BehaviorCardDef } from '../sim/ai/pawn';
import type { SimView } from './remote';
import { DESIRES } from '../sim/core/desires';
import { JOBS, jobLabelOf } from '../sim/defs/jobs';
import { evalStrategyCondition, type StrategyCardDef, type StrategyCtx } from '../sim/defs/strategyCards';
import { weatherLabel } from '../sim/core/env';
import { keybindings, ACTIONS } from './keybindings';
import type { ActionId } from './keybindings';
import { svgDataUri, HUD_SVG, BUILDING_SVG, PAWN_SVG, pawnAssetIdFor } from './svgAssets';
import { K_WORN } from '../sim/mods/contracts';

// 神谕/策略面板展示用冷却/目标时长（RW-1 M1 修订）：仅本地估算展示用——权威闸在
// oracle-guidance 玩法包命令处理器（CFG.cooldownSeconds=45），二者镜像；远程无此面板。
const ORACLE_CFG = { cooldownSeconds: 45 };

// SVG 图标（data URI，DOM <img>）；无素材的 id 回退 emoji
function icon(id: string, size = 16): string {
  const src = HUD_SVG[id];
  if (!src) return id;
  return `<img src="${svgDataUri(src)}" alt="" style="width:${size}px;height:${size}px;vertical-align:-3px;display:inline;">`;
}
// 建筑图标：有 emoji 用 emoji，否则用首字母占位
// 建筑图标：HUD 按钮用 emoji（游戏内瓦片渲染用 SVG，但按钮用 emoji 更简单）
// 2026-08-20 用户裁定：为什么不用 emoji？——直接用，不要搞 SVG 文件。
function buildIcon(def: { id: string; emoji?: string }, _size = 16): string {
  return def.emoji ?? '🏗';
}
// 小人头像：按特质显示不同图标（懒惰/机灵等）
function pawnIcon(traits: readonly string[] | undefined, size = 18): string {
  return `<img src="${svgDataUri(PAWN_SVG[pawnAssetIdFor(traits).replace('pawn:', '')])}" alt="" style="width:${size}px;height:${size}px;vertical-align:-3px;display:inline;border-radius:3px;">`;
}

// 数字格式化：undefined → '-'，否则取整
const nf = (v: number | undefined): string => (v === undefined ? '-' : Math.round(v).toString());

// 注入 HUD CSS 样式（运行时构建，无 .css 文件依赖）
function injectStyle(): void {
  if (document.getElementById('hud-style')) return;
  const st = document.createElement('style');
  st.id = 'hud-style';
  st.textContent = `
.hud{position:fixed;inset:0;z-index:10;pointer-events:none;font:13px system-ui;color:#eee;}
.hud button{pointer-events:auto;border:1px solid #555;background:#333;color:#eee;border-radius:6px;cursor:pointer;font:12px system-ui;padding:5px 9px;}
.hud button:hover{background:#4a4a4a;border-color:#777;}
.hud button.on{background:rgba(68,204,255,.25);border-color:#4cf;}
.hud-panel{pointer-events:auto;background:rgba(0,0,0,.8);border:1px solid #444;border-radius:10px;}
.hud-top{position:absolute;top:0;left:0;right:0;padding:8px 14px;background:rgba(0,0,0,.6);display:flex;gap:18px;align-items:center;font-weight:600;flex-wrap:nowrap;overflow-x:auto;min-height:42px;z-index:12;} /* 顶部资源条单行滚动(2026-08-20 用户反馈菜单重叠:多资源+窄窗换行会把下方 hud 元素顶进重叠区) */
.hud-top .warn{color:#f66;font-weight:700;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.hud-top .warn{animation:blink 1s infinite;}
.hud-bottom{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:6px;pointer-events:auto;flex-wrap:wrap;justify-content:center;max-width:96%;padding:8px;flex-direction:column;align-items:center;}
.hud-buildrow{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-height:200px;overflow-y:auto;}
.hud-group{display:flex;flex-direction:column;gap:2px;align-items:stretch;padding:0 4px;border-left:1px solid #333;}
.hud-group>div:first-child{color:#888;font-size:10px;text-align:center;padding:1px 0;}
.hud-corner{position:absolute;bottom:12px;left:12px;display:flex;gap:4px;pointer-events:auto;padding:6px;}
.hud-corner button{padding:3px 9px;font:12px system-ui;}
.hud-sel{position:absolute;top:60px;left:12px;padding:8px 12px;min-width:180px;display:none;line-height:1.6;}
/* 选中鼠鼠 HUD 立绘（2026-08-15）：头部横排——左侧立绘 + 右侧资料列 */
.hud-sel-head{display:flex;gap:12px;align-items:flex-start;}
#selPortrait{width:104px;height:104px;flex:none;border-radius:10px;border:1px solid #555;background:radial-gradient(circle at 50% 35%,rgba(90,70,50,.85),rgba(20,16,10,.95));box-shadow:0 0 10px rgba(0,0,0,.6);display:none;}
.hud-hint{position:absolute;top:60px;right:12px;padding:6px 10px;font-size:12px;text-align:right;max-width:340px;}
.hud-feed{position:absolute;bottom:12px;right:96px;padding:6px 10px;font-size:11px;line-height:1.5;max-width:220px;text-align:right;}
.hud-feed div{border-top:1px solid #222;}
.hud-center{position:absolute;top:60px;left:50%;transform:translateX(-50%);display:flex;gap:6px;pointer-events:auto;}
.hud-pop{position:absolute;top:120px;z-index:25;left:50%;transform:translateX(-50%);padding:12px 14px;font-size:11px;line-height:1.7;max-width:520px;max-height:60vh;overflow:auto;display:none;}
.hud-card{position:absolute;top:84px;left:50%;z-index:20;transform:translateX(-50%);padding:6px 14px;border:1px solid #a07ac0;background:rgba(70,40,90,.92);border-radius:10px;font-size:12px;display:none;white-space:nowrap;}
.hud-card.visible{display:block;}
.hud-meta{color:#aaa;}
.hud-chip{border-radius:5px;padding:2px 7px;font:11px system-ui;margin-right:4px;}
.hud-jobrow{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0;}
.hud-tag{font-size:11px;}
/* RW-1 M1 修订（2026-08-15）：Work Tab 数字优先级已撤回（用户裁决：直接管理意图进选择链
   违背一切皆抽卡）；神谕/策略面板用普通 hud-pop 列表，不再需要 .hud-work 表格 CSS */
/* 2026-08-20 双端适配（手机 + PC）：
   - 触控目标 >= 44px（Apple 人机指南），按钮大号、间隙加大
   - 窄屏（<=820px）：保留顶部资源条（单行滚动），底部按钮加大、面板全屏化、feed 压缩 */
@media (pointer: coarse) {
  .hud button{min-height:40px;padding:8px 12px;font:13px system-ui;}
  .hud-top{min-height:48px;gap:14px;font-size:14px;padding:8px 10px;}
  .hud-bottom{bottom:6px;gap:8px;padding:10px;}
  .hud-buildrow{gap:8px;}
  .hud-corner{bottom:6px;left:8px;gap:6px;}
  .hud-sel{top:64px;left:8px;min-width:150px;max-width:200px;}
  .hud-pop{max-width:94vw;max-height:65vh;font-size:12px;}
  .hud-feed{bottom:6px;right:8px;max-width:180px;font-size:10px;}
}
@media (max-width: 820px) {
  .hud-top{min-height:44px;padding:6px 8px;gap:10px;}
  .hud button{min-height:34px;}
  .hud-sel{top:52px;max-width:180px;}
  .hud-hint{top:52px;right:8px;max-width:200px;font-size:11px;}
  .hud-center{top:52px;}
  .hud-card{top:70px;font-size:11px;white-space:normal;max-width:92vw;}
  .hud-pop{top:100px;}
  .hud-feed{display:none;} /* 窄屏隐藏 feed（占位给操作按钮）——事件日志可从面板看 */
}
@media (max-width: 480px) {
  .hud-sel{min-width:132px;}
  #selPortrait{width:72px;height:72px;}
}
`;

  document.head.appendChild(st);
}

// 建造菜单分组（按 def tags 归类，保证顺序）
type BuildGroup = '基地' | '防护' | '生产' | '信仰' | '水路' | '其他';
// 按 tag 分组建组（建造面板分组：社交/生产/防御等）
function buildGroup(tags: string[] | undefined): BuildGroup {
  const t = tags ?? [];
  if (t.includes('anchor')) return '基地';
  if (t.includes('barrier')) return '防护';
  if (t.includes('water')) return '水路';
  if (t.some((x) => ['food', 'craft', 'mine'].includes(x))) return '生产';
  if (t.some((x) => ['faith', 'oracle', 'wonder'].includes(x))) return '信仰';
  return '其他';
}
const GROUP_ORDER: BuildGroup[] = ['基地', '防护', '生产', '信仰', '水路', '其他'];

export interface HudApi {
  update(bm: string | null): void;
  closePanels(): void;
  notifyCard(def: BehaviorCardDef): void;
  hint: HTMLElement;
  refreshHint(bm: string | null): void;
  selectedBuilding: { current: { x: number; y: number } | null };
  selectedTile: { current: { x: number; y: number } | null }; // 点选地面(2026-08-20 用户"点击地面能看到地面属性")
  toggleViewMode(): void;
  toggleFold(): void;
  togglePanel(name: 'helpToggle' | 'historyToggle' | 'factionToggle' | 'techsToggle'): void;
  isCapturingKey(): boolean;
}

// 创建 HUD 实例（DOM 构建 + 事件绑定 + 渲染循环入口；本地/远程共用同一 HUD）
export function createHud(
  sim: SimView,
  onSelectBuild: (id: string | null) => void,
  onZoom?: (factor: number) => void,
  onViewMode?: (mode: 'top' | 'iso') => void,
  onJumpTo?: (x: number, y: number) => void,
  onGetTargetHostile?: () => { idx: number } | null,
): HudApi {
  injectStyle();
  const root = document.createElement('div');
  root.className = 'hud';

  // ---- 顶部资源条（图标静态，仅数值每帧更新）----
  const stock = document.createElement('div');
  stock.className = 'hud-top';
  const resItem = (iconId: string, label: string): { el: HTMLElement; val: HTMLElement; img?: HTMLImageElement } => {
    const el = document.createElement('span');
    if (iconId === 'daynight') {
      // daynight 特例：须持有 img 引用（白天/夜晚图标每帧换 src）+ b 值节点。
      // 必须用 innerHTML 建骨架——createTextNode 会把 '<b>' 当纯文本（无元素节点），
      // querySelector('b') 返回 null → val 为 null → 每帧赋值 textContent 时崩溃（曾踩坑）
      el.innerHTML = `<img alt="" style="width:16px;height:16px;vertical-align:-3px;display:inline;"> ${label}<b style="margin-left:2px;"></b>`;
      return { el, val: el.querySelector('b')!, img: el.querySelector('img')! };
    }
    el.innerHTML = `${icon(iconId)}${label}<b style="margin-left:2px;"></b>`;
    return { el, val: el.querySelector('b')! };
  };
  const tTime = resItem('daynight', '');
  const tWeather = resItem('', '');
  const tWood = resItem('wood', '木头');
  const tOre = resItem('ore', '矿');
  const tFood = resItem('food', '食物');
  const tTools = resItem('tools', '');
  const tWater = resItem('water', '水');
  const tPeople = resItem('people', '人');
  const tWarn = document.createElement('span');
  tWarn.className = 'warn';
  tWarn.innerHTML = `${icon('warn', 14)}<b></b>`;
  const warnVal = tWarn.querySelector('b')!;
  for (const r of [tTime, tWeather, tWood, tOre, tFood, tTools, tWater, tPeople]) stock.appendChild(r.el);
  stock.appendChild(tWarn);
  root.appendChild(stock);

  // ---- 策略卡横幅（神谕降旨）----
  const cardNotice = document.createElement('div');
  cardNotice.className = 'hud-card';
  root.appendChild(cardNotice);
  let cardUntil = 0;
  let cardText = '';

  // ---- 底部建造菜单（分组）----
  const buildMenu = document.createElement('div');
  buildMenu.className = 'hud-bottom hud-panel';
  const buildRow = document.createElement('div');
  buildRow.className = 'hud-buildrow';
  const foldBtn = document.createElement('button');
  foldBtn.textContent = '▾ 收起';
  buildMenu.appendChild(buildRow);
  buildMenu.appendChild(foldBtn);
  root.appendChild(buildMenu);
  const groups = new Map<BuildGroup, HTMLElement>();
  for (const g of GROUP_ORDER) {
    const box = document.createElement('div');
    box.className = 'hud-group';
    box.dataset.group = g;
    const label = document.createElement('div');
    label.textContent = g;
    box.appendChild(label);
    buildRow.appendChild(box);
    groups.set(g, box);
  }
  const buildBtns = new Map<string, HTMLButtonElement>();
  function mkBuildBtn(_emoji: string | undefined, label: string, id: string | null): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => onSelectBuild(id));
    return b;
  }
  const cancelBtn = mkBuildBtn('', '取消', null);
  cancelBtn.innerHTML = `${icon('cancel')} 取消`;
  groups.get('基地')!.appendChild(cancelBtn);
  for (const id of Object.keys(sim.mods.buildings)) {
    const d = sim.mods.buildings[id];
    const locked = !!d.tech && !sim.techs?.has(d.tech);
    const btn = mkBuildBtn('', d.name, id);
    btn.innerHTML = `${buildIcon(d)} ${d.name}${locked ? ' 🔒' : ''}`;
    if (locked) {
      btn.disabled = true;
      btn.title = `需科技：${d.tech}（科技抽卡解锁）`;
      btn.style.opacity = '0.45';
    }
    groups.get(buildGroup(d.tags))!.appendChild(btn);
    buildBtns.set(id, btn);
  }
  let folded = false;
  const toggleFold = (): void => {
    folded = !folded;
    buildRow.style.display = folded ? 'none' : '';
    foldBtn.textContent = folded ? '▴ 展开' : '▾ 收起';
  };
  foldBtn.addEventListener('click', toggleFold);

  // ---- 速度条 ----
  const speedBar = document.createElement('div');
  speedBar.className = 'hud-corner hud-panel';
  const speeds = [0, 1, 2, 3];
  const speedBtns = new Map<number, HTMLButtonElement>();
  for (const sp of speeds) {
    const b = document.createElement('button');
    b.textContent = sp === 0 ? '⏸' : `${sp}x`;
    b.dataset.speed = String(sp);
    b.addEventListener('click', () => {
      // 播放控制走命令面（2026-08-20 审计 H1 修复）：此前直改 sim.paused/speed ——
      // 远程模式改的是本地壳，服务器权威不知情 → HUD 谎报暂停/时钟漂移。pause/speed
      // 是引擎内建命令（issueCommand 硬编码分支），本地/远程同一条通道；高亮以权威
      // 字段（远程 = snapshot 回显）为准，命令后 ~500ms diff 周期内可能轻微滞后。
      if (sp === 0) sim.issueCommand({ type: 'pause', x: 0, y: 0, args: { paused: !sim.paused } });
      else sim.issueCommand({ type: 'speed', x: 0, y: 0, args: { speed: sp } });
    });
    speedBar.appendChild(b);
    speedBtns.set(sp, b);
  }
  root.appendChild(speedBar);
  const refreshSpeed = (): void => {
    const cur = sim.paused ? 0 : sim.speed;
    for (const [sp, b] of speedBtns) b.classList.toggle('on', sp === cur);
  };
  refreshSpeed();

  // ---- 缩放 / 视角（右下角）----
  if (onZoom) {
    const zoomBar = document.createElement('div');
    zoomBar.className = 'hud-corner';
    zoomBar.style.right = '240px';
    const mk = (label: string, factor: number): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.fontSize = '14px';
      b.addEventListener('click', () => onZoom(factor));
      zoomBar.appendChild(b);
    };
    mk('＋', 1.2);
    mk('－', 0.8);
    root.appendChild(zoomBar);
  }
  let viewMode: 'top' | 'iso' = 'top';
  let viewBtn: HTMLButtonElement | null = null;
  const toggleViewMode = (): void => {
    viewMode = viewMode === 'top' ? 'iso' : 'top';
    if (viewBtn) viewBtn.textContent = viewMode === 'top' ? '2D 俯视' : '2.5D 同轴';
    onViewMode?.(viewMode);
  };
  if (onViewMode) {
    const viewBar = document.createElement('div');
    viewBar.className = 'hud-corner';
    viewBar.style.right = '12px';
    viewBtn = document.createElement('button');
    viewBtn.addEventListener('click', toggleViewMode);
    viewBtn.textContent = '2D 俯视';
    viewBar.appendChild(viewBtn);
    root.appendChild(viewBar);
  }

  // ---- 选中面板（静态骨架：字段 span + 静态按钮，事件委托）----
  const selPanel = document.createElement('div');
  selPanel.className = 'hud-sel hud-panel';
  selPanel.innerHTML = `
    <div class="hud-sel-head">
      <img id="selPortrait" alt="">
      <div style="flex:1;min-width:0;">
        <div id="selTitle"></div>
        <div id="selBody" class="hud-meta"></div>
        <div id="selJobs" class="hud-jobrow"></div>
        <div id="selDraft" class="hud-jobrow" style="margin-top:4px;"></div>
        <div id="selCmd" class="hud-jobrow" style="margin-top:4px;"></div>
        <div id="selWear" class="hud-jobrow" style="margin-top:4px;"></div>
        <div id="selBeast" class="hud-jobrow" style="margin-top:4px;"></div>
        <div id="selOracle" style="display:none;"><button data-act="oracle" style="border-color:#a07ac0;background:#5a3a6a;">${icon('oracle')} 降策略卡</button></div>
      </div>
    </div>`;
  root.appendChild(selPanel);
  const selTitle = selPanel.querySelector<HTMLElement>('#selTitle')!;
  const selBody = selPanel.querySelector<HTMLElement>('#selBody')!;
  const selJobs = selPanel.querySelector<HTMLElement>('#selJobs')!;
  const selOracle = selPanel.querySelector<HTMLElement>('#selOracle')!;
  const selPortrait = selPanel.querySelector<HTMLImageElement>('#selPortrait')!;
  const selDraft = selPanel.querySelector<HTMLElement>('#selDraft')!;
  const selCmd = selPanel.querySelector<HTMLElement>('#selCmd')!;
  // 职业按钮（一次创建，永不再生）
  const mkJobBtn = (label: string, job: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'hud-chip';
    b.textContent = label;
    b.dataset.act = `job:${job}`;
    selJobs.appendChild(b);
    return b;
  };
  mkJobBtn('自由', '');
  for (const [id, j] of Object.entries(JOBS)) mkJobBtn(j.label, id);
  // 穿衣行（clothing 玩法包 2026-08-15）：update 时按库存重建——库存里所有可穿衣物各一个
  // 按钮 + 已穿时补「脱下」；与职业按钮共用事件委托（act = wear:<itemId>，空 itemId = 脱衣）
  const selWear = selPanel.querySelector<HTMLElement>('#selWear')!;
  const selBeast = selPanel.querySelector<HTMLElement>('#selBeast')!;
  const wearBtn = (label: string, itemId: string | undefined, current: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'hud-chip';
    b.textContent = label;
    b.dataset.act = `wear:${itemId ?? ''}`;
    if (current) b.style.borderColor = '#7ac8a0'; // 当前穿着项高亮
    selWear.appendChild(b);
    return b;
  };
  // 委托：点击由静态面板承接（update 不再重建 → 不丢点击）
  selPanel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act!;
    const eid = Number(selPanel.dataset.eid ?? -1);
    if (act === 'oracle') {
      if (selectedBuildingRef.current) {
        sim.issueCommand({ type: 'oracle', x: selectedBuildingRef.current.x, y: selectedBuildingRef.current.y });
      }
    } else if (act.startsWith('job:')) {
      if (eid >= 0) {
        sim.selected = [eid];
        sim.issueCommand({ type: 'assign', x: 0, y: 0, job: act.slice(4), pawnId: eid });
      }
    } else if (act === 'draft') {
      // RW-1 征召（2026-08-15）：批量开/关征召。以当前小人为基准：已征召 → 解除全部选中，
      // 未征召 → 征召全部选中（RimWorld 群选指挥语义）。batch 由 draft 命令处理器支持
      //（pawnId 缺省 = 走 selected）。
      if (eid >= 0) {
        const drafted = sim.pawnProfile(eid)?.drafted === true;
        sim.selected = [...sim.selectedIds];
        for (const seid of sim.selectedIds) {
          sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: seid, args: { drafted: !drafted } });
        }
      }
    } else if (act === 'fc-train') {
      // 战场指挥 DLC（2026-08-20）：训练战术动作（选中集批量学习；冷却在包命令处理器）
      const tactic = btn.dataset.tactic!;
      for (const seid of sim.selectedIds) {
        sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: seid, args: { tactic } });
      }
    } else if (act === 'fc-dispatch') {
      // 战术下达（指挥官 → 级联全树；集火须先右键敌人设 targetHostileIdx，面板把目标下标
      // 一并带给 dispatch；未选目标时集火按钮仍会触发服务端明确的"需要 hostileIndex"反馈）
      const tactic = btn.dataset.tactic!;
      if (eid >= 0 && sim.pawnProfile(eid)?.commander) {
        const args: Record<string, unknown> = { tactic };
        const th = onGetTargetHostile?.();
        if (tactic === 'focus' && th) args.hostileIndex = th.idx;
        sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: eid, args });
      }
    } else if (act === 'fc-standdown') {
      // 收兵（dispatch 'none'：全树解除征召恢复自主）
      if (eid >= 0 && sim.pawnProfile(eid)?.commander) {
        sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: eid, args: { tactic: 'none' } });
      }
    } else if (act === 'fc-commander') {
      // 册封/编队：基准小人 = 指挥官，其余选中 = 下属（role 自动推导：有队长 → 军团长）
      if (eid >= 0) {
        const subordinates = sim.selectedIds.filter((seid) => seid !== eid);
        sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: eid, args: { subordinates } });
      }
    } else if (act === 'fc-dismiss') {
      // 解编（commander 'none'：清指挥官身份；树内受命小人恢复自主）
      if (eid >= 0 && sim.pawnProfile(eid)?.commander) {
        sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: eid, args: { role: 'none' } });
      }
    } else if (act === 'bt-tame') {
      // 驯兽守卫 DLC：驯化命令（目标敌人 hostileIndex 来自 data-hostile，选中第一人作驯养人）
      const hi = Number(btn.dataset.hostile);
      if (!isNaN(hi) && eid >= 0) sim.issueCommand({ type: 'tame', x: 0, y: 0, pawnId: eid, args: { hostileIndex: hi } });
      else if (!isNaN(hi)) sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: hi } });
    } else if (act === 'bt-release') {
      const hi = Number(btn.dataset.hostile);
      if (!isNaN(hi)) sim.issueCommand({ type: 'release', x: 0, y: 0, args: { hostileIndex: hi } });
    } else if (act.startsWith('wear:')) {
      // 穿衣/换衣/脱衣（itemId 空 = 脱衣）；穿戴逻辑全在 clothing 玩法包命令处理器
      if (eid >= 0) sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: act.slice(5) || undefined } });
    }
  });

  // 选中的建筑（main.ts 维护，HUD 读取）
  const selectedBuildingRef: { current: { x: number; y: number } | null } = { current: null };
  const selectedTileRef: { current: { x: number; y: number } | null } = { current: null };

  // ---- 提示条 ----
  const hint = document.createElement('div');
  hint.className = 'hud-hint hud-panel';
  root.appendChild(hint);

  // ---- 事件 feed（最近 5 条）----
  const feed = document.createElement('div');
  feed.className = 'hud-feed hud-panel';
  root.appendChild(feed);
  // 每帧仅重建纯文本行（无按钮 → innerHTML 安全）
  let lastFeed = '';
  const updateFeed = (): void => {
    const recent = sim.events.slice(-5).map((e) => `${Math.floor(e.time)}s ${e.text}`);
    const html = recent.map((t) => `<div>${t}</div>`).join('');
    if (html !== lastFeed) {
      lastFeed = html;
      feed.innerHTML = html;
    }
  };

  // ---- 帮助 / 历史 / 派系 按钮 + 面板 ----
  const centerBtns = document.createElement('div');
  centerBtns.className = 'hud-center';
  const helpBtn = document.createElement('button');
  helpBtn.innerHTML = `${icon('help')} 操作帮助`;
  const histBtn = document.createElement('button');
  histBtn.innerHTML = `${icon('history')} 历史`;
  const facBtn = document.createElement('button');
  facBtn.innerHTML = `${icon('factions')} 派系`;
  const techBtn = document.createElement('button');
  techBtn.innerHTML = `${icon('card')} 科技`;
  // RW-1 M1 修订（2026-08-15）：神谕/策略面板入口（oracle 图标）——玩家降策略卡引导
  // 工作方向（伐木令/采矿令/垦田令…），一切效果走神谕目标层 + 蓝图副作用 + 插卡（可选）。
  // 远程模式（SimView 无 strategyCards 数据）隐藏：观看模式只读，降旨是单机玩法。
  const oracleBtn = document.createElement('button');
  oracleBtn.innerHTML = `${icon('oracle')} 策略卡`;
  // 远程观看模式（SimView.mods 无 strategyCards 数据源）→ 隐藏（降旨面板是单机玩法）
  if (!('strategyCards' in (sim.mods as unknown as object))) oracleBtn.style.display = 'none';
  centerBtns.append(helpBtn, histBtn, facBtn, techBtn, oracleBtn);
  root.appendChild(centerBtns);

  const helpPanel = document.createElement('div');
  helpPanel.className = 'hud-pop';
  const k = (a: ActionId): string => keybindings.getKeys(a).map((x) => `<b>${keybindings.displayKey(x)}</b>`).join(' / ');
  helpPanel.innerHTML =
    `<b>🐭 infcanvas · 殖民地模拟</b><br>` +
    `👆 <b>鼠标</b>：左键选中小人/建筑 · 右键移动 · 左键拖空白平移 · 滚轮缩放 · 边缘滚动<br>` +
    `📱 <b>触摸</b>：点选 · 长按移动 · 双指拖动/缩放<br>` +
    `⌨️ <b>键盘</b>：${k('pause')} 暂停 · ${k('speed1')}/${k('speed2')}/${k('speed3')} 调速 · ${k('cancel')} 取消/退出建造 · ${k('buildWall')} 建墙 · ${k('viewToggle')} 视角 · ${k('menuFold')} 菜单折叠<br>` +
    `🃏 <b>策略卡=卡池影响项</b>：按局面调节工作方向权重并提示（顶部紫横幅），缺粮垦田、人丁旺拓荒迁徙<br>` +
    `🎴 <b>策略卡面板</b>：点顶部「策略卡」按钮自己发策略卡调节工作（伐木令/采矿令/垦田令…）——只调节权重不指令，小人可能不听；冷却 45s<br>` +
    `🏗 <b>建造菜单</b>：下方按类分组选建筑 → 地图点击放置（绿=可建，红=不可）<br>` +
    `🧠 <b>小人自主</b>：小人自己伐木/采矿/建造/祈祷/疗伤，心情差会违抗安排<br>` +
    `📋 <b>指派职业</b>：选中小人 → 面板按钮指派伐木工/矿工/农民/工匠/渔民（或自由）<br>` +
    `🏕 <b>营地</b>：每个篝火 = 一个营地势力（涌现展示）——篝火记载区域历史（建了啥/遭过袭/谁战死）；同区域的鼠鼠交流篝火见闻、凭听到的事实判断伙伴/敌人；营地屡遭真实损失会迁徙另起篝火。🌍 面板看世界篝火聚居<br>` +
    `⛪ <b>信仰/教堂</b>：信仰高时 AI 建教堂；选教堂点"降策略卡"祝福信众；策略卡=卡池影响项（顶部横幅）<br>` +
    `⚔ <b>威胁</b>：野猫会袭击！建墙保护，受伤要治疗`;
  root.appendChild(helpPanel);
  const histPanel = document.createElement('div');
  histPanel.className = 'hud-pop';
  histPanel.style.maxWidth = '480px';
  root.appendChild(histPanel);
  const facPanel = document.createElement('div');
  facPanel.className = 'hud-pop';
  root.appendChild(facPanel);
  // 🔬 科技面板：已解锁科技 + 下一张候选 + 科技锁建筑清单
  const techPanel = document.createElement('div');
  techPanel.className = 'hud-pop';
  root.appendChild(techPanel);
  const panels = [helpPanel, histPanel, facPanel, techPanel];
  // 历史行点击跳转镜头（委托监听一次，innerHTML 每帧重建也不丢）
  histPanel.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('div[data-x]') as HTMLElement | null;
    if (!row || !onJumpTo) return;
    const x = Number(row.dataset.x);
    const y = Number(row.dataset.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    onJumpTo(x, y);
    toggle(histPanel); // 跳转后收起面板，避免挡视野
  });
  // 2026-08-20 修复「菜单无法收回」：面板右上角加关闭按钮 + 点击面板外关闭
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'position:absolute;top:6px;right:8px;border:none;background:transparent;color:#eee;font-size:16px;cursor:pointer;padding:2px 6px;z-index:30;';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); for (const q of panels) q.style.display = 'none'; });
  const toggle = (p: HTMLElement): void => {
    const show = p.style.display !== 'block';
    // 关闭其他面板
    for (const q of panels) { q.style.display = 'none'; if (q !== p && closeBtn.parentNode === q) q.removeChild(closeBtn); }
    p.style.display = show ? 'block' : 'none';
    // 关闭按钮挂在当前面板（只挂一次）
    if (show && !p.querySelector('.panel-close')) {
      closeBtn.classList.add('panel-close');
      p.style.position = 'relative';
      p.appendChild(closeBtn);
    }
  };
  // 点击面板外区域关闭所有面板（触摸/鼠标通用）
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.hud-pop') || target.closest('.hud-card') || target.closest('.hud-sel') || target.closest('button')) return;
    for (const q of panels) q.style.display = 'none';
  });
  helpBtn.addEventListener('click', () => toggle(helpPanel));
  histBtn.addEventListener('click', () => toggle(histPanel));
  facBtn.addEventListener('click', () => toggle(facPanel));
  techBtn.addEventListener('click', () => toggle(techPanel));
  // 神谕/策略面板（RW-1 M1 修订）：卡片列表 = sim.mods.strategyCards（本地直读；远程无
  // 数据源 → 按钮隐藏）。点击卡 → strategy 命令（降旨）。面板状态行（生效目标/冷却）在
  // update 每帧重建；点击走事件委托（innerHTML 重建不丢）。
  const oraclePanel = document.createElement('div');
  oraclePanel.className = 'hud-pop';
  oraclePanel.style.maxWidth = '560px';
  oraclePanel.style.maxHeight = '70vh';
  root.appendChild(oraclePanel);
  panels.push(oraclePanel);
  let oracleLastIssued = 0; // 冷却本地估算（秒；权威闸在 sim 命令处理器，这里只做展示）
  oracleBtn.addEventListener('click', () => toggle(oraclePanel));
  oraclePanel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-card]');
    if (!btn) return;
    oracleLastIssued = sim.time;
    sim.issueCommand({ type: 'strategy', x: 0, y: 0, pawnId: sim.selectedIds[0], args: { cardId: btn.dataset.card } });
  });
  const togglePanel = (name: 'helpToggle' | 'historyToggle' | 'factionToggle' | 'techsToggle'): void => {
    const map = { helpToggle: helpPanel, historyToggle: histPanel, factionToggle: facPanel, techsToggle: techPanel } as const;
    toggle(map[name]);
  };

  // ---- 更新 ----
  const update = (bm: string | null): void => {
    // 资源条
    const s = sim.stockpile;
    const foodLow = sim.tuning.needs?.foodMoodLow ?? 30;
    const raidWarn = sim.hostiles.length > 0
      ? `袭击！${sim.hostiles.length}${sim.hostiles[0]?.faction === 'unit' ? ' 名掠夺者' : ' 只野猫'}`
      : '';
    const pauseMark = sim.paused ? ' ⏸暂停' : ` ${sim.speed}x`;
    if (tTime.img) tTime.img.src = svgDataUri(HUD_SVG[sim.isNight() ? 'night' : 'day']);
    tTime.val.textContent = `${Math.floor(sim.time / 60)}分${pauseMark}`;
    tWeather.val.textContent = weatherLabel(sim.env, sim.tuning.env);
    tWood.val.textContent = String(s.wood);
    tOre.val.textContent = String(s.ore);
    tFood.val.textContent = String(s.food);
    tTools.val.textContent = String(s.tools ?? 0);
    tWater.val.textContent = String(s.water ?? 0);
    tPeople.val.textContent = String(sim.pawns.length);
    const warnTxt = (s.food < foodLow ? '食物告急!' : '') + (raidWarn ? ` ${raidWarn}` : '');
    warnVal.textContent = warnTxt;
    tWarn.style.display = warnTxt ? '' : 'none';

    // 事件 feed（内容变化时才重绘）
    updateFeed();

    // 播放速度高亮（2026-08-20 审计 H1：按钮点击已改走命令面——本地同步生效，
    // 远程 ~500ms diff 周期回显；每帧读权威字段刷新，杜绝按钮高亮与真实状态漂移）
    refreshSpeed();

    // 建造按钮高亮 + 科技锁定刷新（解锁后即时可建）
    for (const [id, btn] of buildBtns) {
      btn.classList.toggle('on', id === bm);
      const d = sim.mods.buildings[id];
      const locked = !!d.tech && !sim.techs?.has(d.tech);
      if (locked !== btn.disabled) {
        btn.disabled = locked;
        btn.style.opacity = locked ? '0.45' : '';
        btn.innerHTML = `${buildIcon(d)} ${d.name}${locked ? ' 🔒' : ''}`;
      }
    }

    // 策略卡横幅（6s 淡出；仅内容变化时重绘，避免每帧重建 img）
    if (cardUntil > 0) {
      if (cardNotice.dataset.last !== cardText) {
        cardNotice.innerHTML = cardText;
        cardNotice.dataset.last = cardText;
      }
      cardNotice.classList.add('visible');
      if (performance.now() > cardUntil) {
        cardUntil = 0;
        cardNotice.classList.remove('visible');
      }
    }

    // 选中面板
    if (selectedBuildingRef.current) {
      const b = sim.buildingAt(selectedBuildingRef.current.x, selectedBuildingRef.current.y);
      if (!b) { selectedBuildingRef.current = null; return; }
      const def = b.def;
      // 派系 = 涌现展示（2026-08-14 重构）：篝火区域记忆 + 归属该火的小人，无库存/看法
      const selKey = selectedBuildingRef.current.y * sim.world.width + selectedBuildingRef.current.x;
      const unit = sim.factionsView().find((f) => f.key === selKey);
      selPanel.dataset.eid = '-1';
      selPortrait.style.display = 'none'; // 建筑选中：不显示鼠鼠立绘
      selJobs.style.display = 'none';
      selOracle.style.display = def.capabilities?.includes('oracle') ? '' : 'none';
      selTitle.innerHTML = `<b>${buildIcon(def ?? { id: b.defId })} ${def?.name ?? b.defId}</b> (${selectedBuildingRef.current.x},${selectedBuildingRef.current.y})`;
      selBody.innerHTML =
        `耐久 ${nf(b.hp)}/${b.maxHp}<br>` +
        (unit
          ? `${icon('factions')} <b>${unit.label}</b> 营地 · ${unit.members.length} 人归属<br>` +
            `成员：#${unit.members.join('、') || '无'}<br>` +
            `记忆：${unit.memory.slice(-2).map((m) => m.text).join(' / ') || '暂无'}`
          : def.tags?.includes('anchor')
            ? '🔥 篝火（暂无归属者）'
            : '');
      selPanel.style.display = 'block';
      return;
    }

    // 点选地面:显示地形属性(2026-08-20 用户"地面需要有属性/点击地面能看到")——
    // TileDef 属性现成(id/name/z/passable/buildable/moveCost/mineral/growable/shelter/harvest),只缺展示
    if (selectedTileRef.current) {
      const { x, y } = selectedTileRef.current;
      const tid = sim.world.getTile(x, y);
      const d = sim.mods.tiles[tid];
      if (d) {
        selPanel.dataset.eid = '-1';
        selPortrait.style.display = 'none';
        selJobs.style.display = 'none';
        selOracle.style.display = 'none';
        selTitle.innerHTML =
          `<b>${d.emoji ? d.emoji + ' ' : ''}${d.name}</b> (${x},${y}) <span style="color:#888">${d.id}</span>`;
        const yes = '<span style="color:#8d8">✓</span>';
        const no = '<span style="color:#d88">✗</span>';
        let body =
          `可通行 ${d.passable ? yes : no} · 可建造 ${d.buildable ? yes : no} · 移动代价 ${d.moveCost ?? 1}<br>` +
          `高度 ${d.z ?? 0}${d.shelter ? ' · 🏕 天然庇护' : ''}${d.mineral ? ' · ⛏ 矿' : ''}${d.growable ? ' · 🌱 可采集' : ''}`;
        const hv = d.harvest;
        if (hv) {
          const prod = hv.product ? `→ ${sim.mods.items[hv.product]?.name ?? hv.product}` : '';
          body += `<br>🧺 采集：${hv.time ?? 1}s · ${hv.dc ?? '-'} 检定 · 得 ${hv.yieldSuccess ?? 1}${
            hv.yieldFail !== undefined ? `（失败 ${hv.yieldFail}）` : ''} ${prod}`;
          if (d.harvestReplaces) body += `；采后变 ${d.harvestReplaces}`; // harvestReplaces 在 TileDef(不在 HarvestDef)
        }
        selBody.innerHTML = body;
        selPanel.style.display = 'block';
        return;
      }
      selectedTileRef.current = null; // 未知地形(动态生成/越界):清状态回退
    }

    // 📜 结构化历史（DESIGN §3 仿真日志）
    // UIUX 2026-08-14：行内嵌坐标 data 属性，点击整行跳转镜头（委托一次监听）
    if (histPanel.style.display === 'block') {
      const rows = sim.historyRecent.map((h) => {
        const where = h.x !== undefined ? `@(${h.x},${h.y})` : '';
        const who = h.eid !== undefined ? `#${h.eid}` : '';
        const detail = h.data ? ' ' + Object.entries(h.data).map(([k, v]) => `${k}=${v}`).join(' ') : '';
        const cause = h.cause ? ` [${h.cause}]` : '';
        const nav = h.x !== undefined && onJumpTo ? ' 📍跳转' : '';
        return `<div data-x="${h.x ?? ''}" data-y="${h.y ?? ''}">D${h.day} ${h.time}s · ${h.type} ${who}${where}${cause}${detail}${nav}</div>`;
      });
      histPanel.innerHTML = `<b>📜 结构化历史（仿真日志，点击带 📍 的行跳转镜头）</b><br>` + rows.join('');
    }

    // 🌍 派系概览（2026-08-14 用户裁决：派系 = 涌现展示，按篝火归属聚合；无库存/贸易/战争）
    if (facPanel.style.display === 'block') {
      const units = sim.factionsView();
      const rows = units.map((u) => {
        const mem = u.memory.slice(-2).map((m) => m.text).join(' / ') || '无';
        const members = u.members.map((e) => `#${e}`).join('、') || '无';
        return `<div>🔥 <b>${u.label}</b> 营地 · ${u.members.length} 人归属<br>` +
          `<span style="color:#aaa">成员：${members}<br>记忆：${mem}</span></div>`;
      }).join('<hr>');
      facPanel.innerHTML = `<b>🌍 篝火聚居（${units.length}）</b><br>` + (rows || '暂无营地');
    }

    // 🔬 科技面板：已解锁 / 碎片进度（2026-08-14 碎片制：攒齐 N 块碎片组成整卡） / 科技锁建筑
    if (techPanel.style.display === 'block') {
      const techs = sim.techs;
      const frags = sim.techFragments; // 已集碎片（单机有；远端缺省 undefined → 只显已解锁）
      const lockedBuildings = Object.values(sim.mods.buildings)
        .filter((b) => b.tech && !techs?.has(b.tech))
        .map((b) => `${b.emoji ?? '🏗'} ${b.name}（需科技）`);
      const unlockedRows = techs && techs.size > 0
        ? [...techs].map((id) => {
          const t = sim.techsMap?.[id];
          return `<div>✅ ${t?.name ?? id}${t?.desc ? ` <span style="color:#aaa">${t.desc}</span>` : ''}</div>`;
        }).join('')
        : '<div style="color:#aaa">尚未解锁科技（碎片抽卡池会不定期发放碎片）</div>';
      // 碎片进度行：未解锁科技 已集/所需（如 🔩 取水术 2/3）；无碎片接口（远端）跳过
      const techMap = sim.techsMap;
      const fragmentRows = frags && techMap
        ? Object.keys(techMap)
          .filter((id) => !techs?.has(id) && (frags[id] ?? 0) > 0)
          .map((id) => {
            const t = techMap[id];
            return `<div>🔩 ${t.name} 碎片 ${frags[id] ?? 0}/${t.fragments ?? 1}</div>`;
          }).join('')
        : '';
      techPanel.innerHTML =
        `<b>🔬 科技（${techs?.size ?? 0}/${Object.keys(sim.techsMap ?? {}).length}）</b><br>` +
        unlockedRows +
        (fragmentRows ? `<br><b>🔩 碎片收集：</b><br>${fragmentRows}` : '') +
        (lockedBuildings.length > 0 ? `<br><b>🔒 未解锁建造：</b>${lockedBuildings.join('、')}` : '');
    }

    // 🎴 策略卡面板（RW-1 M1 修订；2026-08-20 更名：不叫神谕——它只是卡池影响项,调节权重不裁决）：生效目标 + 冷却 + 可发策略卡列表。
    // 卡片表 = sim.mods.strategyCards（本地注册表直读；远程无数据 → 按钮已隐藏，面板不渲染）。
    // 可用态 = evalStrategyCondition（SimView 字段组 slim ctx，见 StrategyCtx）。
    if (oraclePanel.style.display === 'block') {
      const ox = sim as unknown as { oracleGoal?: { workType?: string; label: string; until: number } | null; time?: number } | null;
      const goal = ox?.oracleGoal ?? null;
      const goalRow = goal
        ? `🕯 生效目标：<b>${goal.label}</b>（${goal.workType ?? '无工作加成'}，剩余 ${nf(Math.max(0, goal.until - (ox?.time ?? 0)))}s）`
        : '🕯 当前无策略卡影响（小人全自主）';
      const cooling = Math.max(0, ORACLE_CFG.cooldownSeconds - (sim.time - oracleLastIssued));
      const coldRow = cooling > 0
        ? `<span style="color:#caa">冷却中（${nf(cooling)}s 后可再降旨）</span>`
        : '冷却就绪，可降旨';
      const cards = (sim as unknown as { mods?: { strategyCards?: StrategyCardDef[] } }).mods?.strategyCards ?? [];
      // slim ctx：SimView 各字段与 SimContext 形状不同（world/tuning 是轻量视图），
      // 运行时字段齐全（本地模式），类型经 unknown 收窄——eval 只读这些字段。
      const cardCtx = {
        stockpile: sim.stockpile,
        world: sim.world,
        pawnList: sim.pawns,
        buildQueue: sim.buildQueueItems,
        isNight: () => sim.isNight(),
        tuning: sim.tuning,
      } as unknown as StrategyCtx;
      const oracleGoalMul = ((sim.tuning as unknown as { card?: { oracleGoalMul?: number } }).card?.oracleGoalMul ?? 3);
      const rows = cards.map((c) => {
        const ready = evalStrategyCondition(cardCtx, c.condition);
        const effect = c.workType
          ? `工作：抽卡权重 ${c.workType}×${oracleGoalMul}（引导非指令）`
          : '叙事（无权重加成）';
        const bp = c.blueprint
          ? ` + 蓝图：${sim.mods.buildings[c.blueprint.defId]?.name ?? c.blueprint.defId}`
          : '';
        const selNote = sim.selectedIds.length > 0 ? '（会给你选中的小人发目标卡）' : '';
        return `<button data-card="${c.id}" ${ready ? '' : 'disabled style="opacity:.45"'} title="${
          ready ? '降下' : '局面未满足条件（如缺粮/缺资源）'
        }">${c.label}</button> ${c.reason ?? ''} <span style="color:#888">${effect}${bp}${selNote}</span><br>`;
      }).join('');
      oraclePanel.innerHTML =
        `<b>🎴 策略卡（卡池影响项）</b> · 按局面调节工作方向权重（小人可抽不到/可违抗；<br>冷却 ${ORACLE_CFG.cooldownSeconds}s 防遥控）<br>` +
        `<span style="color:#9cf">${goalRow}</span><br><span>${coldRow}</span><br>` +
        (rows || '<span style="color:#888">暂无策略卡</span>');
    }

    const sel = sim.selectedIds;
    if (sel.length > 0) {
      selectedTileRef.current = null; // 小人选中优先,清地面点选(互斥:点小人后地面面板不残留)
      const eid = sel[0];
      const p = sim.pawnProfile(eid);
      if (p) {
        selPanel.dataset.eid = String(eid);
        // 立绘（2026-08-15）：按天赋变体放大显示，作为选中鼠鼠的头像图
        selPortrait.src = svgDataUri(PAWN_SVG[pawnAssetIdFor(p.dna.traits).replace('pawn:', '')]);
        selPortrait.style.display = '';
        selJobs.style.display = '';
        selWear.style.display = '';
        selOracle.style.display = 'none';
        // 穿衣行内容（clothing 玩法包）：库存可穿衣物按钮 + 脱下按钮（已穿时）；
        // 远程端 worn 经 RemoteSim.wornOf（快照字段），本地端读 pawnStates 存档扩展点
        const wearSim = sim as { wornOf?: (e: number) => string | undefined; pawnStates?: Map<number, { extra?: Record<string, unknown> }> };
        const localWorn = wearSim.pawnStates?.get(eid)?.extra?.[K_WORN];
        const wornNow = (localWorn as { body?: string } | undefined)?.body ?? wearSim.wornOf?.(eid);
        selWear.innerHTML = '';
        const wearable = Object.values(sim.mods.items ?? {}).filter((it) => it.meta?.wearable && (sim.stockpile[it.id] ?? 0) > 0);
        if (wornNow) {
          const wName = sim.mods.items[wornNow]?.name ?? wornNow;
          wearBtn(`脱下${wName}`, undefined, true);
        }
        for (const it of wearable) wearBtn(`${it.name}${(sim.stockpile[it.id] ?? 0) > 1 ? ` ×${sim.stockpile[it.id]}` : ''}`, it.id, wornNow === it.id);
        if (!wornNow && wearable.length === 0) {
          selWear.innerHTML = '<span style="color:#777;font-size:11px;">🪡 衣橱空（做衣服或织布后可用）</span>';
        }
        // RW-1 征召行（2026-08-15）：征召/解除征召按钮（选中组批量为基准小人的状态）。
        // drafted = "不自主行事，听你指挥"（右键敌人 = 攻击，移动命令仍有效）
        const draftedNow = p.drafted === true;
        selDraft.innerHTML = `<button data-act="draft" style="${draftedNow ? 'border-color:#ffd24c;background:#5a4a16;' : ''}">${draftedNow ? '☮ 解除征召' : '⚔ 征召'}</button>` +
          (draftedNow ? '<span style="color:#ffd24c;font-size:11px;"> 征召中：不自主行事（右键敌人 = 攻击）</span>' : '');
        // 战场指挥 DLC（2026-08-20）：指挥行——（a）选中集可册封指挥官（基准小人 + 其余选中
        // = 编组，role 自动推导多层级别）；（b）指挥官：战术下发（冲锋/固守/集火/撤退/集结
        // → dispatch 级联整树）+ 收兵/解编；（c）任意小人可训练战术（冷却在包命令处理器）
        // 驯兽守卫 DLC（2026-08-20）：目标敌人行（驯化/放归）
        const th = onGetTargetHostile?.();
        selBeast.innerHTML = '';
        if (th) {
          const hh = sim.hostiles[th.idx];
          if (hh) {
          const canTame = hh.enemyId === 'cat' && hh.maxHp > 0 && hh.hp / hh.maxHp <= 0.25 && !hh.taming && hh.faction !== 'player';
          const isTaming = !!hh.taming;
          const isTamed = hh.faction === 'player';
          selBeast.innerHTML =
            `<span style="color:#ffa64c;font-size:11px;">🐱 目标：${hh.name ?? '野猫'} (${Math.round(hh.hp)}/${Math.round(hh.maxHp)}hp)</span>` +
            (isTaming ? `<span style="color:#ffd24c;font-size:11px;">驯化中 ${Math.round(hh.taming!.progress / 20 * 100)}%</span> ` : '') +
            (isTamed ? '<span style="color:#4cf;font-size:11px;">营地守卫</span> ' : '') +
            (canTame ? `<button data-act="bt-tame" data-hostile="${th.idx}" style="font-size:11px;padding:1px 5px;border-color:#4cf;">🪤 驯化</button> ` : '') +
            (isTaming || isTamed ? `<button data-act="bt-release" data-hostile="${th.idx}" style="font-size:11px;padding:1px 5px;border-color:#b55;">🪝 放归</button>` : '');
          }
        }
        const fcCmdr = p.commander;
        const fcTactic = p.tactic;
        selCmd.innerHTML = '';
        if (fcCmdr) {
          const roleName = fcCmdr.role === 'general' ? '🏳 军团长' : '⚔ 队长';
          selCmd.innerHTML = `<span style="color:#ffa64c;font-size:11px;">${roleName} #${eid}（编组 ${fcCmdr.subordinates.length} 人）</span><br>` +
            ['charge', 'hold', 'focus', 'retreat', 'regroup'].map((tid) =>
              `<button data-act="fc-dispatch" data-tactic="${tid}" style="font-size:11px;padding:1px 5px;${fcTactic === tid ? 'border-color:#ffd24c;background:#5a4a16;' : ''}">${fcTactic === tid ? '◉' : ''}${tid}</button>`).join('') +
            `<button data-act="fc-standdown" style="font-size:11px;padding:1px 5px;border-color:#999;">☮ 收兵</button>` +
            `<button data-act="fc-dismiss" style="font-size:11px;padding:1px 5px;border-color:#b55;">解编</button>` +
            (fcTactic ? `<br><span style="color:#ffd24c;font-size:11px;">现行战术：${fcTactic}（受命小人征召中）</span>` : '');
        } else {
          selCmd.innerHTML =
            `<button data-act="fc-commander" style="font-size:11px;padding:1px 5px;border-color:#ffa64c;">${icon('oracle')} 册封指挥官（选中集编组）</button> ` +
            `<span style="color:#888;font-size:10px;">训练：</span>` +
            ['charge', 'hold', 'focus', 'retreat', 'regroup'].map((tid) =>
              `<button data-act="fc-train" data-tactic="${tid}" style="font-size:11px;padding:1px 5px;">${tid}</button>`).join('');
        }
        const nd = p.needs;
        const hk = p.health;
        const slotCards = p.slots.filter((c) => c !== null).map((c) => (c!.mastery ?? 0) > 0 ? `${c!.name}×${c!.mastery}` : c!.name).join('、') || '无';
        const dec = p.lastDecision ? `闪念：[${p.lastDecision.drawn.join(' | ')}] → 选了【${p.lastDecision.picked}】` : '';
        selTitle.innerHTML =
          `<b>${pawnIcon(p.dna.traits)} 小人 ${eid}</b> (${Math.round(p.pos.x)},${Math.round(p.pos.y)})<br>` +
          `<span style="color:#4cf">工作：${p.job || '闲逛'}</span>` +
          (p.assignedJob ? `<br><span style="color:#9cf">指派：${jobLabelOf(p.assignedJob)}</span>` : '') +
          // RW-1 M1 修订：身上策略卡/目标卡（slots 中 id 以 strategy: 前缀者，神谕指引插卡）。
          // 替代旧 Work Tab 优先级摘要（已撤回——玩家工作影响只走策略卡/神谕目标，见 RW_SPRINT2）
          (() => {
            const strat = p.slots.filter((c) => c !== null && c!.id.startsWith('strategy:'));
            const label = strat.map((c) => (c!.mastery ?? 0) > 0 ? `${c!.name}×${c!.mastery}` : c!.name).join('、');
            return label
              ? `<br><span style="color:#caa">🃏 身上策略卡：${label}</span>`
              : `<br><span style="color:#888">身上策略卡：无</span>`;
          })();
        selBody.innerHTML =
          `HP ${nf(hk?.hp)}/${nf(hk?.maxHp)} · 信仰 ${nf(p.faith)}<br>` +
          `STR ${p.dna.str} · CON ${p.dna.con} · SIZ ${p.dna.siz} · DEX ${p.dna.dex}<br>` +
          `INT ${p.dna.int} · POW ${p.dna.pow} · APP ${p.dna.app} · EDU ${p.dna.edu}<br>` +
          `天赋：${p.dna.traits.join('、') || '无'}<br>` +
          `卡池 ${p.slots.filter((c) => c !== null).length} 张（槽 ${p.dna.maxSlots}）：${slotCards}<br>` +
          `技能：工作 ${p.skills.work ?? 0} · 战斗 ${p.skills.fight ?? 0} · 手艺 ${p.skills.craft ?? 0} · 社交 ${p.skills.social ?? 0} · 信仰 ${p.skills.faith ?? 0}<br>` +
          `欲望：${Object.entries(DESIRES).map(([k, { label }]) => `${label}${nf(p.desires[k])}`).join(' ')}<br>` +
          (dec ? `<span style="color:#caa">${dec}</span><br>` : '') +
          (nd ? `饥饿 ${nf(nd.food)} · 精力 ${nf(nd.rest)} · 心情 ${nf(nd.mood)} · 理智 ${nf(nd.san)}` : '') +
          (p.oracleBuff && p.oracleBuff.until > sim.time ? `<br><span style="color:#e0b0ff">✨ 受策略卡影响（心情+）</span>` : '') +
          ((p.expectEarn ?? 0) > 0 || (p.expectSpend ?? 0) > 0
            ? `<br><span style="color:#9cf">预期赚 ${nf(p.expectEarn)} / 花 ${nf(p.expectSpend)}</span>`
            : '');
        selPanel.style.display = 'block';
        return;
      }
    }
    selPanel.style.display = 'none';
  };

  // 提示条文本单独更新（不随每帧，仅在建造模式变化时）
  const refreshHint = (bm: string | null): void => {
    hint.textContent = bm ? `建造【${sim.buildingDef(bm)?.name ?? bm}】——点击地图放置（绿=可建，红=不可）` : '';
  };

  // ---- 键位设置面板（改键）----
  // 帮助面板底部入口；捕获按键用 capture-phase 监听，阻止 main 的分发（避免改键时误触动作）
  const keysBtn = document.createElement('button');
  keysBtn.innerHTML = `${icon('keys')} 自定义按键…`;
  keysBtn.style.marginTop = '8px';
  helpPanel.appendChild(keysBtn);
  const keysPanel = document.createElement('div');
  keysPanel.className = 'hud-pop';
  keysPanel.style.maxWidth = '380px';
  root.appendChild(keysPanel);
  panels.push(keysPanel);
  let capturing: { action: ActionId; row: HTMLElement } | null = null;
  const captureListener = (e: KeyboardEvent): void => {
    if (!capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      capturing = null;
      renderKeysPanel();
      return;
    }
    const k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keybindings.bind(capturing.action, k);
    capturing = null;
    renderKeysPanel();
  };
  window.addEventListener('keydown', captureListener, true);
  const renderKeysPanel = (): void => {
    const rows = (Object.keys(ACTIONS) as ActionId[]).map((id) => {
      const label = ACTIONS[id];
      const chips = keybindings.getKeys(id).map((k) =>
        `<button class="hud-chip" data-unbind="${id}" data-key="${k}" title="移除">${keybindings.displayKey(k)} ×</button>`,
      ).join('');
      const capture = capturing?.action === id
        ? ' <span style="color:#4cf">按新键…（Esc 取消）</span>'
        : `<button class="hud-chip" data-capture="${id}">改</button>`;
      return `<div data-actrow="${id}" style="display:flex;align-items:center;gap:6px;margin:3px 0;"><span style="width:120px;display:inline-block;">${label}</span><span>${chips}</span>${capture}</div>`;
    });
    keysPanel.innerHTML =
      `<b>${icon('keys')} 自定义按键</b>（点击 改 → 按新键；× 移除单键；Ctrl/Alt/Shift 组合不响应）<br>` +
      rows.join('') +
      `<button data-reset-keys style="margin-top:6px;">↺ 恢复默认</button>`;
  };
  keysPanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cap = target.closest<HTMLElement>('button[data-capture]');
    if (cap) {
      capturing = { action: cap.dataset.capture as ActionId, row: cap.parentElement as HTMLElement };
      renderKeysPanel();
      return;
    }
    const unb = target.closest<HTMLElement>('button[data-unbind]');
    if (unb) {
      keybindings.unbind(unb.dataset.unbind as ActionId, unb.dataset.key!);
      return;
    }
    if (target.closest('[data-reset-keys]')) {
      keybindings.reset();
      return;
    }
  });
  keysBtn.addEventListener('click', () => { renderKeysPanel(); toggle(keysPanel); });
  keybindings.onChange(() => { if (keysPanel.style.display === 'block') renderKeysPanel(); });

  document.body.appendChild(root);

  return {
    update,
    closePanels(): void {
      for (const p of panels) p.style.display = 'none';
      selPanel.style.display = 'none';
    },
    notifyCard(def: BehaviorCardDef): void {
      cardText = `${icon('card')} 策略卡（卡池影响项）：<b>${def.label}</b>${def.reason ? `（${def.reason}）` : ''}`;
      cardUntil = performance.now() + 6000;
    },
    hint,
    refreshHint,
    selectedBuilding: selectedBuildingRef,
    selectedTile: selectedTileRef,
    toggleViewMode,
    toggleFold,
    togglePanel,
    isCapturingKey: () => capturing !== null,
  };
}
