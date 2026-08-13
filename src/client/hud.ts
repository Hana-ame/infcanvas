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
import { weatherLabel } from '../sim/core/env';
import { keybindings, ACTIONS } from './keybindings';
import type { ActionId } from './keybindings';
import { svgDataUri, HUD_SVG, BUILDING_SVG, PAWN_SVG, pawnAssetIdFor } from './svgAssets';

// SVG 图标（data URI，DOM <img>）；无素材的 id 回退 emoji
function icon(id: string, size = 16): string {
  const src = HUD_SVG[id];
  if (!src) return id;
  return `<img src="${svgDataUri(src)}" alt="" style="width:${size}px;height:${size}px;vertical-align:-3px;display:inline;">`;
}
function buildIcon(def: { id: string; emoji?: string }, size = 16): string {
  const src = BUILDING_SVG[def.id];
  if (src) return `<img src="${svgDataUri(src)}" alt="" style="width:${size}px;height:${size}px;vertical-align:-3px;display:inline;">`;
  return def.emoji ?? '🏗';
}
function pawnIcon(traits: readonly string[] | undefined, size = 18): string {
  return `<img src="${svgDataUri(PAWN_SVG[pawnAssetIdFor(traits).replace('pawn:', '')])}" alt="" style="width:${size}px;height:${size}px;vertical-align:-3px;display:inline;border-radius:3px;">`;
}

