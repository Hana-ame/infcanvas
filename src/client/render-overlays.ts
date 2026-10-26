/**
 * client/render-overlays.ts —— RimWorld 1.5 原版描图级（Vector-Traced）地图资源、四向连通矿脉、散落物堆叠、驼兽、按体型缩放遗体与迷雾叠加层。
 */
import type { Graphics } from 'pixi.js';
import type { Eid, Pos, Sim } from '../sim';
import { mineralAt } from '../sim/npc-bases';
import { getCorpses } from '../sim/corpse-youtube-play';
import {
  getRuinScavengeableBuildings,
  hasRuinSitesInitialized,
  isRuinFloorTile,
} from '../sim/mmo-ruins';
import { evaluatePowerGrids, getPlayerFogSources } from '../sim/power-fog-engine';
import { inspectRoomAt, isSolidMountainAt } from '../sim/rooms-power-fog';
import { getPackBeasts, getOutdoorItems, type OutdoorGroundItem } from '../sim/social-trade-weathering';
import { terrainMetaAt } from '../sim/terrain';
import { drawNpcOutpostGraphic } from './render-entities';
import type { WorldView } from './view';

export type MapOverlayMode = 'none' | 'fertility' | 'roof' | 'power';

export function drawMapModeOverlays(
  g: Graphics,
  sim: Sim | null,
  mode: MapOverlayMode,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visSet: Set<string> | null,
  T: number,
): void {
  if (!sim || mode === 'none') return;

  if (mode === 'fertility') {
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (visSet && !visSet.has(`${tx},${ty}`)) continue;
        if (isSolidMountainAt(sim.world, tx, ty)) continue;
        const meta = terrainMetaAt(sim.world, tx, ty);
        if (meta.fertility <= 0) continue;
        const col = meta.fertility >= 1.2 ? 0x2ecc71 : meta.fertility >= 0.85 ? 0x7ef09d : 0xf5d451;
        const alpha = meta.fertility >= 1.2 ? 0.34 : meta.fertility >= 0.85 ? 0.22 : 0.16;
        g.rect(tx * T + 1, ty * T + 1, T - 2, T - 2).fill({ color: col, alpha });
      }
    }
    return;
  }

  if (mode === 'roof') {
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (visSet && !visSet.has(`${tx},${ty}`)) continue;
        if (isSolidMountainAt(sim.world, tx, ty)) {
          g.rect(tx * T, ty * T, T, T).fill({ color: 0x1e272e, alpha: 0.45 });
          continue;
        }
        const rm = inspectRoomAt(sim.world, tx, ty);
        if (rm.roofed) {
          g.rect(tx * T + 1, ty * T + 1, T - 2, T - 2).fill({ color: 0x4cd964, alpha: 0.28 });
        } else if (rm.enclosed && !rm.roofed) {
          g.rect(tx * T + 1, ty * T + 1, T - 2, T - 2).fill({ color: 0xff6b6b, alpha: 0.26 });
        }
      }
    }
    return;
  }

  if (mode === 'power') {
    const grids = evaluatePowerGrids(sim.world);
    for (const b of sim.world.buildings.values()) {
      const bx = Math.round(b.pos.x);
      const by = Math.round(b.pos.y);
      if (bx < x0 - 4 || bx > x1 + 4 || by < y0 - 4 || by > y1 + 4) continue;
      if (
        b.defId === 'power_conduit' ||
        b.defId === 'wood_generator' ||
        b.defId === 'solar_generator' ||
        b.defId === 'battery' ||
        b.defId === 'electric_beacon_tower' ||
        b.defId === 'turret'
      ) {
        const fp = sim.world.footprintOf(b);
        const grid = grids.find((gr) => gr.buildingIds.includes(b.id));
        const col = grid?.overloadRefused ? 0xff4d4d : 0x64dfdf;
        g.rect(b.pos.x * T, b.pos.y * T, fp.w * T, fp.h * T)
          .fill({ color: col, alpha: 0.28 })
          .stroke({ width: 2, color: col, alpha: 0.92 });
      }
    }
  }
}

