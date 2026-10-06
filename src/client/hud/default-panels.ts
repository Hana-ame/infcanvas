/**
 * client/hud/default-panels.ts —— 内建面板集（R3-HUD）。
 *
 * 这些面板全部只读 WorldView 的展示面（colony / inspect* / techProgress / events），
 * **不持任何模拟状态**：HUD 是 WorldView 的消费者，不是第二个 Sim。
 * 未来新玩法包要加自己的面板，写一个 PanelDef 用 host.register() 挂进来即可，
 * 不需要改 hud.ts 的 frame()（这是本轮"可扩展"的实质）。
 *
 * 视觉结构（信息密度由低到高，与玩家"先扫全局、再点细节"的阅读顺序对齐）：
 *  - status  顶栏一行：时钟 / 人口 / 食物 / 木料 —— 极低密度，扫一眼就够。
 *  - vitals  鼠群均值四需求 + 血量 —— 玩家最关心的"整体健康"，四条彩条一眼扫出谁在饿/谁在困。
 *  - colony  建筑种类与数量（按数量降序）—— 营地规模一目了然。
 *  - threat  敌袭压力条 + 在场敌人 + 下一波倒计时 —— 只在 raid 包挂载且有压力时显示。
 *  - detail  选中详情（鼠/建筑/敌人三合一）—— 高信息密度，点开才看。
 *  - log     事件流（保留原有 feed，搬到分区里统一治理）。
 */
import { TRAIT_COLOR, type WorldView } from '../view';
import { fuelLabel } from '../hud-faces';
import { barRow, esc, keyOf, type PanelDef } from './panels';

/** 选中上下文：HUD 每帧传入（选中集是玩家的交互态，不是模拟状态）。 */
export interface SelectionCtx {
  /** 选中的鼠 eid 集合（可能有多个，如框选）。detail 面板取第一个作为主档案。 */
  pawns: Set<number>;
  /** 选中的建筑 id（点建筑）；null 表示未选 */
  buildingId: string | null;
  /** 选中的敌袭单位 id；null 表示未选 */
  hostileId: number | null;
  /** 世界秒（显示用） */
  time: number;
}

/** 构造一个「选中上下文」。main.ts 每帧调用它把交互态喂进来（不存任何模拟数据）。 */
export function selCtx(
  pawns: Set<number>,
  buildingId: string | null,
  hostileId: number | null,
  time: number,
): SelectionCtx {
  return { pawns, buildingId, hostileId, time };
}

/** 内建面板全集。selCtx 由 frame() 传入（面板是纯函数视图，共享同一份选中快照）。 */
export function defaultPanels(getSel: () => SelectionCtx): PanelDef[] {
  return [
    // ---- 状态条（顶栏一行，低密度）----
    statusBar(getSel),
    // ---- 鼠群健康（均值四需求 + 血量）----
    vitalsPanel(),
    // ---- 殖民地建筑构成 ----
    colonyPanel(),
    // ---- 敌袭威胁（压力条 + 倒计时 + 在场敌人）----
    threatPanel(),
    // ---- 选中详情（鼠/建筑/敌人三合一）----
    detailPanel(getSel),
    // ---- 事件流 ----
    eventFeed(),
  ];
}

function statusBar(getSel: () => SelectionCtx): PanelDef {
  return {
    id: 'status',
    slot: 'status',
    icon: '⏱',
    title: '营地总览',
    render(view: WorldView) {
      const s = getSel();
      const c = view.colony();
      const food = view.stockpile['food'] ?? 0;
      const wood = view.stockpile['wood'] ?? 0;
      // key 用定长标量：任一变化才重画；纯读取无 DOM
      const key = keyOf(
        Math.floor(s.time),
        c.pawnCount,
        food,
        wood,
        c.hostileCount,
        s.pawns.size,
      );
      const selTxt = s.pawns.size ? `｜已选 ${s.pawns.size} 鼠` : '';
      const html =
        `<b>⏱ ${Math.floor(s.time)}s</b>` +
        `<span>🐭 ${c.pawnCount}</span>` +
        `<span>🍎 ${food}</span>` +
        `<span>🪵 ${wood}</span>` +
        `<span>🔥🏚 ${view.buildings().length}</span>` +
        `<span>🐱 ${c.hostileCount}</span>` +
        `<span class="sel">${selTxt}</span>`;
      return { key, html };
    },
  };
}

