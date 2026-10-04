/**
 * client/hud.ts —— DOM HUD 层：顶栏资源 / 事件 feed / 选中面板 / 控制按钮。
 * 只读 WorldView 快照 + 发出交互意图（回调），不持任何模拟状态。
 */
import { cardLabel, TRAIT_COLOR, type WorldView } from './view';

export interface HudCallbacks {
  onPauseToggle(): boolean; // 返回暂停后的状态
  onSpeedCycle(): number; // 返回新速度
  onFollowToggle(): boolean;
  onNewWorld(): void;
  onSave(): void;
  onLoad(): void;
}

export class Hud {
  private feedCache = '';
  constructor(
    private view: WorldView,
    private cb: HudCallbacks,
  ) {
    document.getElementById('btn-pause')!.onclick = () => {
      const paused = this.cb.onPauseToggle();
      (document.getElementById('btn-pause')!).textContent = paused ? '▶ 继续' : '⏸ 暂停';
    };
    document.getElementById('btn-speed')!.onclick = (ev) => {
      const v = this.cb.onSpeedCycle();
      (ev.target as HTMLElement).textContent = `⏩ 速度 ×${v}`;
    };
    const followBtn = document.getElementById('btn-follow')!;
    followBtn.onclick = () => {
      followBtn.textContent = `🎯 跟随鼠群：${this.cb.onFollowToggle() ? '开' : '关'}`;
    };
    const nw = document.getElementById('btn-new');
    if (nw) nw.onclick = () => this.cb.onNewWorld();
    const save = document.getElementById('btn-save');
    if (save) save.onclick = () => this.cb.onSave();
    const load = document.getElementById('btn-load');
    if (load) load.onclick = () => this.cb.onLoad();
  }

  frame(paused: boolean, selected: Set<number>): void {
    const v = this.view;
    let alive = 0;
    for (const _ of v.pawns()) alive++;
    const top = document.getElementById('hud-top')!;
    const selTxt = selected.size ? `｜已选 ${selected.size} 鼠` : '';
    if (top.dataset.k !== `${Math.floor(v.time)}|${alive}|${selTxt}|${v.stockpile['food'] ?? 0}|${v.stockpile['wood'] ?? 0}`) {
      top.dataset.k = `${Math.floor(v.time)}|${alive}|${selTxt}|${v.stockpile['food'] ?? 0}|${v.stockpile['wood'] ?? 0}`;
      top.innerHTML =
        `<b>⏱ ${Math.floor(v.time)}s</b>` +
        `<span>🐭 ${alive}</span>` +
        `<span>🍎 ${v.stockpile['food'] ?? 0}</span>` +
        `<span>🪵 ${v.stockpile['wood'] ?? 0}</span>` +
        `<span>🔥🏚 ${v.buildings().length}</span>` +
        `<span>🐱 ${v.hostiles().length}</span>` +
        `<span>${selTxt}</span>`;
    }
    // feed
    const recent = v.events().map((e) => `[${String(Math.floor(e.time)).padStart(4)}s] ${e.text}`);
    const html = recent.join('<br>');
    if (html !== this.feedCache) {
      this.feedCache = html;
      const el = document.getElementById('hud-feed')!;
      el.innerHTML = html || '<span style="color:#667">（事件会出现在这里……）</span>';
      el.scrollTop = el.scrollHeight;
    }
    // 选中面板
    const panel = document.getElementById('hud-sel');
    if (panel) {
      const first = [...selected][0];
      let inner = '';
      for (const p of v.pawns()) {
        if (p.eid !== first) continue;
        const n = p.needs;
        // 每个值都带名称+数字（2026-08-21 用户反馈：裸 bar 看不懂是什么）
        const row = (k: string, val: number, color: string) =>
          `<div class="row"><span class="k" style="color:${color}">${k}</span>` +
          `<div class="bar"><i style="width:${val}%;background:${color}"></i></div>` +
          `<span class="v">${Math.round(val)}</span></div>`;
        inner =
          `<b style="color:${TRAIT_COLOR[p.trait] ?? '#fff'}">${p.name}·${v.traitName(p.trait)}</b>` +
          `<div class="muted">当前卡：${cardLabel(p.cardId)}</div>` +
          row('食欲', n.food, '#d98a3a') +
          row('睡眠', n.rest, '#4a7dc9') +
          row('心情', n.mood, '#c96f9c') +
          row('理智', n.san, '#8a6fc9') +
          row('生命', (p.hp / p.maxHp) * 100, '#7ec97e');
      }
      panel.innerHTML = inner;
      panel.style.display = inner ? 'block' : 'none';
    }
  }
}