/** 按 RimWorld 物品分类精细绘制地面散落物堆叠与原版红色露天小叉号角标 */
function drawDroppedItemStack(g: Graphics, item: OutdoorGroundItem, ix: number, iy: number, T: number): void {
  const s = T / 26;
  g.ellipse(ix, iy + 5.5 * s, 7.2 * s, 3.0 * s).fill({ color: 0x000000, alpha: 0.35 });

  switch (item.item) {
    case 'wood': {
      for (const [dx, dy, col] of [
        [-1.5 * s, 1.8 * s, '#7f4f24'],
        [2.0 * s, 1.5 * s, '#8d5b34'],
        [0, -1.6 * s, '#a46d41'],
      ] as const) {
        g.roundRect(ix - 5.5 * s + dx, iy - 1.8 * s + dy, 10.5 * s, 3.8 * s, 1.6 * s)
          .fill(col)
          .stroke({ width: 1.2 * s, color: '#1f1308' });
        g.circle(ix + 3.8 * s + dx, iy + dy, 1.5 * s).fill('#ddb892');
      }
      break;
    }
    case 'ore':
    case 'components': {
      g.roundRect(ix - 5.8 * s, iy - 3.6 * s, 11.6 * s, 7.2 * s, 1.5 * s)
        .fill('#8d99ae')
        .stroke({ width: 1.5 * s, color: '#141619' });
      g.rect(ix - 4.0 * s, iy - 1.8 * s, 8.0 * s, 3.6 * s).fill('#ced4da');
      g.circle(ix - 2.2 * s, iy, 1.2 * s).fill('#2b3036');
      g.circle(ix + 2.2 * s, iy, 1.2 * s).fill('#2b3036');
      break;
    }
    case 'meat': {
      g.ellipse(ix, iy, 6.2 * s, 4.2 * s)
        .fill('#c92a2a')
        .stroke({ width: 1.5 * s, color: '#3b0d0d' });
      g.ellipse(ix - 1.2 * s, iy - 0.6 * s, 3.6 * s, 2.0 * s).fill('#e05252');
      g.circle(ix + 2.6 * s, iy + 0.5 * s, 1.8 * s)
        .fill('#f8f9fa')
        .stroke({ width: 1.0 * s, color: '#6b1515' });
      break;
    }
    case 'leather': {
      g.roundRect(ix - 6.0 * s, iy - 4.4 * s, 12.0 * s, 8.8 * s, 3.0 * s)
        .fill('#b07d4f')
        .stroke({ width: 1.4 * s, color: '#2b1d10' });
      g.roundRect(ix - 3.8 * s, iy - 2.4 * s, 7.6 * s, 4.8 * s, 1.5 * s).fill('#c99b68');
      break;
    }
    case 'meal':
    case 'food': {
      g.roundRect(ix - 5.4 * s, iy - 4.2 * s, 10.8 * s, 8.4 * s, 2.2 * s)
        .fill('#ddb892')
        .stroke({ width: 1.5 * s, color: '#24180c' });
      g.ellipse(ix, iy, 3.6 * s, 2.5 * s).fill('#c94a38');
      g.circle(ix - 1.5 * s, iy - 0.5 * s, 1.2 * s).fill('#7ef09d');
      g.circle(ix + 1.5 * s, iy + 0.5 * s, 1.2 * s).fill('#f5d451');
      break;
    }
    case 'herb': {
      g.roundRect(ix - 5.2 * s, iy - 4.2 * s, 10.4 * s, 8.4 * s, 2.2 * s)
        .fill('#2b9348')
        .stroke({ width: 1.5 * s, color: '#141619' });
      g.rect(ix - 1.0 * s, iy - 2.6 * s, 2.0 * s, 5.2 * s).fill('#ffffff');
      g.rect(ix - 2.6 * s, iy - 1.0 * s, 5.2 * s, 2.0 * s).fill('#ffffff');
      break;
    }
    case 'gold':
    case 'jade': {
      const isGold = item.item === 'gold';
      g.roundRect(ix - 5.0 * s, iy - 3.8 * s, 10.0 * s, 7.6 * s, 2.0 * s)
        .fill(isGold ? '#f5d451' : '#2ec4b6')
        .stroke({ width: 1.5 * s, color: '#141619' });
      g.rect(ix - 3.0 * s, iy - 1.8 * s, 6.0 * s, 3.2 * s).fill(isGold ? '#fff3b0' : '#cbf3f0');
      break;
    }
    default: {
      g.roundRect(ix - 5.5 * s, iy - 4.2 * s, 11.0 * s, 8.4 * s, 2.0 * s)
        .fill('#a37c4c')
        .stroke({ width: 1.4 * s, color: '#181a1d' });
      g.moveTo(ix - 5.0 * s, iy).lineTo(ix + 5.0 * s, iy).stroke({ width: 1.2 * s, color: '#3b2816' });
      break;
    }
  }

  const cx = ix + 4.8 * s;
  const cy = iy + 3.6 * s;
  g.moveTo(cx - 2.2 * s, cy - 2.2 * s).lineTo(cx + 2.2 * s, cy + 2.2 * s);
  g.moveTo(cx + 2.2 * s, cy - 2.2 * s).lineTo(cx - 2.2 * s, cy + 2.2 * s);
  g.stroke({ width: 1.6 * s, color: '#ff4d4d' });

  const hpPct = Math.max(0, Math.min(1, item.hp / item.maxHp));
  g.rect(ix - 6.2 * s, iy - 8.2 * s, 12.4 * s, 2.8 * s).fill('#141619');
  g.rect(ix - 5.8 * s, iy - 7.8 * s, 11.6 * s * hpPct, 2.0 * s).fill('#f0ad4e');
}

