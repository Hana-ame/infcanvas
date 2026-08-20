// HUD（2026-08-21 从零重写 v2）——DOM 覆盖层 + 响应式双端
// 顶栏资源 / 底栏建造 / 左侧选中面板 / 右侧事件 feed。触控目标 ≥40px。

import type { Sim } from '../sim/sim';

export interface HudApi {
  update(): void;
  selected: { current: number[] };
  buildMode: { current: string | null };
}

function el(tag: string, cls: string, html = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
}

export function createHud(sim: Sim, onBuildSelect: (id: string) => void): HudApi {
  const api: HudApi = {
    selected: { current: [] },
    buildMode: { current: null },
    update() {},
  };

  // 样式（注入一次）
  if (!document.getElementById('hud-style')) {
    const st = document.createElement('style');
    st.id = 'hud-style';
    st.textContent = `
.hud{position:fixed;inset:0;z-index:10;pointer-events:none;font:13px system-ui;color:#eee;user-select:none;}
.hud button{pointer-events:auto;border:1px solid #555;background:#333;color:#eee;border-radius:8px;cursor:pointer;font:13px system-ui;padding:6px 10px;min-height:38px;}
.hud button:hover{background:#4a4a4a;}
.hud button.on{background:rgba(68,204,255,.25);border-color:#4cf;}
.hud-top{position:absolute;top:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,.65);display:flex;gap:16px;align-items:center;font-weight:600;min-height:42px;z-index:12;overflow-x:auto;white-space:nowrap;pointer-events:auto;}
.hud-top .res{display:flex;gap:4px;align-items:center;}
.hud-top .res b{color:#ffd966;}
.hud-build{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:6px;background:rgba(0,0,0,.65);padding:8px 10px;border-radius:10px;pointer-events:auto;flex-wrap:wrap;justify-content:center;max-width:92%;z-index:12;}
.hud-sel{position:absolute;top:56px;left:10px;background:rgba(0,0,0,.8);border:1px solid #444;border-radius:10px;padding:10px 12px;min-width:190px;display:none;pointer-events:auto;line-height:1.6;z-index:12;}
.hud-sel.show{display:block;}
.hud-feed{position:absolute;bottom:8px;right:10px;background:rgba(0,0,0,.65);border-radius:8px;padding:6px 10px;font-size:11px;max-width:340px;max-height:30vh;overflow-y:auto;pointer-events:auto;z-index:12;}
.hud-feed div{border-top:1px solid #222;padding:2px 0;}
.hud-feed div:first-child{border-top:none;}
.bar{display:flex;align-items:center;gap:6px;}
.bar .fill-wrap{width:90px;height:8px;background:#222;border-radius:4px;overflow:hidden;}
.bar .fill{height:100%;border-radius:4px;}
@media (pointer:coarse){.hud button{min-height:44px;font-size:14px;}}
@media (max-width:640px){.hud-sel{min-width:150px;}.hud-top{gap:10px;font-size:12px;}}
`;
    document.head.appendChild(st);
  }

  const hud = el('div', 'hud');
  document.body.appendChild(hud);

  // ---- 顶栏：资源 ----
  const top = el('div', 'hud-top');
  const resWood = el('span', 'res', '🪵 <b id="resWood">0</b>');
  const resFood = el('span', 'res', '🍖 <b id="resFood">0</b>');
  const resOre = el('span', 'res', '🪨 <b id="resOre">0</b>');
  const pop = el('span', 'res', '🐭 <b id="pop">0</b>');
  const timeEl = el('span', 'res', '<span id="time">0:00</span>');
  top.append(resWood, resFood, resOre, pop, timeEl);
  hud.appendChild(top);

  // ---- 底栏：建造 ----
  const build = el('div', 'hud-build');
  const buildDefs = ['campfire', 'wall', 'house'];
  const buildBtns = new Map<string, HTMLButtonElement>();
  for (const id of buildDefs) {
    const def = sim.reg.buildings.get(id);
    if (!def) continue;
    const btn = document.createElement('button');
    btn.innerHTML = `${def.emoji} ${def.name}`;
    btn.title = `消耗 木 ${def.costWood ?? 0}`;
    btn.addEventListener('click', () => {
      const on = api.buildMode.current === id;
      api.buildMode.current = on ? null : id;
      for (const b of buildBtns.values()) b.classList.remove('on');
      if (!on) btn.classList.add('on');
      onBuildSelect(id);
    });
    buildBtns.set(id, btn);
    build.appendChild(btn);
  }
  hud.appendChild(build);

  // ---- 左侧：选中面板 ----
  const sel = el('div', 'hud-sel');
  hud.appendChild(sel);

  // ---- 右侧：事件 feed ----
  const feed = el('div', 'hud-feed');
  hud.appendChild(feed);

  // ---- 更新循环 ----
  let lastEventCount = 0;
  api.update = () => {
    // 资源
    resWood.querySelector('#resWood')!.textContent = String(Math.round(sim.stockpile.wood));
    resFood.querySelector('#resFood')!.textContent = String(Math.round(sim.stockpile.food));
    resOre.querySelector('#resOre')!.textContent = String(Math.round(sim.stockpile.ore));
    pop.querySelector('#pop')!.textContent = String(sim.pawns.size);
    const t = sim.time;
    timeEl.querySelector('#time')!.textContent = `${Math.floor(t / 86400)}d ${String(Math.floor(t / 60 % 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

    // 选中面板
    const selIds = api.selected.current;
    if (selIds.length > 0) {
      sel.classList.add('show');
      const rows = selIds.map((eid) => {
        const p = sim.pawns.get(eid);
        if (!p) return '';
        return `
<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0">
  <span><b>${p.name}</b> <span style="color:#888">${p.job}</span></span>
</div>
<div class="bar">🍖 <div class="fill-wrap"><div class="fill" style="width:${Math.round(p.needs.food)}%;background:${sRatio(p.needs.food)}"></div></div></div>
<div class="bar">😴 <div class="fill-wrap"><div class="fill" style="width:${Math.round(p.needs.rest)}%;background:${sRatio(p.needs.rest)}"></div></div></div>
<div class="bar">💚 <div class="fill-wrap"><div class="fill" style="width:${Math.round(p.health.hp / p.health.maxHp * 100)}%;background:${sRatio(p.health.hp / p.health.maxHp * 100)}"></div></div></div>`;
      }).join('');
      sel.innerHTML = `<b style="color:#ffd966">${selIds.length} 只鼠选中</b>${rows}`;
    } else sel.classList.remove('show');

    // 事件 feed（增量：只追加新事件）
    const evts = sim.events;
    if (evts.length > lastEventCount) {
      const fresh = evts.slice(lastEventCount);
      lastEventCount = evts.length;
      for (const e of fresh) {
        const d = el('div', '', escapeHtml(e.text));
        feed.appendChild(d);
      }
      while (feed.children.length > 60) feed.removeChild(feed.firstChild!);
    }
  };

  return api;
}

function sRatio(v: number): string {
  return v > 50 ? '#3fb950' : v > 25 ? '#d29922' : '#f85149';
}
function escapeHtml(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}