/**
 * client/render-buildings.ts —— RimWorld 1.5 原版描图级（Vector-Traced）建筑与工作台绘制模块
 *
 * 核心视觉还原（老玩家一眼认出）：
 *  1. 墙壁 (`wall`) 与房门 (`door`)：八向（含四对角内角 `nw/ne/sw/se`）无缝拼接 + 经典南侧 3D 立体阴影斜切面 + 转角加强立柱压顶石；
 *  2. 工作台操作位圆圈 (`InteractionCell`)：所有生产工作台在朝向对应侧绘制 RimWorld 标志性的白色半透明操作站位圆圈；
 *  3. 精细道具描图：屠宰台、燃木炉灶、研究台、营养膏合成机、太阳能板、蓄电池、迷你机枪塔、掩体碉堡、尖刺陷阱等。
 */
import type { Graphics } from 'pixi.js';
import type { BuildingState } from '../sim';

/** 绘制 RimWorld 标志性的工作台小人操作站位圆圈 (Interaction Cell Circle) */
function drawInteractionSpot(
  g: Graphics,
  px: number,
  py: number,
  bw: number,
  bh: number,
  T: number,
  rot: number = 0,
): void {
  const cx = px + bw / 2;
  const cy = py + bh / 2;
  const off = T * 0.48;
  const ix = rot === 1 ? px - off : rot === 3 ? px + bw + off : cx;
  const iy = rot === 2 ? py - off : rot === 0 ? py + bh + off : cy;
  const r = Math.max(4.5, T * 0.24);
  g.circle(ix, iy, r)
    .fill({ color: 0xffffff, alpha: 0.12 })
    .stroke({ width: 1.5, color: '#e9ecef', alpha: 0.68 });
  g.circle(ix, iy, r * 0.35).fill({ color: 0xffffff, alpha: 0.45 });
}