export function drawWorldResourcesAndCorpses(
  g: Graphics,
  view: WorldView,
  sim: Sim | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visSet: Set<string> | null,
  T: number,
  selected: ReadonlySet<Eid>,
  visualWalk: ReadonlyMap<Eid, { x: number; y: number }>,
  overlayMode: MapOverlayMode = 'none',
): void {
  g.clear();
  const ruinsEnabled = Boolean(sim && hasRuinSitesInitialized(sim));
  drawMapModeOverlays(g, sim, overlayMode, x0, y0, x1, y1, visSet, T);

  const isRockOrMineralVeinAt = (wx: number, wy: number): boolean => {
    if (!sim) return false;
    if (isSolidMountainAt(sim.world, wx, wy)) return true;
    const mh = mineralAt(sim.world, wx, wy);
    return Boolean(mh && mh.kind !== 'herb_plant');
  };

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (visSet && !visSet.has(`${tx},${ty}`)) continue;
      if (sim && isSolidMountainAt(sim.world, tx, ty)) continue;

      const px = tx * T;
      const py = ty * T;
      const ccx = px + T / 2;
      const ccy = py + T / 2;

      if (ruinsEnabled && sim && isRuinFloorTile(sim, tx, ty) && !sim.world.buildingAt(tx, ty)) {
        g.rect(px + 0.5, py + 0.5, T - 1, T - 1)
          .fill({ color: 0x484f56, alpha: 0.78 })
          .stroke({ width: 0.9, color: 0x282d32, alpha: 0.65 });
        if (((tx + ty) & 1) === 0) {
          g.rect(px + 2.5, py + 2.5, T * 0.42, T * 0.42).fill({ color: 0x586069, alpha: 0.5 });
          g.rect(px + T * 0.52, py + T * 0.52, T * 0.36, T * 0.36).fill({ color: 0x3b4148, alpha: 0.45 });
        }
      }

      if (sim && sim.world.buildingAt(tx, ty)) continue;

      const f = view.featureAt(tx, ty);
      if (f && f.kind === 'berry') {
        g.ellipse(ccx, ccy + T * 0.24, T * 0.36, T * 0.16).fill({ color: 0x000000, alpha: 0.32 });
        g.circle(ccx - T * 0.14, ccy + T * 0.04, T * 0.24).fill('#24421d').stroke({ width: 1.5, color: '#12210e' });
        g.circle(ccx + T * 0.14, ccy + T * 0.05, T * 0.23).fill('#2d5224').stroke({ width: 1.5, color: '#12210e' });
        g.circle(ccx, ccy - T * 0.06, T * 0.28).fill('#3b692f').stroke({ width: 1.6, color: '#12210e' });
        g.circle(ccx - T * 0.05, ccy - T * 0.12, T * 0.16).fill('#4f8740');
        for (let i = 0; i < Math.min(6, f.amount + 1); i++) {
          const bx = ccx + ((i % 2 === 0 ? -1 : 1) * (T * 0.13)) + (i - 2.5) * (T * 0.045);
          const by = ccy - T * 0.13 + (i % 3) * (T * 0.09);
          g.circle(bx, by, Math.max(2.0, T * 0.072))
            .fill('#e63946')
            .stroke({ width: 0.8, color: '#3b0a0e' });
        }
        continue;
      }
      if (f && f.kind === 'tree') continue;

      const minHit = sim ? mineralAt(sim.world, tx, ty) : null;
      if (minHit) {
        if (minHit.kind === 'herb_plant') {
          g.ellipse(ccx, ccy + T * 0.18, T * 0.28, T * 0.12).fill({ color: 0x000000, alpha: 0.28 });
          g.ellipse(ccx - T * 0.12, ccy, T * 0.18, T * 0.09).fill('#2b8a68').stroke({ width: 1.1, color: '#12382a' });
          g.ellipse(ccx + T * 0.12, ccy, T * 0.18, T * 0.09).fill('#2b8a68').stroke({ width: 1.1, color: '#12382a' });
          g.ellipse(ccx, ccy - T * 0.06, T * 0.11, T * 0.2).fill('#3ca37e').stroke({ width: 1.1, color: '#12382a' });
          g.circle(ccx, ccy - T * 0.1, T * 0.08).fill('#90e0ef');
        } else {
          // RimWorld 四向无缝连通矿脉岩体 (Connected Compacted Ore Seam)
          const minN = isRockOrMineralVeinAt(tx, ty - 1);
          const minS = isRockOrMineralVeinAt(tx, ty + 1);
          const minW = isRockOrMineralVeinAt(tx - 1, ty);
          const minE = isRockOrMineralVeinAt(tx + 1, ty);

          const m = Math.max(1.2, Math.round(T * 0.05));
          const rx0 = minW ? px : px + m;
          const rx1 = minE ? px + T : px + T - m;
          const ry0 = minN ? py : py + m;
          const ry1 = minS ? py + T : py + T - m;
          const rw = rx1 - rx0;
          const rh = ry1 - ry0;

          if (!minS) {
            g.rect(rx0 + 1, ry1, rw, Math.max(2.5, T * 0.12)).fill({ color: 0x000000, alpha: 0.36 });
          }
          g.rect(rx0, ry0, rw + (minE ? 0.6 : 0), rh + (minS ? 0.6 : 0)).fill('#43474e');

          const bevelH = Math.max(3.5, Math.round(T * 0.2));
          if (!minS) {
            g.rect(rx0, ry1 - bevelH, rw + (minE ? 0.6 : 0), bevelH).fill('#2b2e33');
          }

          const inset = Math.max(2.2, Math.round(T * 0.13));
          const tx0 = minW ? px : px + inset;
          const tx1 = minE ? px + T : px + T - inset;
          const ty0 = minN ? py : py + inset;
          const ty1 = minS ? py + T : ry1 - bevelH;
          if (tx1 > tx0 && ty1 > ty0) {
            g.rect(tx0, ty0, tx1 - tx0 + (minE ? 0.6 : 0), ty1 - ty0 + (minS ? 0.6 : 0)).fill('#525760');
          }

          // 矿脉裸露金属/晶石条带
          g.roundRect(ccx - T * 0.25, ccy - T * 0.2, T * 0.22, T * 0.15, 1.5)
            .fill(minHit.color)
            .stroke({ width: 1, color: '#181a1d' });
          g.roundRect(ccx + T * 0.04, ccy - T * 0.22, T * 0.18, T * 0.17, 1.5)
            .fill(minHit.color)
            .stroke({ width: 1, color: '#181a1d' });
          g.roundRect(ccx - T * 0.08, ccy + T * 0.02, T * 0.24, T * 0.15, 1.5)
            .fill(minHit.color)
            .stroke({ width: 1, color: '#181a1d' });

          const lineCol = '#141619';
          if (!minN) g.moveTo(rx0, ry0).lineTo(rx1 + (minE ? 0.5 : 0), ry0).stroke({ width: 1.7, color: lineCol });
          if (!minS) g.moveTo(rx0, ry1).lineTo(rx1 + (minE ? 0.5 : 0), ry1).stroke({ width: 1.9, color: lineCol });
          if (!minW) g.moveTo(rx0, ry0).lineTo(rx0, ry1 + (minS ? 0.5 : 0)).stroke({ width: 1.7, color: lineCol });
          if (!minE) g.moveTo(rx1, ry0).lineTo(rx1, ry1 + (minS ? 0.5 : 0)).stroke({ width: 1.7, color: lineCol });
        }
      }
    }
  }

  if (sim) {
    if (ruinsEnabled) {
      for (const rb of getRuinScavengeableBuildings(sim)) {
        if (rb.scavenged) continue;
        if (visSet && !visSet.has(`${Math.round(rb.pos.x)},${Math.round(rb.pos.y)}`)) continue;
        const fp = sim.world.footprintOf(rb);
        const bx = rb.pos.x * T;
        const by = rb.pos.y * T;
        const bw = fp.w * T;
        const bh = fp.h * T;
        g.roundRect(bx + 1, by + 1, bw - 2, bh - 2, 3).stroke({
          width: 1.7,
          color: 0xf5d451,
          alpha: 0.9,
        });
        g.circle(bx + bw - 5, by + 5, 3.4)
          .fill('#f5d451')
          .stroke({ width: 1.2, color: '#141619' });
      }
    }

    // RimWorld 牦牛驼兽 (Muffalo Pack Beast · 体型浑厚 1.08x)
    for (const beast of getPackBeasts(sim)) {
      const bxKey = `${Math.round(beast.pos.x)},${Math.round(beast.pos.y)}`;
      if (visSet && !visSet.has(bxKey)) continue;
      const bx = (beast.pos.x + 0.5) * T;
      const by = (beast.pos.y + 0.5) * T;
      const bs = T * 1.06;
      g.ellipse(bx, by + bs * 0.28, bs * 0.46, bs * 0.2).fill({ color: 0x000000, alpha: 0.36 });
      g.roundRect(bx - bs * 0.42, by - bs * 0.22, bs * 0.8, bs * 0.48, 7)
        .fill('#6c7a89')
        .stroke({ width: 1.8, color: '#141619' });
      g.ellipse(bx - bs * 0.04, by - bs * 0.08, bs * 0.28, bs * 0.14).fill('#8595a6');
      g.roundRect(bx - bs * 0.26, by - bs * 0.3, bs * 0.46, bs * 0.18, 2.5)
        .fill('#b07d4f')
        .stroke({ width: 1.4, color: '#1f140a' });
      g.roundRect(bx - bs * 0.26, by + bs * 0.12, bs * 0.46, bs * 0.18, 2.5)
        .fill('#9c6b3f')
        .stroke({ width: 1.4, color: '#1f140a' });
      g.moveTo(bx - bs * 0.04, by - bs * 0.3).lineTo(bx - bs * 0.04, by + bs * 0.3).stroke({ width: 1.5, color: '#f5d451' });
      g.circle(bx + bs * 0.38, by - bs * 0.04, bs * 0.2)
        .fill('#596573')
        .stroke({ width: 1.6, color: '#141619' });
      g.moveTo(bx + bs * 0.36, by - bs * 0.22).lineTo(bx + bs * 0.48, by - bs * 0.32).stroke({ width: 1.8, color: '#e6ccb2' });
      g.moveTo(bx + bs * 0.36, by + bs * 0.14).lineTo(bx + bs * 0.48, by + bs * 0.24).stroke({ width: 1.8, color: '#e6ccb2' });
    }

    for (const item of getOutdoorItems(sim)) {
      const ik = `${Math.round(item.pos.x)},${Math.round(item.pos.y)}`;
      if (visSet && !visSet.has(ik)) continue;
      const ix = (item.pos.x + 0.5) * T;
      const iy = (item.pos.y + 0.5) * T;
      drawDroppedItemStack(g, item, ix, iy, T);
    }

    // 战场遗体与按物种体型缩放的猎物尸体
    for (const corpse of getCorpses(sim)) {
      const haulerPos = corpse.hauledByEid ? visualWalk.get(corpse.hauledByEid) : undefined;
      const drawPos: Pos = haulerPos ?? corpse.pos;
      const ck = `${Math.round(drawPos.x)},${Math.round(drawPos.y)}`;
      if (visSet && !visSet.has(ck)) continue;
      const cx = (drawPos.x + 0.5) * T;
      const cy = (drawPos.y + 0.5) * T;

      if (corpse.isAnimalCorpse) {
        const furCol = corpse.animalKind === 'deer' ? '#9c6638' : corpse.animalKind === 'cat' ? '#7a5c68' : '#d8cfc4';
        const cScale = corpse.animalKind === 'rabbit' ? 0.58 : corpse.animalKind === 'cat' ? 0.74 : 0.9;
        const ct = T * cScale;
        g.ellipse(cx, cy + ct * 0.08, ct * 0.38, ct * 0.2).fill({ color: 0x5c1111, alpha: 0.52 });
        g.ellipse(cx - ct * 0.05, cy, ct * 0.3, ct * 0.18)
          .fill(furCol)
          .stroke({ width: 1.5, color: '#18120c' });
        g.circle(cx + ct * 0.22, cy - ct * 0.02, ct * 0.13)
          .fill(furCol)
          .stroke({ width: 1.3, color: '#18120c' });
        g.moveTo(cx + ct * 0.2, cy - ct * 0.05).lineTo(cx + ct * 0.27, cy + ct * 0.02);
        g.moveTo(cx + ct * 0.27, cy - ct * 0.05).lineTo(cx + ct * 0.2, cy + ct * 0.02);
        g.stroke({ width: 1.1, color: '#141619' });
        g.circle(cx, cy, ct * 0.42).stroke({ width: 1.3, color: '#ff9f43', alpha: 0.78 });
        continue;
      }

      const unlooted = !corpse.corpseLooted;
      g.ellipse(cx - T * 0.04, cy + T * 0.1, T * 0.44, T * 0.22).fill({ color: 0x4f0e0e, alpha: 0.5 });
      if (unlooted) {
        g.circle(cx, cy, T * 0.46).stroke({ width: 1.6, color: '#f5d451', alpha: 0.88 });
      }
      const coatCol = unlooted ? (corpse.isRaiderCorpse ? '#8c2d2d' : '#4a5d6e') : '#495057';
      g.roundRect(cx - T * 0.36, cy - T * 0.15, T * 0.52, T * 0.32, 4)
        .fill(coatCol)
        .stroke({ width: 1.7, color: '#141619' });
      g.circle(cx + T * 0.22, cy - T * 0.02, T * 0.17)
        .fill(unlooted ? '#d8b89c' : '#868e96')
        .stroke({ width: 1.6, color: '#141619' });
      g.moveTo(cx + T * 0.2, cy - T * 0.06).lineTo(cx + T * 0.28, cy + T * 0.02);
      g.moveTo(cx + T * 0.28, cy - T * 0.06).lineTo(cx + T * 0.2, cy + T * 0.02);
      g.stroke({ width: 1.3, color: '#141619' });
    }
  }

  const baseMarkers = [
    { x: 28, y: -22, primary: '#3d7d52', roof: '#4e9966', friendly: true },
    { x: -32, y: 26, primary: '#3b6291', roof: '#4d7eb8', friendly: true },
    { x: 36, y: 30, primary: '#8c3232', roof: '#b54040', friendly: false },
    { x: -38, y: -34, primary: '#752a2a', roof: '#9e3838', friendly: false },
  ];
  for (const bm of baseMarkers) {
    if (bm.x >= x0 - 6 && bm.x <= x1 + 6 && bm.y >= y0 - 6 && bm.y <= y1 + 6) {
      if (!visSet || visSet.has(`${bm.x},${bm.y}`)) {
        drawNpcOutpostGraphic(g, bm.x, bm.y, T, bm.primary, bm.roof, bm.friendly);
      }
    }
  }

  for (const p of view.pawns()) {
    if (!selected.has(p.eid) || !p.path || p.path.length === 0) continue;
    const vPos = visualWalk.get(p.eid) ?? p.pos;
    g.moveTo((vPos.x + 0.5) * T, (vPos.y + 0.5) * T);
    for (const pt of p.path) {
      g.lineTo((pt.x + 0.5) * T, (pt.y + 0.5) * T);
    }
    g.stroke({ width: 1.8, color: 0xffffff, alpha: 0.82 });
    const last = p.path[p.path.length - 1];
    g.circle((last.x + 0.5) * T, (last.y + 0.5) * T, T * 0.16).stroke({ width: 1.6, color: 0xf5d451 });
  }
}