const nf = (v: number | undefined): string => (v === undefined ? '-' : Math.round(v).toString());

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
.hud-top{position:absolute;top:0;left:0;right:0;padding:8px 14px;background:rgba(0,0,0,.6);display:flex;gap:18px;align-items:center;font-weight:600;flex-wrap:wrap;}
.hud-top .warn{color:#f66;font-weight:700;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.hud-top .warn{animation:blink 1s infinite;}
.hud-bottom{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:6px;pointer-events:auto;flex-wrap:wrap;justify-content:center;max-width:96%;padding:8px;flex-direction:column;align-items:center;}
.hud-buildrow{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-height:200px;overflow-y:auto;}
.hud-group{display:flex;flex-direction:column;gap:2px;align-items:stretch;padding:0 4px;border-left:1px solid #333;}
.hud-group>div:first-child{color:#888;font-size:10px;text-align:center;padding:1px 0;}
.hud-corner{position:absolute;bottom:12px;left:12px;display:flex;gap:4px;pointer-events:auto;padding:6px;}
.hud-corner button{padding:3px 9px;font:12px system-ui;}
.hud-sel{position:absolute;top:54px;left:12px;padding:8px 12px;min-width:180px;display:none;line-height:1.6;}
.hud-hint{position:absolute;top:54px;right:12px;padding:6px 10px;font-size:12px;text-align:right;max-width:340px;}
.hud-feed{position:absolute;bottom:12px;right:96px;padding:6px 10px;font-size:11px;line-height:1.5;max-width:220px;text-align:right;}
.hud-feed div{border-top:1px solid #222;}
.hud-center{position:absolute;top:54px;left:50%;transform:translateX(-50%);display:flex;gap:6px;pointer-events:auto;}
.hud-pop{position:absolute;top:88px;left:50%;transform:translateX(-50%);padding:12px 14px;font-size:11px;line-height:1.7;max-width:520px;max-height:60vh;overflow:auto;display:none;}
.hud-card{position:absolute;top:52px;left:50%;transform:translateX(-50%);padding:6px 14px;border:1px solid #a07ac0;background:rgba(70,40,90,.92);border-radius:10px;font-size:12px;display:none;white-space:nowrap;}
.hud-card.visible{display:block;}
.hud-meta{color:#aaa;}
.hud-chip{border-radius:5px;padding:2px 7px;font:11px system-ui;margin-right:4px;}
.hud-jobrow{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0;}
.hud-tag{font-size:11px;}
`;
  document.head.appendChild(st);
}

// 建造菜单分组（按 def tags 归类，保证顺序）
type BuildGroup = '基地' | '防护' | '生产' | '信仰' | '水路' | '其他';
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
  toggleViewMode(): void;
  toggleFold(): void;
  togglePanel(name: 'helpToggle' | 'historyToggle' | 'factionToggle' | 'techsToggle'): void;
  isCapturingKey(): boolean;
}

export function createHud(
  sim: SimView,
  onSelectBuild: (id: string | null) => void,
  onZoom?: (factor: number) => void,
  onViewMode?: (mode: 'top' | 'iso') => void,
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
      btn.title = `需科技：${d.tech}（神谕抽卡解锁）`;
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
      sim.paused = sp === 0;
      sim.speed = sp === 0 ? 1 : sp;
      refreshSpeed();
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
    <div id="selTitle"></div>
    <div id="selBody" class="hud-meta"></div>
    <div id="selJobs" class="hud-jobrow"></div>
    <div id="selOracle" style="display:none;"><button data-act="oracle" style="border-color:#a07ac0;background:#5a3a6a;">${icon('oracle')} 发布神谕</button></div>`;
  root.appendChild(selPanel);
  const selTitle = selPanel.querySelector<HTMLElement>('#selTitle')!;
  const selBody = selPanel.querySelector<HTMLElement>('#selBody')!;
  const selJobs = selPanel.querySelector<HTMLElement>('#selJobs')!;
  const selOracle = selPanel.querySelector<HTMLElement>('#selOracle')!;
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
    }
  });

  // 选中的建筑（main.ts 维护，HUD 读取）
  const selectedBuildingRef: { current: { x: number; y: number } | null } = { current: null };

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
  centerBtns.append(helpBtn, histBtn, facBtn, techBtn);
  root.appendChild(centerBtns);

  const helpPanel = document.createElement('div');
  helpPanel.className = 'hud-pop';
  const k = (a: ActionId): string => keybindings.getKeys(a).map((x) => `<b>${keybindings.displayKey(x)}</b>`).join(' / ');
  helpPanel.innerHTML =
    `<b>🐭 infcanvas · 殖民地模拟</b><br>` +
    `👆 <b>鼠标</b>：左键选中小人/建筑 · 右键移动 · 左键拖空白平移 · 滚轮缩放 · 边缘滚动<br>` +
    `📱 <b>触摸</b>：点选 · 长按移动 · 双指拖动/缩放<br>` +
    `⌨️ <b>键盘</b>：${k('pause')} 暂停 · ${k('speed1')}/${k('speed2')}/${k('speed3')} 调速 · ${k('cancel')} 取消/退出建造 · ${k('buildWall')} 建墙 · ${k('viewToggle')} 视角 · ${k('menuFold')} 菜单折叠<br>` +
    `🃏 <b>策略卡</b>：神谕按局面降下策略卡（顶部紫色横幅），缺粮垦田、人丁旺拓荒迁徙<br>` +
    `🏗 <b>建造菜单</b>：下方按类分组选建筑 → 地图点击放置（绿=可建，红=不可）<br>` +
    `🧠 <b>小人自主</b>：小人自己伐木/采矿/建造/祈祷/疗伤，心情差会违抗安排<br>` +
    `📋 <b>指派职业</b>：选中小人 → 面板按钮指派伐木工/矿工/农民/工匠/渔民（或自由）<br>` +
    `🏕 <b>派系</b>：有篝火=独立派系；篝火间会贸易/传话/袭击/吞并；🌍 面板看世界派系<br>` +
    `⛪ <b>神谕</b>：信仰高时 AI 建教堂；选教堂点"发布神谕"祝福信众；神谕会降下策略卡（顶部横幅）<br>` +
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
  const toggle = (p: HTMLElement): void => {
    const show = p.style.display !== 'block';
    for (const q of panels) q.style.display = 'none';
    p.style.display = show ? 'block' : 'none';
  };
  helpBtn.addEventListener('click', () => toggle(helpPanel));
  histBtn.addEventListener('click', () => toggle(histPanel));
  facBtn.addEventListener('click', () => toggle(facPanel));
  techBtn.addEventListener('click', () => toggle(techPanel));
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

    // 📜 结构化历史（DESIGN §3 仿真日志）
    if (histPanel.style.display === 'block') {
      const rows = sim.historyRecent.map((h) => {
        const where = h.x !== undefined ? `@(${h.x},${h.y})` : '';
        const who = h.eid !== undefined ? `#${h.eid}` : '';
        const detail = h.data ? ' ' + Object.entries(h.data).map(([k, v]) => `${k}=${v}`).join(' ') : '';
        const cause = h.cause ? ` [${h.cause}]` : '';
        return `<div>D${h.day} ${h.time}s · ${h.type} ${who}${where}${cause}${detail}</div>`;
      });
      histPanel.innerHTML = `<b>📜 结构化历史（仿真日志）</b><br>` + rows.join('');
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

    // 🔬 科技面板：已解锁 / 下一张候选 / 科技锁建筑
    if (techPanel.style.display === 'block') {
      const techs = sim.techs;
      const lockedBuildings = Object.values(sim.mods.buildings)
        .filter((b) => b.tech && !techs?.has(b.tech))
        .map((b) => `${b.emoji ?? '🏗'} ${b.name}（需科技）`);
      const unlockedRows = techs && techs.size > 0
        ? [...techs].map((id) => {
          const t = sim.techsMap?.[id];
          return `<div>✅ ${t?.name ?? id}${t?.desc ? ` <span style="color:#aaa">${t.desc}</span>` : ''}</div>`;
        }).join('')
        : '<div style="color:#aaa">尚未抽到科技（神谕会不定期抽卡解锁）</div>';
      techPanel.innerHTML =
        `<b>🔬 科技（${techs?.size ?? 0}/${Object.keys(sim.techsMap ?? {}).length}）</b><br>` +
        unlockedRows +
        (lockedBuildings.length > 0 ? `<br><b>🔒 未解锁建造：</b>${lockedBuildings.join('、')}` : '');
    }

    const sel = sim.selectedIds;
    if (sel.length > 0) {
      const eid = sel[0];
      const p = sim.pawnProfile(eid);
      if (p) {
        selPanel.dataset.eid = String(eid);
        selJobs.style.display = '';
        selOracle.style.display = 'none';
        const nd = p.needs;
        const hk = p.health;
        const slotCards = p.slots.filter((c) => c !== null).map((c) => (c!.mastery ?? 0) > 0 ? `${c!.name}×${c!.mastery}` : c!.name).join('、') || '无';
        const dec = p.lastDecision ? `闪念：[${p.lastDecision.drawn.join(' | ')}] → 选了【${p.lastDecision.picked}】` : '';
        selTitle.innerHTML =
          `<b>${pawnIcon(p.dna.traits)} 小人 ${eid}</b> (${Math.round(p.pos.x)},${Math.round(p.pos.y)})<br>` +
          `<span style="color:#4cf">工作：${p.job || '闲逛'}</span>` +
          (p.assignedJob ? `<br><span style="color:#9cf">指派：${jobLabelOf(p.assignedJob)}</span>` : '');
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
          (p.oracleBuff && p.oracleBuff.until > sim.time ? `<br><span style="color:#e0b0ff">✨ 受神谕祝福</span>` : '') +
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
      cardText = `${icon('card')} 神谕降旨：<b>${def.label}</b>${def.reason ? `（${def.reason}）` : ''}`;
      cardUntil = performance.now() + 6000;
    },
    hint,
    refreshHint,
    selectedBuilding: selectedBuildingRef,
    toggleViewMode,
    toggleFold,
    togglePanel,
    isCapturingKey: () => capturing !== null,
  };
}