export function drawBuildingsOnGraphics(
  g: Graphics,
  allBuildings: readonly BuildingState[],
  visSet: Set<string> | null,
  T: number,
  footprintOfBuilding: (b: BuildingState) => { w: number; h: number },
  isMountainAt?: (x: number, y: number) => boolean,
): void {
  g.clear();

  const wallCells = new Set<string>();
  for (const b of allBuildings) {
    if (!b.isBlueprint && (b.defId === 'wall' || b.defId === 'door')) {
      wallCells.add(`${Math.round(b.pos.x)},${Math.round(b.pos.y)}`);
    }
  }
  const hasWallOrRock = (x: number, y: number): boolean => {
    if (wallCells.has(`${x},${y}`)) return true;
    return isMountainAt ? isMountainAt(x, y) : false;
  };

  for (const b of allBuildings) {
    if (visSet && !visSet.has(`${Math.round(b.pos.x)},${Math.round(b.pos.y)}`)) continue;

    const { w, h } = footprintOfBuilding(b);
    const px = b.pos.x * T;
    const py = b.pos.y * T;
    const bw = w * T;
    const bh = h * T;
    const cx = px + bw / 2;
    const cy = py + bh / 2;
    const rot = b.rot ?? 0;

    // 1. RimWorld 经典天蓝色半透明建造蓝图框 (Blueprint Frame) + 四角钢架折角
    if (b.isBlueprint) {
      g.rect(px + 1.5, py + 1.5, bw - 3, bh - 3)
        .fill({ color: 0x2b6cb0, alpha: 0.28 })
        .stroke({ width: 1.8, color: '#64dfdf', alpha: 0.92 });
      g.moveTo(px + 4, py + 4).lineTo(px + bw - 4, py + bh - 4);
      g.moveTo(px + bw - 4, py + 4).lineTo(px + 4, py + bh - 4);
      g.stroke({ width: 1.0, color: '#90e0ef', alpha: 0.35 });

      const cLen = Math.min(6.5, T * 0.25);
      g.moveTo(px + 3, py + 3 + cLen).lineTo(px + 3, py + 3).lineTo(px + 3 + cLen, py + 3);
      g.moveTo(px + bw - 3 - cLen, py + 3).lineTo(px + bw - 3, py + 3).lineTo(px + bw - 3, py + 3 + cLen);
      g.moveTo(px + 3, py + bh - 3 - cLen).lineTo(px + 3, py + bh - 3).lineTo(px + 3 + cLen, py + bh - 3);
      g.moveTo(px + bw - 3 - cLen, py + bh - 3).lineTo(px + bw - 3, py + bh - 3).lineTo(px + bw - 3, py + bh - 3 - cLen);
      g.stroke({ width: 1.7, color: '#ffffff', alpha: 0.85 });

      if ((b.workProgress ?? 0) > 0 && (b.workTotal ?? 24) > 0) {
        const pct = Math.min(1, (b.workProgress ?? 0) / (b.workTotal ?? 24));
        g.rect(cx - T * 0.42, cy + bh * 0.2, T * 0.84, 4.5).fill('#121518');
        g.rect(cx - T * 0.42, cy + bh * 0.2, T * 0.84 * pct, 4.5).fill('#f5d451');
      }
      continue;
    }

    switch (b.defId) {
      case 'wall': {
        const x = Math.round(b.pos.x);
        const y = Math.round(b.pos.y);
        const n = hasWallOrRock(x, y - 1);
        const s = hasWallOrRock(x, y + 1);
        const wConn = hasWallOrRock(x - 1, y);
        const eConn = hasWallOrRock(x + 1, y);
        const nw = n && wConn && hasWallOrRock(x - 1, y - 1);
        const ne = n && eConn && hasWallOrRock(x + 1, y - 1);
        const sw = s && wConn && hasWallOrRock(x - 1, y + 1);
        const se = s && eConn && hasWallOrRock(x + 1, y + 1);
        const isCorner = (n || s) && (wConn || eConn);

        const isAncient = b.ownerPlayerId === 'p_ancient_faction';
        const baseCol = isAncient ? '#5a646e' : '#8c6d49';
        const topCol = isAncient ? '#74808c' : '#ab875d';
        const southBevelCol = isAncient ? '#383f47' : '#523d26';
        const capHighlight = isAncient ? '#92a0ad' : '#c6a477';
        const lineCol = '#161412';

        // 满格无缝墙体基座（消除 L 型/T 型拐角内侧凸起或缺口）
        if (!s) {
          g.rect(px, py + T, T + (eConn ? 0.6 : 0), Math.max(3, T * 0.14)).fill({ color: 0x000000, alpha: 0.36 });
        }
        g.rect(px, py, T + (eConn ? 0.6 : 0), T + (s ? 0.6 : 0)).fill(baseCol);

        // RimWorld 标志性南侧厚立体斜切面 (South 3D Bevel) + L 型内拐角立面自然衔接
        const bevelH = Math.max(3.5, Math.round(T * 0.22));
        const inset = Math.max(2.5, Math.round(T * 0.15));
        if (!s) {
          g.rect(px, py + T - bevelH, T + (eConn ? 0.6 : 0), bevelH).fill(southBevelCol);
          if (T >= 20 && !isCorner) {
            g.moveTo(cx, py + T - bevelH).lineTo(cx, py + T).stroke({ width: 1, color: lineCol, alpha: 0.45 });
          }
        } else {
          // 当南侧有纵向延伸墙体，但西侧或东侧横向墙体在拐角处向南暴露（!sw / !se）时，补齐拐角南向 3D 斜切立面
          if (wConn && !sw) {
            g.rect(px, py + T - bevelH, inset + 0.6, bevelH).fill(southBevelCol);
          }
          if (eConn && !se) {
            g.rect(px + T - inset, py + T - bevelH, inset + 0.6, bevelH).fill(southBevelCol);
          }
        }

        // 八向自适应顶面受光层（中心柱 + 四向连接臂 + 2×2 实心对角象限），使 L/T/十 字拐角内侧边缘精确对齐
        const sTopInset = s ? inset : bevelH;
        const cW = Math.max(2, T - inset * 2);
        const cH = Math.max(2, T - inset - sTopInset);
        g.rect(px + inset, py + inset, cW, cH).fill(topCol);
        if (n) g.rect(px + inset, py, cW, inset + 0.6).fill(topCol);
        if (s) g.rect(px + inset, py + T - sTopInset, cW, sTopInset + 0.6).fill(topCol);
        if (wConn) g.rect(px, py + inset, inset + 0.6, Math.max(2, T - inset - bevelH)).fill(topCol);
        if (eConn) g.rect(px + T - inset, py + inset, inset + 0.6, Math.max(2, T - inset - bevelH)).fill(topCol);
        if (nw) g.rect(px, py, inset + 0.6, inset + 0.6).fill(topCol);
        if (ne) g.rect(px + T - inset, py, inset + 0.6, inset + 0.6).fill(topCol);
        if (sw) g.rect(px, py + T - bevelH, inset + 0.6, bevelH + 0.6).fill(topCol);
        if (se) g.rect(px + T - inset, py + T - bevelH, inset + 0.6, bevelH + 0.6).fill(topCol);

        // 转角加强立柱压顶石 (Corner Pillar Capstone)
        if (isCorner && T >= 16) {
          g.rect(px + inset + 0.8, py + inset + 0.8, cW - 1.6, cH - 1.6).stroke({
            width: 1.0,
            color: capHighlight,
            alpha: 0.45,
          });
        }

        if (isAncient && T >= 20 && ((x + y) & 1) === 0) {
          g.moveTo(cx - 3.5, cy - 2.5).lineTo(cx + 1, cy + 2).lineTo(cx + 4.5, cy - 0.5).stroke({ width: 1.2, color: '#282d33' });
        }

        // 外轮廓线与内角收边点，彻底消除转角缺口
        if (!n) g.moveTo(px, py).lineTo(px + T + (eConn ? 0.5 : 0), py).stroke({ width: 1.8, color: lineCol });
        if (!s) g.moveTo(px, py + T).lineTo(px + T + (eConn ? 0.5 : 0), py + T).stroke({ width: 2.0, color: lineCol });
        if (!wConn) g.moveTo(px, py).lineTo(px, py + T + (s ? 0.5 : 0)).stroke({ width: 1.8, color: lineCol });
        if (!eConn) g.moveTo(px + T, py).lineTo(px + T, py + T + (s ? 0.5 : 0)).stroke({ width: 1.8, color: lineCol });
        if (n && wConn && !nw) g.rect(px, py, 2.2, 2.2).fill(lineCol);
        if (n && eConn && !ne) g.rect(px + T - 2.2, py, 2.2, 2.2).fill(lineCol);
        if (s && wConn && !sw) g.rect(px, py + T - 2.2, 2.2, 2.2).fill(lineCol);
        if (s && eConn && !se) g.rect(px + T - 2.2, py + T - 2.2, 2.2, 2.2).fill(lineCol);
        break;
      }

      case 'door': {
        const x = Math.round(b.pos.x);
        const y = Math.round(b.pos.y);
        const vert = hasWallOrRock(x, y - 1) && hasWallOrRock(x, y + 1) && !hasWallOrRock(x - 1, y);
        const isAncient = b.ownerPlayerId === 'p_ancient_faction';
        const frameCol = isAncient ? '#3b424a' : '#4f3b25';
        const panelCol = isAncient ? '#6c7a89' : '#9c7851';
        const pad = Math.max(1.5, Math.round(T * 0.1));

        // 门体下方满格门槛底板（与两侧墙体无缝咬合）
        g.rect(px, py, T, T).fill({ color: isAncient ? 0x2b3036 : 0x3b2d1f, alpha: 0.72 });
        if (vert) {
          g.rect(px + pad, py, T - pad * 2, T * 0.18).fill(frameCol).stroke({ width: 1.4, color: '#141619' });
          g.rect(px + pad, py + T * 0.82, T - pad * 2, T * 0.18).fill(frameCol).stroke({ width: 1.4, color: '#141619' });
          g.rect(px + T * 0.28, py + T * 0.18, T * 0.44, T * 0.64).fill(panelCol).stroke({ width: 1.5, color: '#141619' });
          g.moveTo(px + T * 0.28, cy).lineTo(px + T * 0.72, cy).stroke({ width: 2.0, color: '#141619' });
          g.circle(cx, cy - 3, 1.5).fill(isAncient ? '#64dfdf' : '#f5d451');
          g.circle(cx, cy + 3, 1.5).fill(isAncient ? '#64dfdf' : '#f5d451');
        } else {
          g.rect(px, py + pad, T * 0.18, T - pad * 2).fill(frameCol).stroke({ width: 1.4, color: '#141619' });
          g.rect(px + T * 0.82, py + pad, T * 0.18, T - pad * 2).fill(frameCol).stroke({ width: 1.4, color: '#141619' });
          g.rect(px + T * 0.18, py + T * 0.28, T * 0.64, T * 0.44).fill(panelCol).stroke({ width: 1.5, color: '#141619' });
          g.moveTo(cx, py + T * 0.28).lineTo(cx, py + T * 0.72).stroke({ width: 2.0, color: '#141619' });
          g.circle(cx - 3, cy, 1.5).fill(isAncient ? '#64dfdf' : '#f5d451');
          g.circle(cx + 3, cy, 1.5).fill(isAncient ? '#64dfdf' : '#f5d451');
        }
        break;
      }

      case 'ancient_locker': {
        const hasLoot = !b.scavenged;
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2.5)
          .fill(hasLoot ? '#435263' : '#2c3238')
          .stroke({ width: 2, color: hasLoot ? '#64dfdf' : '#181a1d' });
        g.rect(px + 4, py + 4, bw * 0.39, bh - 8).fill(hasLoot ? '#5c7087' : '#3b424a').stroke({ width: 1, color: '#181a1d' });
        g.rect(px + bw * 0.52, py + 4, bw * 0.39, bh - 8).fill(hasLoot ? '#5c7087' : '#3b424a').stroke({ width: 1, color: '#181a1d' });
        // 百叶透气窗横纹
        g.moveTo(px + 5.5, py + 7).lineTo(px + bw * 0.38, py + 7).stroke({ width: 1, color: '#1b2229' });
        g.moveTo(px + bw * 0.56, py + 7).lineTo(px + bw - 5.5, py + 7).stroke({ width: 1, color: '#1b2229' });
        if (hasLoot) {
          g.circle(cx - 2.2, cy + 1, 1.8).fill('#f5d451');
          g.circle(cx + 2.2, cy + 1, 1.8).fill('#64dfdf');
        }
        break;
      }

      case 'ancient_crate': {
        const hasLoot = !b.scavenged;
        g.rect(px + 2.5, py + 4, bw - 3.5, bh - 3.5).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2)
          .fill(hasLoot ? '#82633d' : '#3d352b')
          .stroke({ width: 2, color: hasLoot ? '#f5d451' : '#181a1d' });
        // 军用箱 X 型加强筋与金属锁扣
        g.moveTo(px + 4, py + 4).lineTo(px + bw - 4, py + bh - 4);
        g.moveTo(px + bw - 4, py + 4).lineTo(px + 4, py + bh - 4);
        g.stroke({ width: 1.3, color: '#4a3720' });
        g.rect(cx - T * 0.18, cy - T * 0.15, T * 0.36, T * 0.3)
          .fill(hasLoot ? '#f5d451' : '#5c646d')
          .stroke({ width: 1.2, color: '#181a1d' });
        break;
      }

      case 'ancient_worktable': {
        const hasLoot = !b.scavenged;
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 3)
          .fill(hasLoot ? '#2c3a4a' : '#252a30')
          .stroke({ width: 2, color: hasLoot ? '#64dfdf' : '#181a1d' });
        // 左侧双联全息显示屏 + 右侧精密机械臂基座
        g.rect(px + 5, py + 4, bw * 0.44, bh * 0.38)
          .fill(hasLoot ? '#0b3954' : '#1a1f24')
          .stroke({ width: 1.2, color: hasLoot ? '#64dfdf' : '#384048' });
        if (hasLoot) {
          g.moveTo(px + 7, py + 7).lineTo(px + bw * 0.42, py + 7).stroke({ width: 1.2, color: '#64dfdf' });
          g.moveTo(px + 7, py + 10).lineTo(px + bw * 0.32, py + 10).stroke({ width: 1.2, color: '#80ffdb' });
        }
        g.circle(px + bw * 0.74, cy + 2, T * 0.22).fill('#495057').stroke({ width: 1.2, color: '#16191d' });
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      case 'ancient_cryptosleep_casket': {
        const hasLoot = !b.scavenged;
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.4 });
        g.roundRect(px + 2.5, py + 2, bw - 5, bh - 4, 4.5)
          .fill(hasLoot ? '#364958' : '#262b30')
          .stroke({ width: 2, color: '#14171a' });
        // 休眠舱椭圆形低温观察视窗 + 肋骨状液压横梁
        g.roundRect(px + bw * 0.22, py + bh * 0.14, bw * 0.56, bh * 0.5, 4)
          .fill(hasLoot ? '#48bfe3' : '#1f2429')
          .stroke({ width: 1.4, color: hasLoot ? '#caf0f8' : '#343a40' });
        g.moveTo(px + 3, py + bh * 0.74).lineTo(px + bw - 3, py + bh * 0.74).stroke({ width: 1.6, color: '#1b2026' });
        break;
      }

      // ==================== 殖民地核心床铺与家具 ====================
      case 'bed': {
        // RimWorld 木架单人床 (1×2)：深木外框、北侧白色软枕、南侧条纹被褥与折边
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.34 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2.5)
          .fill('#6f4e37')
          .stroke({ width: 2, color: '#1a1410' });
        if (bh >= bw) {
          // 纵向床铺
          g.roundRect(px + 4.5, py + 5, bw - 9, bh * 0.24, 2)
            .fill('#f1faee')
            .stroke({ width: 1.1, color: '#adb5bd' });
          g.rect(px + 4, py + bh * 0.33, bw - 8, bh * 0.59)
            .fill('#3d5a80')
            .stroke({ width: 1.2, color: '#1d2d44' });
          g.rect(px + 4, py + bh * 0.33, bw - 8, bh * 0.11).fill('#98c1d9');
        } else {
          // 横向旋转床铺
          g.roundRect(px + 5, py + 4.5, bw * 0.24, bh - 9, 2)
            .fill('#f1faee')
            .stroke({ width: 1.1, color: '#adb5bd' });
          g.rect(px + bw * 0.33, py + 4, bw * 0.59, bh - 8)
            .fill('#3d5a80')
            .stroke({ width: 1.2, color: '#1d2d44' });
          g.rect(px + bw * 0.33, py + 4, bw * 0.11, bh - 8).fill('#98c1d9');
        }
        break;
      }

      case 'campfire':
      case 'great_bonfire': {
        const isGreat = b.defId === 'great_bonfire';
        const r = Math.min(bw, bh) * (isGreat ? 0.43 : 0.38);
        // 温暖火光光晕圈
        g.circle(cx, cy, r * 1.45).fill({ color: 0xff7b00, alpha: isGreat ? 0.22 : 0.14 });
        // 环形鹅卵石围石圈
        const stoneCount = isGreat ? 10 : 8;
        for (let i = 0; i < stoneCount; i++) {
          const ang = (i / stoneCount) * Math.PI * 2;
          const sx = cx + Math.cos(ang) * (r * 0.88);
          const sy = cy + Math.sin(ang) * (r * 0.88);
          g.circle(sx, sy, isGreat ? 4.2 : 2.8).fill('#6c757d').stroke({ width: 1.1, color: '#1b1e22' });
        }
        // 交错干柴木棍
        g.moveTo(cx - r * 0.58, cy - r * 0.35).lineTo(cx + r * 0.58, cy + r * 0.35);
        g.moveTo(cx + r * 0.58, cy - r * 0.35).lineTo(cx - r * 0.58, cy + r * 0.35);
        g.stroke({ width: isGreat ? 4 : 3, color: '#5c3d24' });
        // 双层跳动火焰（外焰赤橙 + 内焰亮黄 + 白芯）
        g.circle(cx, cy - 1, r * 0.54).fill('#e85d04').stroke({ width: 1.2, color: '#9d0208' });
        g.circle(cx, cy - 2, r * 0.34).fill('#ffba08');
        g.circle(cx, cy - 2.5, r * 0.16).fill('#ffffff');
        break;
      }

      case 'shelf': {
        // RimWorld 双格储物架 (2×1)：分层木格板 + 整齐堆叠的物资箱与布袋
        g.rect(px + 2, py + 3.5, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.35 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2)
          .fill('#6c5037')
          .stroke({ width: 1.8, color: '#1a140e' });
        g.rect(px + 4, py + 4, bw - 8, bh - 8).fill('#4a3525');
        g.moveTo(px + 3, cy).lineTo(px + bw - 3, cy).stroke({ width: 1.6, color: '#8a6849' });
        g.moveTo(cx, py + 3).lineTo(cx, py + bh - 3).stroke({ width: 1.6, color: '#8a6849' });
        // 货架内微缩物资包
        g.rect(px + 6, py + 5, T * 0.3, T * 0.25).fill('#d4a373').stroke({ width: 1, color: '#1d1812' });
        g.circle(cx + T * 0.24, cy - T * 0.14, T * 0.14).fill('#52b788').stroke({ width: 1, color: '#1d1812' });
        break;
      }

      // ==================== 生产工作台（带原版 InteractionSpot 圆圈） ====================
      case 'butcher_table': {
        // RimWorld 屠宰台 (2×1)：厚重实木案板、鲜红剁肉区、寒光剁骨刀、右侧收集木桶
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.36 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2.5)
          .fill('#7f5539')
          .stroke({ width: 2, color: '#1a120b' });
        g.rect(px + 4.5, py + 4.5, bw - 9, bh - 9).fill('#9c6644');
        // 白色切肉砧板与鲜肉块
        const boardX = w >= h ? px + 6 : px + 4.5;
        const boardY = w >= h ? py + 5.5 : py + 6;
        g.rect(boardX, boardY, T * 0.68, T * 0.52)
          .fill('#e5d5c5')
          .stroke({ width: 1, color: '#4a3525' });
        g.ellipse(boardX + T * 0.34, boardY + T * 0.26, T * 0.22, T * 0.14)
          .fill('#bc4749')
          .stroke({ width: 1, color: '#6a040f' });
        // 银白剁骨刀
        g.rect(cx + 1, cy - 4, T * 0.28, T * 0.18).fill('#dee2e6').stroke({ width: 1, color: '#212529' });
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      case 'stove': {
        // RimWorld 燃木/电炉灶 (2×1)：深灰铸铁机身、双火圈炉眼、沸腾铁锅、排烟管与底部添柴火门
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.4 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 3)
          .fill('#343a40')
          .stroke({ width: 2, color: '#111315' });
        g.rect(px + 4.5, py + 4.5, bw - 9, bh - 11).fill('#495057');

        const b1x = w >= h ? px + T * 0.52 : cx;
        const b1y = w >= h ? cy - 1 : py + T * 0.52;
        const b2x = w >= h ? px + T * 1.48 : cx;
        const b2y = w >= h ? cy - 1 : py + T * 1.48;

        // 左炉眼：通红炉火圈
        g.circle(b1x, b1y, T * 0.27).fill('#212529').stroke({ width: 1.5, color: '#ff7b00' });
        g.circle(b1x, b1y, T * 0.14).fill('#ffb703');
        // 右炉眼：炖煮浓汤铁锅
        g.circle(b2x, b2y, T * 0.29).fill('#2b2d42').stroke({ width: 1.5, color: '#111315' });
        g.circle(b2x, b2y, T * 0.2).fill('#e09f3e');

        // 底部橘红炉膛透光缝
        g.rect(cx - T * 0.35, py + bh - 5.5, T * 0.7, 3).fill('#ff5400');
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      case 'nutrient_paste_dispenser': {
        // RimWorld 营养膏合成机 (2×2)：工业钢壳、中央大型翠绿生物搅拌罐、北侧进料斗、南侧出餐盘
        g.rect(px + 2.5, py + 4.5, bw - 4, bh - 4).fill({ color: 0x000000, alpha: 0.42 });
        g.roundRect(px + 2.5, py + 2.5, bw - 5, bh - 5, 4)
          .fill('#4a5759')
          .stroke({ width: 2.2, color: '#161a1d' });
        g.rect(px + 6, py + 6, bw - 12, bh - 14).fill('#6b705c');
        // 中央翠绿营养液合成反应釜
        g.circle(cx, cy - 2, Math.min(bw, bh) * 0.28)
          .fill('#2d6a4f')
          .stroke({ width: 2, color: '#d8f3dc' });
        g.circle(cx - 3, cy - 5, Math.min(bw, bh) * 0.1).fill('#74c69d');
        // 南侧金属出餐槽
        g.rect(cx - T * 0.45, py + bh - 9, T * 0.9, 6)
          .fill('#adb5bd')
          .stroke({ width: 1.2, color: '#161a1d' });
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      case 'research_bench': {
        // RimWorld 研究工作台 (2×1)：长条橡木桌面、蓝皮典籍、散落图纸、黄铜光学显微镜
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.36 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 2.5)
          .fill('#6c462b')
          .stroke({ width: 2, color: '#18120b' });
        g.rect(px + 4.5, py + 4.5, bw - 9, bh - 9).fill('#8d5b38');
        // 摊开的白色研究手稿与蓝皮书
        g.rect(px + 7, py + 6, T * 0.52, T * 0.42)
          .fill('#f8f9fa')
          .stroke({ width: 1, color: '#495057' });
        g.rect(cx + 2, py + 6, T * 0.42, T * 0.36)
          .fill('#1d3557')
          .stroke({ width: 1, color: '#a8dadc' });
        // 黄铜显微镜底座
        g.circle(cx - 2, cy + 2, T * 0.14).fill('#f5d451').stroke({ width: 1, color: '#18120b' });
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      // ==================== 电力与照明设施 ====================
      case 'wood_generator': {
        // RimWorld 燃木发电机 (2×2)：深褐工业机座、左侧赤铜励磁线圈、右侧燃烧室与排烟囱
        g.rect(px + 2.5, py + 4.5, bw - 4, bh - 4).fill({ color: 0x000000, alpha: 0.4 });
        g.roundRect(px + 2.5, py + 2.5, bw - 5, bh - 5, 4)
          .fill('#495057')
          .stroke({ width: 2.2, color: '#141619' });
        // 铜制发电飞轮线圈
        g.circle(cx - T * 0.35, cy, T * 0.42)
          .fill('#b5651d')
          .stroke({ width: 2, color: '#1b1e22' });
        g.circle(cx - T * 0.35, cy, T * 0.18).fill('#adb5bd');
        // 右侧火炉腔体与红热观察窗
        g.roundRect(cx + T * 0.08, cy - T * 0.48, T * 0.68, T * 0.96, 3)
          .fill('#2b2d42')
          .stroke({ width: 1.5, color: '#141619' });
        g.rect(cx + T * 0.2, cy + T * 0.1, T * 0.44, T * 0.24).fill('#ff6b35');
        break;
      }

      case 'solar_generator': {
        // RimWorld 太阳能板 (3×3)：银灰阳极铝外框、深海蓝单晶硅电池矩阵 (3×4 分格)、银白主汇流条
        g.rect(px + 3, py + 5, bw - 4, bh - 4).fill({ color: 0x000000, alpha: 0.42 });
        g.roundRect(px + 2.5, py + 2.5, bw - 5, bh - 5, 3)
          .fill('#adb5bd')
          .stroke({ width: 2.2, color: '#16191d' });
        const pad = 6;
        const pw = bw - pad * 2;
        const ph = bh - pad * 2;
        g.rect(px + pad, py + pad, pw, ph).fill('#102a43').stroke({ width: 1.4, color: '#243b53' });

        // 硅晶网格线
        for (let c = 1; c <= 3; c++) {
          const lx = px + pad + (pw * c) / 4;
          g.moveTo(lx, py + pad).lineTo(lx, py + pad + ph);
        }
        for (let r = 1; r <= 2; r++) {
          const ly = py + pad + (ph * r) / 3;
          g.moveTo(px + pad, ly).lineTo(px + pad + pw, ly);
        }
        g.stroke({ width: 1.1, color: '#48cae4', alpha: 0.55 });
        // 中央银色导电汇流排
        g.moveTo(px + pad, cy).lineTo(px + pad + pw, cy).stroke({ width: 2.0, color: '#dee2e6', alpha: 0.8 });
        break;
      }

      case 'battery': {
        // RimWorld 蓄电池组 (1×2)：深灰装甲电池柜、红蓝正负极接线柱、中央亮黄电量液位格栅
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 2.5, py + 2.5, bw - 5, bh - 5, 2.5)
          .fill('#2b3035')
          .stroke({ width: 2, color: '#111315' });
        g.rect(px + 5, py + 8, bw - 10, bh - 15)
          .fill('#181b1e')
          .stroke({ width: 1, color: '#495057' });
        // 满格金黄储能指示条
        g.rect(px + 6.5, py + 10, bw - 13, bh - 19).fill('#f5d451');
        // 顶部红(+)蓝(-)极柱
        g.circle(cx - 3.5, py + 5.5, 2.0).fill('#ef233c');
        g.circle(cx + 3.5, py + 5.5, 2.0).fill('#3a86ff');
        break;
      }

      case 'power_conduit': {
        // RimWorld 地面绝缘电缆：深灰护套 + 青色能量芯节点
        g.rect(cx - T * 0.16, cy - T * 0.16, T * 0.32, T * 0.32)
          .fill('#2b323b')
          .stroke({ width: 1.4, color: '#64dfdf' });
        g.circle(cx, cy, 2.2).fill('#64dfdf');
        break;
      }

      case 'electric_beacon_tower': {
        // RimWorld 电弧探照灯塔 (2×2)：钢铁桁架底座 + 强光青蓝电弧透镜灯头
        g.circle(cx, cy, Math.min(bw, bh) * 0.65).fill({ color: 0x64dfdf, alpha: 0.14 });
        g.roundRect(px + 3, py + 3, bw - 6, bh - 6, 4)
          .fill('#2b3440')
          .stroke({ width: 2.2, color: '#14171a' });
        g.moveTo(px + 5, py + 5).lineTo(px + bw - 5, py + bh - 5);
        g.moveTo(px + bw - 5, py + 5).lineTo(px + 5, py + bh - 5);
        g.stroke({ width: 1.6, color: '#6c757d' });
        g.circle(cx, cy, Math.min(bw, bh) * 0.28)
          .fill('#00b4d8')
          .stroke({ width: 2, color: '#caf0f8' });
        g.circle(cx, cy, Math.min(bw, bh) * 0.13).fill('#ffffff');
        break;
      }

      // ==================== 防卫工事与农业区 ====================
      case 'turret': {
        // RimWorld 迷你机枪塔 (Mini-Turret)：外圈四面米黄沙袋护墙 + 三脚钢架 + 军绿弹药箱 + 双联枪管
        g.rect(px + 1.5, py + 1.5, bw - 3, bh - 3)
          .fill('#b09868')
          .stroke({ width: 1.8, color: '#2b2316' });
        g.rect(px + 4, py + 4, bw - 8, bh - 8).fill('#282c30');
        // 三脚底座与中心旋转炮塔座
        g.circle(cx, cy, T * 0.26).fill('#495057').stroke({ width: 1.6, color: '#111315' });
        // 侧面军绿弹药箱
        g.rect(cx - T * 0.34, cy - T * 0.14, T * 0.2, T * 0.28)
          .fill('#4a5d23')
          .stroke({ width: 1, color: '#111315' });
        // 朝向枪管
        const dirX = rot === 1 ? -1 : rot === 3 ? 1 : 0;
        const dirY = rot === 2 ? -1 : rot === 0 ? 1 : 1;
        const bLen = T * 0.44;
        g.moveTo(cx, cy).lineTo(cx + dirX * bLen || cx + bLen * 0.85, cy + (dirX === 0 ? dirY * bLen : 0))
          .stroke({ width: 3.4, color: '#111315' });
        g.moveTo(cx, cy).lineTo(cx + dirX * bLen || cx + bLen * 0.85, cy + (dirX === 0 ? dirY * bLen : 0))
          .stroke({ width: 1.6, color: '#adb5bd' });
        break;
      }

      case 'tower': {
        // RimWorld 沙袋掩体防线碉堡 (2×2)：四边交错叠砌的米黄色防弹沙袋包 + 战术射击地坪
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 4)
          .fill('#c2a878')
          .stroke({ width: 2.2, color: '#2b2316' });
        const sbThick = Math.max(5.5, T * 0.26);
        g.roundRect(px + sbThick, py + sbThick, bw - sbThick * 2, bh - sbThick * 2, 2)
          .fill('#3b4248')
          .stroke({ width: 1.5, color: '#212529' });
        // 沙袋接缝刻度线
        for (let o = 0.25; o <= 0.75; o += 0.25) {
          g.moveTo(px + bw * o, py + 2).lineTo(px + bw * o, py + sbThick);
          g.moveTo(px + bw * o, py + bh - sbThick).lineTo(px + bw * o, py + bh - 2);
          g.moveTo(px + 2, py + bh * o).lineTo(px + sbThick, py + bh * o);
          g.moveTo(px + bw - sbThick, py + bh * o).lineTo(px + bw - 2, py + bh * o);
        }
        g.stroke({ width: 1.2, color: '#5c4d32' });
        break;
      }

      case 'trap': {
        // RimWorld 落锤尖刺陷阱 (Deadfall Spike Trap)：木质方框 + 4 根交错寒光铁刺
        g.rect(px + 3, py + 3, bw - 6, bh - 6)
          .fill({ color: 0x4a3520, alpha: 0.78 })
          .stroke({ width: 1.6, color: '#1f160d' });
        for (const ox of [-0.22, 0.0, 0.22]) {
          const sx = cx + ox * T;
          g.moveTo(sx - 2.5, cy + 4)
            .lineTo(sx, cy - 4.5)
            .lineTo(sx + 2.5, cy + 4)
            .fill('#dee2e6')
            .stroke({ width: 1, color: '#212529' });
        }
        break;
      }

      case 'field': {
        // RimWorld 耕作农田区 (2×2)：深褐翻耕垄沟 + 整齐排列的翠绿作物幼苗
        g.roundRect(px + 1.5, py + 1.5, bw - 3, bh - 3, 2)
          .fill('#463521')
          .stroke({ width: 1.5, color: '#6b8e23', alpha: 0.75 });
        for (let r = 0; r < 4; r++) {
          const fy = py + 5 + r * ((bh - 10) / 3.2);
          g.moveTo(px + 4, fy).lineTo(px + bw - 4, fy).stroke({ width: 2.2, color: '#332617' });
          for (let c = 0; c < 4; c++) {
            const fx = px + 6 + c * ((bw - 12) / 3);
            g.circle(fx, fy - 1, 2.3).fill('#70e000').stroke({ width: 0.8, color: '#2b580c' });
          }
        }
        break;
      }

      case 'nest': {
        // 殖民地核心主基地 (2×2)：高耸金属主堡拱顶 + 金色派系徽记星环
        g.rect(px + 3, py + 5, bw - 4, bh - 4).fill({ color: 0x000000, alpha: 0.45 });
        g.roundRect(px + 2.5, py + 2.5, bw - 5, bh - 5, 5)
          .fill('#5c4738')
          .stroke({ width: 2.5, color: '#f5d451' });
        g.roundRect(px + 7, py + 7, bw - 14, bh - 14, 3)
          .fill('#8a6a52')
          .stroke({ width: 1.5, color: '#241c15' });
        g.circle(cx, cy, Math.min(bw, bh) * 0.22)
          .fill('#f5d451')
          .stroke({ width: 1.8, color: '#241c15' });
        break;
      }

      case 'grave': {
        // RimWorld 坟墓 (1×2)：北侧弧顶灰色花岗岩墓碑与十字刻痕 + 南侧培土坟包
        g.roundRect(px + 3, py + 3, bw - 6, bh - 6, 3)
          .fill('#4a3b2c')
          .stroke({ width: 1.6, color: '#1e1812' });
        // 北侧石碑
        g.roundRect(px + 4.5, py + 4, bw - 9, T * 0.55, 3)
          .fill('#8d99ae')
          .stroke({ width: 1.4, color: '#2b2d42' });
        // 南侧隆起土丘
        g.ellipse(cx, py + bh * 0.65, bw * 0.3, bh * 0.24)
          .fill('#6c584c')
          .stroke({ width: 1.1, color: '#3d312a' });
        if (b.buriedPawnName) {
          g.circle(cx, py + T * 0.3, 2.2).fill('#f5d451');
        }
        break;
      }

      case 'slope': {
        // 石砌台阶斜坡：清晰的多级防滑石阶踏步与两侧石护栏
        g.rect(px + 2, py + 2, bw - 4, bh - 4)
          .fill('#7f7970')
          .stroke({ width: 1.6, color: '#2b2927' });
        for (let s = 1; s <= 3; s++) {
          const sy = py + (bh * s) / 4;
          g.moveTo(px + 3, sy).lineTo(px + bw - 3, sy).stroke({ width: 1.5, color: '#3d3a36' });
        }
        break;
      }

      case 'wind_turbine': {
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.38 });
        g.roundRect(px + 3, py + 3, bw - 6, bh - 6, 4).fill('#343a40').stroke({ width: 2.2, color: '#141619' });
        g.circle(cx, cy, Math.min(bw, bh) * 0.22).fill('#adb5bd').stroke({ width: 1.8, color: '#141619' });
        const rBlade = Math.max(bw, bh) * 0.44;
        for (const ang of [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]) {
          const bx = cx + Math.cos(ang) * rBlade;
          const by = cy + Math.sin(ang) * rBlade;
          g.moveTo(cx, cy).lineTo(bx, by).stroke({ width: 4.2, color: '#f8f9fa' });
          g.moveTo(cx, cy).lineTo(bx, by).stroke({ width: 1.6, color: '#64dfdf' });
        }
        g.circle(cx, cy, T * 0.16).fill('#64dfdf').stroke({ width: 1.4, color: '#141619' });
        break;
      }

      case 'dining_table': {
        g.roundRect(px + 3, py + 3, bw - 6, bh - 6, 3).fill('#7f5539').stroke({ width: 2, color: '#1a120b' });
        g.rect(px + 5, py + 5, bw - 10, bh - 10).fill('#b08968');
        g.circle(cx - T * 0.32, cy, T * 0.16).fill('#f8f9fa');
        g.circle(cx + T * 0.32, cy, T * 0.16).fill('#f5d451');
        break;
      }

      case 'plant_pot': {
        g.circle(cx, cy + 2, T * 0.34).fill({ color: 0x000000, alpha: 0.32 });
        g.circle(cx, cy, T * 0.34).fill('#bc6c25').stroke({ width: 1.8, color: '#18120b' });
        g.circle(cx, cy, T * 0.24).fill('#3b2818');
        g.circle(cx - 2.5, cy - 2, T * 0.18).fill('#40916c');
        g.circle(cx + 2.5, cy - 1.5, T * 0.17).fill('#52b788');
        g.circle(cx, cy - 3.5, T * 0.16).fill('#74c69d');
        break;
      }

      case 'art_sculpture': {
        g.rect(px + 3, py + 4, bw - 6, bh - 5).fill({ color: 0x000000, alpha: 0.36 });
        g.roundRect(px + 3, py + bh * 0.58, bw - 6, bh * 0.32, 2).fill('#6c757d').stroke({ width: 1.6, color: '#141619' });
        g.circle(cx, cy - T * 0.08, T * 0.26).fill('#f5d451').stroke({ width: 1.8, color: '#141619' });
        g.circle(cx - 2, cy - T * 0.14, T * 0.09).fill('#ffffff');
        break;
      }

      case 'standing_lamp': {
        g.circle(cx, cy, T * 1.1).fill({ color: 0xffe066, alpha: 0.15 });
        g.circle(cx, cy, T * 0.28).fill('#ffe066').stroke({ width: 1.6, color: '#141619' });
        g.circle(cx, cy, T * 0.13).fill('#ffffff');
        break;
      }

      case 'royal_carpet': {
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 3).fill({ color: 0x800f2f, alpha: 0.82 }).stroke({ width: 2, color: '#f5d451' });
        g.roundRect(px + 6, py + 6, bw - 12, bh - 12, 2).stroke({ width: 1.2, color: '#ffccd5' });
        g.circle(cx, cy, T * 0.25).fill({ color: 0xf5d451, alpha: 0.65 });
        break;
      }

      case 'spice_prep_table': {
        g.rect(px + 2, py + 4, bw - 3, bh - 3).fill({ color: 0x000000, alpha: 0.36 });
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 3).fill('#6c462b').stroke({ width: 2, color: '#18120b' });
        g.rect(px + 4.5, py + 4.5, bw - 9, bh - 11).fill('#9c6644');
        const b1x = w >= h ? px + T * 0.5 : cx;
        const b1y = w >= h ? cy - 1 : py + T * 0.5;
        const b2x = w >= h ? px + T * 1.45 : cx;
        const b2y = w >= h ? cy - 1 : py + T * 1.45;
        g.circle(b1x - 3, b1y, T * 0.16).fill('#e63946').stroke({ width: 1, color: '#141619' });
        g.circle(b1x + 4, b1y + 1, T * 0.15).fill('#ffb703').stroke({ width: 1, color: '#141619' });
        g.circle(b2x, b2y, T * 0.22).fill('#52b788').stroke({ width: 1.2, color: '#141619' });
        drawInteractionSpot(g, px, py, bw, bh, T, rot);
        break;
      }

      default: {
        const isBiotech = b.defId === 'gene_assembler';
        const isRoyalty = b.defId === 'royal_throne';
        const isIdeology = b.defId === 'ideology_altar';
        const borderCol = isBiotech ? '#3a8fb7' : isRoyalty ? '#d4af37' : isIdeology ? '#8a5cf5' : '#7b8894';
        g.roundRect(px + 2, py + 2, bw - 4, bh - 4, 4).fill('#2b323b').stroke({ width: 2.5, color: borderCol });
        g.circle(cx, cy, Math.min(bw, bh) * 0.28).fill(borderCol).stroke({ width: 1.5, color: '#ffffff' });
        break;
      }
    }
  }
}