export function drawFogSpansOverlay(
  g: Graphics,
  sim: Sim | null,
  visSet: Set<string> | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  T: number,
): void {
  g.clear();
  if (!visSet) return;

  for (let ty = y0; ty <= y1; ty++) {
    let spanStart: number | null = null;
    for (let tx = x0; tx <= x1; tx++) {
      const visible = visSet.has(`${tx},${ty}`);
      if (!visible) {
        if (spanStart === null) spanStart = tx;
      } else if (spanStart !== null) {
        const spanW = (tx - spanStart) * T;
        g.rect(spanStart * T, ty * T, spanW + 0.5, T + 0.5).fill({ color: 0x0b0e12, alpha: 0.82 });
        spanStart = null;
      }
    }
    if (spanStart !== null) {
      const spanW = (x1 - spanStart + 1) * T;
      g.rect(spanStart * T, ty * T, spanW + 0.5, T + 0.5).fill({ color: 0x0b0e12, alpha: 0.82 });
    }
  }

  if (sim) {
    const sources = getPlayerFogSources(sim, sim.activePlayerId);
    for (const src of sources) {
      if (src.sourceKind === 'pawn') continue;
      const ringColor = src.sourceKind === 'electric_beacon_tower' ? 0x64dfdf : 0xf5b851;
      g.circle((src.x + 0.5) * T, (src.y + 0.5) * T, src.radius * T).stroke({
        width: 1.5,
        color: ringColor,
        alpha: 0.38,
      });
    }
  }
}