function vitalsPanel(): PanelDef {
  return {
    id: 'vitals',
    slot: 'vitals',
    icon: '💓',
    title: '鼠群健康（均值）',
    render(view: WorldView) {
      const c = view.colony();
      const n = c.avgNeeds;
      // 均值取整到整数进 key：连续小数每帧都在动，会导致"永远判定为变化"而每帧写 DOM。
      // 取整是差分粒度的选择——玩家读的是整数级健康度。
      const key = keyOf(
        Math.round(n.food),
        Math.round(n.rest),
        Math.round(n.mood),
        Math.round(n.san),
        Math.round(c.avgHpPct),
        c.pawnCount,
      );
      const html =
        barRow('食', n.food, '#d98a3a') +
        barRow('眠', n.rest, '#4a7dc9') +
        barRow('情', n.mood, '#c96f9c') +
        barRow('智', n.san, '#8a6fc9') +
        barRow('血', c.avgHpPct, '#7ec97e');
      return { key, html };
    },
  };
}

function colonyPanel(): PanelDef {
  return {
    id: 'colony',
    slot: 'colony',
    icon: '🏕',
    title: '营地构成',
    render(view: WorldView) {
      const c = view.colony();
      // key 由每个建筑种类的「id:数量」拼成——建筑增减才重画，鼠标移动/时间推进不触发。
      const key = keyOf(c.buildingKinds.map((k) => `${k.defId}:${k.count}`).join(','));
      if (c.buildingKinds.length === 0) {
        return { key, html: '<div class="empty">（还没有建筑）</div>', empty: true };
      }
      const rows = c.buildingKinds
        .map((k) => {
          const fuel = k.fuelSec !== undefined ? `<span class="fuel">${esc(fuelLabel(k.fuelSec))}</span>` : '';
          return `<div class="brow"><span>${esc(k.name)} ×${k.count}</span>${fuel}</div>`;
        })
        .join('');
      return { key, html: rows };
    },
  };
}

function threatPanel(): PanelDef {
  return {
    id: 'threat',
    slot: 'threat',
    icon: '⚠',
    title: '敌袭威胁',
    render(view: WorldView) {
      const c = view.colony();
      // 压力未知（未挂 raid 包）→ 隐藏整块：显示假 0% 会让玩家以为"安全"，
      // 而真实语义是"这条规则不存在"。空白面板同理——显式语义优于沉默。
      if (c.raidPressure === null) {
        return { key: 'none', html: '', empty: true };
      }
      const pct = Math.round(c.raidPressure * 100);
      const eta = c.raidEtaSec !== null ? ` 约 ${Math.round(c.raidEtaSec)}s` : '';
      const key = keyOf(pct, c.hostileCount, Math.round(c.raidEtaSec ?? -1));
      const color = pct > 70 ? '#e08a8a' : pct > 35 ? '#ffd94a' : '#7ec97e';
      const html =
        `<div class="mrow"><span class="mk" style="color:${color}">压力</span>` +
        `<span class="mbar"><i style="width:${pct}%;background:${color}"></i></span>` +
        `<span class="mv">${pct}%</span></div>` +
        `<div class="muted">下一波敌袭${eta}｜在场敌人 ${c.hostileCount}</div>`;
      return { key, html };
    },
  };
}

