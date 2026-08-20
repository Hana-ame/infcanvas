// 渲染（2026-08-21 从零重写）——极简 Canvas 2D（不引 Pixi，从零更干净）
// 第一版：瓦片 + 鼠鼠 + 建筑 + 敌人 + 选中高亮 + 框选。

import type { Sim } from '../sim/sim';
import { MAP_W, MAP_H } from '../sim/world';

const TILE = 24; // 每格像素

const TILE_COLOR: Record<string, string> = {
  grass: '#3a5f2a', tree: '#2f7a35', ore: '#5a5a6a', water: '#3a6a8a', stone: '#7a7a6a',
};

export class Renderer {
  cvs: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  cam = { x: 0, y: 0, zoom: 1 };

  constructor(private sim: Sim) {
    this.cvs = document.createElement('canvas');
    document.getElementById('app')!.appendChild(this.cvs);
    this.ctx = this.cvs.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.cvs.width = innerWidth * dpr;
    this.cvs.height = innerHeight * dpr;
    this.cvs.style.width = innerWidth + 'px';
    this.cvs.style.height = innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: Math.floor(this.cam.x + (sx - innerWidth / 2) / (TILE * this.cam.zoom)),
      y: Math.floor(this.cam.y + (sy - innerHeight / 2) / (TILE * this.cam.zoom)),
    };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.cam.x) * TILE * this.cam.zoom + innerWidth / 2,
      y: (y - this.cam.y) * TILE * this.cam.zoom + innerHeight / 2,
    };
  }

  zoomAt(sx: number, sy: number, f: number): void {
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(0.4, Math.min(3, this.cam.zoom * f));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  render(): void {
    const { ctx } = this;
    const z = this.cam.zoom;
    // 可视范围
    const w0 = this.screenToWorld(0, 0), w1 = this.screenToWorld(innerWidth, innerHeight);
    // 地面
    for (let y = Math.max(0, w0.y); y <= Math.min(MAP_H - 1, w1.y); y++) {
      for (let x = Math.max(0, w0.x); x <= Math.min(MAP_W - 1, w1.x); x++) {
        const s = this.worldToScreen(x + 0.5, y + 0.5);
        ctx.fillStyle = TILE_COLOR[this.sim.world.tile(x, y)] ?? '#333';
        ctx.fillRect((x - this.cam.x) * TILE * z + innerWidth / 2, (y - this.cam.y) * TILE * z + innerHeight / 2, TILE * z + 0.5, TILE * z + 0.5);
        if (this.sim.world.tile(x, y) === 'tree') {
          ctx.fillStyle = '#1f5a25';
          ctx.beginPath();
          ctx.arc(s.x, s.y - TILE * z * 0.15, TILE * z * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // 建筑
    for (const b of this.sim.world.buildings.values()) {
      const s = this.worldToScreen(b.x + 0.5, b.y + 0.5);
      const def = this.sim.reg.buildings.get(b.defId);
      ctx.font = `${TILE * z * 0.9}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def?.emoji ?? '🧱', s.x, s.y);
    }
    // 鼠鼠
    for (const p of this.sim.pawns.values()) {
      const s = this.worldToScreen(p.pos.x, p.pos.y);
      const selected = this.sim.selected.includes(p.eid);
      ctx.beginPath();
      ctx.arc(s.x, s.y, TILE * z * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#f8d24a' : '#d8b28a';
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#f8d24a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, TILE * z * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 血条
      const hp = p.health.hp / p.health.maxHp;
      ctx.fillStyle = '#222';
      ctx.fillRect(s.x - TILE * z * 0.3, s.y - TILE * z * 0.45, TILE * z * 0.6, 3);
      ctx.fillStyle = hp > 0.5 ? '#3fb950' : hp > 0.25 ? '#d29922' : '#f85149';
      ctx.fillRect(s.x - TILE * z * 0.3, s.y - TILE * z * 0.45, TILE * z * 0.6 * hp, 3);
    }
    // 敌人
    for (const h of this.sim.hostiles) {
      const s = this.worldToScreen(h.x, h.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, TILE * z * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = '#c84040';
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.font = `${TILE * z * 0.6}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🐈', s.x, s.y);
    }
  }
}