function detailPanel(getSel: () => SelectionCtx): PanelDef {
  return {
    id: 'detail',
    slot: 'detail',
    icon: '🔍',
    title: '选中详情',
    render(view: WorldView) {
      const s = getSel();
      // 三类选中对象优先级：敌袭 > 建筑 > 鼠（点敌人最需要即时看到威胁信息）。
      if (s.hostileId !== null) {
        const h = view.inspectHostile(s.hostileId);
        if (!h) return { key: 'h:none', html: '', empty: true };
        const pct = Math.round((h.hp / Math.max(1, h.maxHp)) * 100);
        const key = keyOf('h', h.id, h.hp, Math.round(h.distToNearestPawn), h.engaging ? 1 : 0);
        const html =
          `<b style="color:#e08a8a">${esc(h.name)}</b>` +
          `<div class="muted">野性单位 · 血量 ${h.hp}/${h.maxHp}（${pct}%）</div>` +
          `<div class="muted">距最近鼠鼠 ${h.distToNearestPawn < 0 ? '—' : Math.round(h.distToNearestPawn)} 格</div>` +
          (h.engaging ? `<div class="danger">已进营地警戒圈，随时可能接敌</div>` : '');
        return { key, html };
      }
      if (s.buildingId !== null) {
        const b = view.inspectBuilding(s.buildingId);
        if (!b) return { key: 'b:none', html: '', empty: true };
        const hpPct = Math.round((b.hp / Math.max(1, b.maxHp)) * 100);
        // 燃料节奏进 key：燃料参数（fuelSec）是建筑定义的一部分，不变。
        const key = keyOf('b', b.id, b.hp, b.sameKindCount, b.fuelSec ?? -1);
        const costTxt = Object.entries(b.cost)
          .map(([k, v]) => `${esc(k)}×${v}`)
          .join(' ');
        const html =
          `<b>${esc(b.name)}</b>` +
          `<div class="muted">${b.w}×${b.h} 格｜同类共 ${b.sameKindCount} 座</div>` +
          barRow('耐久', hpPct, '#7ec97e') +
          `<div class="muted">造价：${esc(costTxt || '—')}｜${esc(fuelLabel(b.fuelSec))}</div>`;
        return { key, html };
      }
      // 选中鼠：取第一个（框选多只时以第一只为主档案）。
      let first: number | null = null;
      for (const e of s.pawns) {
        first = e;
        break;
      }
      if (first === null) return { key: 'p:none', html: '', empty: true };
      const d = view.inspectPawn(first);
      if (!d) return { key: 'p:gone', html: '', empty: true };
      const color = TRAIT_COLOR[d.trait] ?? '#fff';
      const fire = d.nearFireDist === null ? '（附近无火）' : `${Math.round(d.nearFireDist)} 格`;
      const key = keyOf(
        'p',
        d.eid,
        Math.round(d.needs.food),
        Math.round(d.needs.rest),
        Math.round(d.needs.mood),
        Math.round(d.needs.san),
        Math.round(d.hpPct),
        d.cardLabel,
        Math.round(d.nearFireDist ?? -1),
        d.mastery.map((m) => `${m.cardId}:${m.v}`).join(','),
        d.uses.map((u) => `${u.cardId}:${u.n}`).join(','),
      );
      let html =
        `<b style="color:${color}">${esc(d.name)}·${esc(d.traitName)}</b>` +
        `<div class="muted">当前卡：${esc(d.cardLabel || '—')}｜火堆 ${fire}</div>` +
        barRow('食欲', d.needs.food, '#d98a3a') +
        barRow('睡眠', d.needs.rest, '#4a7dc9') +
        barRow('心情', d.needs.mood, '#c96f9c') +
        barRow('理智', d.needs.san, '#8a6fc9') +
        barRow('生命', d.hpPct, '#7ec97e');
      if (d.mastery.length) {
        html += `<div class="muted">熟练：${d.mastery.map((m) => `${esc(m.label)}${m.v}`).join(' · ')}</div>`;
      }
      if (d.uses.length) {
        html += `<div class="muted">抽卡：${d.uses.map((u) => `${esc(u.label)}×${u.n}`).join(' · ')}</div>`;
      }
      return { key, html };
    },
  };
}

function eventFeed(): PanelDef {
  return {
    id: 'log',
    slot: 'log',
    icon: '📜',
    title: '事件流',
    render(view: WorldView) {
      const evs = view.events();
      const key = keyOf(evs.map((e) => `${Math.floor(e.time)}:${e.text}`).join('\n'));
      const html =
        evs.length === 0
          ? '<span class="muted">（事件会出现在这里……）</span>'
          : evs.map((e) => `[${String(Math.floor(e.time)).padStart(4)}s] ${esc(e.text)}`).join('<br>');
      return { key, html };
    },
  };
}

/** 科技面板单独留在原来的 #hud-tech <details>（折叠），因为它是低频信息，不占分区常态。 */
export function techPanelHtml(view: WorldView): { key: string; html: string } {
  const rows = view.techProgress();
  const key = keyOf(rows.map((r) => `${r.id}:${r.have}/${r.need}:${r.unlocked ? 1 : 0}`).join('|'));
  if (rows.length === 0) return { key, html: '<div class="empty">（无科技池）</div>' };
  const html = rows
    .map(
      (r) =>
        `<div class="tech${r.unlocked ? ' done' : ''}">` +
        `<span>${esc(r.name)}</span>` +
        `<span class="fr">${r.unlocked ? '已解锁' : `🔩 ${r.have}/${r.need}`}</span>` +
        `</div>`,
    )
    .join('');
  return { key, html };
}