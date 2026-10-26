/**
 * client/render-entities.ts —— RimWorld 原版向量描图级（Vector-Traced）角色、机械族、按物种真实体型缩放的野生动物与自然乔木绘制模块。
 *
 * 视觉识别特征（RimWorld 1.4/1.5 & Ratkin Plus 描图级规范）：
 *  1. 殖民者 (Pawn)：经典的「无四肢上窄下宽圆角梯形躯干」+ 2px 粗黑外轮廓 (#141619) + 底部内阴影暗边 +
 *     外套翻领/护肩装甲板 + 独立圆润头部与多样性发型/头盔 + 漂浮双手持握具象武器或劳作工具箱 + 精神崩溃荒野游民标识；
 *  2. 敌袭者与机械族 (Hostiles)：海盗掠夺者、防暴盾卫、海盗头目、攻城机械蜈蚣；
 *  3. 野生动物真实体型层级 (RimWorld BodySize Proportions)：
 *     - 野兔 (`rabbit` · 0.55x 小型啮齿动物)：娇小蜷缩躯体+长立耳+短绒尾；
 *     - 野猫 (`cat` · 0.72x 中小型掠食兽)：流线型矫健躯干+竖耳+长尾；
 *     - 牡鹿 (`deer` · 0.88x 中大型食草兽)：修长鹿躯+白色尾绒+分叉鹿角；
 *  4. 乔木 (Trees)：占地 1×1，保留丰满 2×2 视觉树冠贴图（橡树 Oak / 松树 Pine / 白杨 Poplar）。
 */
import { type Container, Graphics } from 'pixi.js';
import type { Hostile, PawnState, RuinScavengeSite } from '../sim';
import { TRAIT_COLOR } from './presentation';

export interface PawnSprite {
  root: Container;
  body: Graphics;
  bars: Graphics;
  key: string;
}

/** 描图辅助：绘制闭合多边形路径（兼容 FakeGraphics 单测与 Canvas2D） */
function tracePoly(g: Graphics, pts: readonly [number, number][]): Graphics {
  if (pts.length === 0) return g;
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    g.lineTo(pts[i][0], pts[i][1]);
  }
  g.lineTo(pts[0][0], pts[0][1]);
  return g;
}

/**
 * RimWorld 经典丰满乔木贴图（占地 1×1，保留大幅树冠视觉，支持橡树 Oak / 松树 Pine / 白杨 Poplar 描图剪影）
 */
export function drawTwoByTwoTreeGraphic(T: number, variantSeed = 0): Graphics {
  const g = new Graphics();
  const r = T * 0.82;
  const kind = Math.abs(variantSeed) % 3; // 0=Oak, 1=Pine, 2=Poplar

  // 1. 地面柔和椭圆投影
  g.ellipse(0, T * 0.48, r * 0.9, T * 0.32).fill({ color: 0x000000, alpha: 0.34 });

  // 2. 粗壮分叉树干与暴露树根（RimWorld 标志性深棕黑边树干）
  tracePoly(g, [
    [-T * 0.24, T * 0.52],
    [-T * 0.14, T * 0.18],
    [-T * 0.13, -T * 0.08],
    [T * 0.13, -T * 0.08],
    [T * 0.14, T * 0.18],
    [T * 0.24, T * 0.52],
    [T * 0.06, T * 0.46],
    [-T * 0.06, T * 0.46],
  ])
    .fill('#634328')
    .stroke({ width: 1.8, color: '#1b130b' });
  g.rect(-T * 0.08, -T * 0.02, T * 0.06, T * 0.42).fill({ color: 0x8a6240, alpha: 0.65 });

  if (kind === 1) {
    // ---- 松树 (RimWorld Pine Tree)：三层伞状针叶锯齿塔冠 ----
    const layers: Array<[number, number, number, string, string]> = [
      [T * 0.06, r * 0.95, T * 0.52, '#243b24', '#314f31'],
      [-T * 0.24, r * 0.76, T * 0.46, '#2d4a2d', '#3d633d'],
      [-T * 0.54, r * 0.52, T * 0.4, '#385c38', '#4c784c'],
    ];
    for (const [baseY, halfW, h, darkCol, lightCol] of layers) {
      tracePoly(g, [
        [0, baseY - h],
        [halfW, baseY],
        [halfW * 0.55, baseY + T * 0.06],
        [0, baseY - T * 0.02],
        [-halfW * 0.55, baseY + T * 0.06],
        [-halfW, baseY],
      ])
        .fill(darkCol)
        .stroke({ width: 2, color: '#132013' });
      tracePoly(g, [
        [0, baseY - h + 2],
        [halfW * 0.68, baseY - 2],
        [0, baseY - T * 0.08],
        [-halfW * 0.68, baseY - 2],
      ]).fill(lightCol);
    }
    return g;
  }

  const cDark = kind === 2 ? '#595428' : '#283d20';
  const cMid = kind === 2 ? '#787033' : '#36542b';
  const cLight = kind === 2 ? '#968c40' : '#486e39';
  const cHi = kind === 2 ? '#b3a74c' : '#5c8749';

  // ---- 橡树 / 白杨 (RimWorld Oak / Poplar)：厚黑边多球交叠丰满树冠 ----
  g.circle(0, -T * 0.2, r * 0.84).fill(cDark).stroke({ width: 2.2, color: '#141f10' });
  g.circle(-r * 0.42, -T * 0.08, r * 0.54).fill(cDark).stroke({ width: 2, color: '#141f10' });
  g.circle(r * 0.42, -T * 0.08, r * 0.54).fill(cDark).stroke({ width: 2, color: '#141f10' });
  g.circle(0, -T * 0.44, r * 0.62).fill(cDark).stroke({ width: 2, color: '#141f10' });

  g.circle(-r * 0.34, -T * 0.1, r * 0.46).fill(cMid);
  g.circle(r * 0.34, -T * 0.08, r * 0.45).fill(cMid);
  g.circle(0, -T * 0.22, r * 0.68).fill(cMid);
  g.circle(-r * 0.16, -T * 0.34, r * 0.48).fill(cLight);
  g.circle(r * 0.18, -T * 0.28, r * 0.38).fill(cLight);
  g.circle(-r * 0.12, -T * 0.44, r * 0.28).fill(cHi);
  return g;
}

export function drawRuinSiteGraphic(_g: Graphics, _site: RuinScavengeSite, _T: number): void {
  // 遗迹由残破石墙房间与室内可搜刮建筑构成（已独立为 DLC）
}

export function drawNpcOutpostGraphic(
  g: Graphics,
  cxTile: number,
  cyTile: number,
  T: number,
  primary: string,
  roof: string,
  friendly: boolean,
): void {
  const x0 = (cxTile - 2) * T;
  const y0 = (cyTile - 2) * T;
  const span = 5 * T;
  g.roundRect(x0, y0, span, span, 6)
    .fill({ color: friendly ? 0x28382e : 0x3b2424, alpha: 0.9 })
    .stroke({ width: 2.6, color: '#181a1d' });
  g.roundRect(x0 + 3, y0 + 3, span - 6, span - 6, 4)
    .stroke({ width: 1.8, color: primary, alpha: 0.85 });

  const bastion = T * 0.92;
  for (const [bx, by] of [
    [x0 + 2, y0 + 2],
    [x0 + span - bastion - 2, y0 + 2],
    [x0 + 2, y0 + span - bastion - 2],
    [x0 + span - bastion - 2, y0 + span - bastion - 2],
  ]) {
    g.rect(bx, by, bastion, bastion).fill('#4a525a').stroke({ width: 2, color: '#181a1d' });
    g.rect(bx + 3, by + bastion - 5, bastion - 6, 3.5).fill('#2f353b');
    g.circle(bx + bastion / 2, by + bastion / 2, bastion * 0.26)
      .fill(primary)
      .stroke({ width: 1.2, color: '#181a1d' });
  }
  const keepX = (cxTile - 0.85) * T;
  const keepY = (cyTile - 0.85) * T;
  const keepW = 2.7 * T;
  g.roundRect(keepX, keepY, keepW, keepW, 4)
    .fill(roof)
    .stroke({ width: 2.4, color: '#16191d' });
  g.moveTo(keepX + 4, keepY + keepW * 0.5).lineTo(keepX + keepW - 4, keepY + keepW * 0.5).stroke({ width: 1.5, color: '#16191d' });
  const midX = (cxTile + 0.5) * T;
  const midY = (cyTile + 0.5) * T;
  g.circle(midX, midY, T * 0.46).fill('#1d2228').stroke({ width: 2.2, color: '#f5d451' });
  if (friendly) {
    g.rect(midX - 4.5, midY - 4.5, 9, 9).fill('#64dfdf').stroke({ width: 1.2, color: '#181a1d' });
  } else {
    g.moveTo(midX - 6, midY - 6).lineTo(midX + 6, midY + 6);
    g.moveTo(midX + 6, midY - 6).lineTo(midX - 6, midY + 6);
    g.stroke({ width: 2.8, color: '#ff5252' });
  }
}

/**
 * 绘制单个 RimWorld 殖民者图元（描图级原版比例）
 */
export function redrawPawnGraphic(
  sp: PawnSprite,
  p: PawnState,
  selected: boolean,
  T: number,
  compactLod = false,
): void {
  const b = sp.body;
  b.clear();
  const s = T / 26;

  const isWildMan = Boolean(p.formerColonist || p.mentalBreakState === 'wild_man');
  const coatColor = isWildMan
    ? '#8c5e3c'
    : p.isStranger
      ? '#6c5ce7'
      : p.xenotype === 'ratkin_vanguard'
        ? '#355c8a'
        : (TRAIT_COLOR[p.trait] ?? '#8f6b52');

  const hairPalette = ['#3b281e', '#5c4028', '#242024', '#8c5230', '#c49a45', '#4a3b32'];
  const hairCol = hairPalette[Math.abs(p.eid) % hairPalette.length];
  const isRatkin = (p.xenotype ?? 'ratkin') !== 'baseliner';
  const isSleeping = p.cardId === 'sleep';

  if (compactLod && !selected) {
    if (isRatkin) {
      b.circle(-4.8 * s, -7.2 * s, 3.0 * s).fill('#d8b48e');
      b.circle(4.8 * s, -7.2 * s, 3.0 * s).fill('#d8b48e');
    }
    b.roundRect(-6.0 * s, -0.6 * s, 12.0 * s, 8.8 * s, 3.2 * s)
      .fill(coatColor)
      .stroke({ width: 1.2 * s, color: '#141619' });
    b.circle(0, -4.0 * s, 5.2 * s).fill('#f4d5b8').stroke({ width: 1.2 * s, color: '#141619' });
    const bars = sp.bars;
    bars.clear();
    if (!p.isStranger && p.hp < p.maxHp) {
      const hpRatio = Math.max(0, Math.min(1, p.hp / p.maxHp));
      bars.rect(-8 * s, -13.5 * s, 16 * s * hpRatio, 2 * s).fill('#5cb85c');
    }
    return;
  }

  // 1. 脚下柔和接地椭圆阴影
  b.ellipse(0, 8.0 * s, 9.2 * s, 3.8 * s).fill({ color: 0x000000, alpha: 0.42 });

  // 2. RimWorld 经典选中四角折线白框 (Selection Brackets)
  if (selected) {
    const br = 12.6 * s;
    const len = 5.0 * s;
    b.moveTo(-br, -br + len).lineTo(-br, -br).lineTo(-br + len, -br);
    b.moveTo(br - len, -br).lineTo(br, -br).lineTo(br, -br + len);
    b.moveTo(-br, br - len).lineTo(-br, br).lineTo(-br + len, br);
    b.moveTo(br - len, br).lineTo(br, br).lineTo(br, br - len);
    b.stroke({ width: 2.3, color: '#ffffff' });
  }

  // 征召红圈 / 荒野崩溃游民橙圈 / 访客黄圈提示
  if (p.drafted) {
    b.ellipse(0, 7.6 * s, 10.6 * s, 4.8 * s).stroke({ width: 1.6, color: '#ff5252', alpha: 0.9 });
  } else if (isWildMan) {
    b.ellipse(0, 7.6 * s, 10.4 * s, 4.6 * s).stroke({ width: 1.7, color: '#ff9f43', alpha: 0.92 });
  } else if (p.isStranger) {
    b.ellipse(0, 7.6 * s, 10.2 * s, 4.5 * s).stroke({ width: 1.5, color: '#f5d451', alpha: 0.85 });
  }

  // 3. 鼠族尾巴
  if (isRatkin) {
    b.moveTo(-4.0 * s, 5.2 * s)
      .lineTo(-9.2 * s, 7.5 * s)
      .lineTo(-11.8 * s, 6.2 * s)
      .stroke({ width: 3.2 * s, color: '#181a1d' });
    b.moveTo(-4.0 * s, 5.2 * s)
      .lineTo(-9.2 * s, 7.5 * s)
      .lineTo(-11.8 * s, 6.2 * s)
      .stroke({ width: 1.8 * s, color: '#dfa693' });
  }

  // 4. RimWorld 标志性无四肢「上窄下宽圆角梯形躯干」
  tracePoly(b, [
    [-5.0 * s, -0.8 * s],
    [5.0 * s, -0.8 * s],
    [7.2 * s, 7.2 * s],
    [5.6 * s, 8.6 * s],
    [-5.6 * s, 8.6 * s],
    [-7.2 * s, 7.2 * s],
  ])
    .fill(coatColor)
    .stroke({ width: 2.0 * s, color: '#141619' });

  b.rect(-6.0 * s, 6.2 * s, 12.0 * s, 2.0 * s).fill({ color: 0x000000, alpha: 0.25 });
  b.roundRect(-4.6 * s, -0.1 * s, 9.2 * s, 2.8 * s, 1.2 * s).fill({ color: 0xffffff, alpha: 0.16 });
  tracePoly(b, [
    [-2.4 * s, -0.6 * s],
    [2.4 * s, -0.6 * s],
    [0, 2.8 * s],
  ]).fill('#26292e');
  b.moveTo(0, 2.8 * s).lineTo(0, 8.2 * s).stroke({ width: 1.2 * s, color: '#141619', alpha: 0.55 });

  if (p.xenotype === 'ratkin_vanguard' || p.drafted) {
    b.roundRect(-4.4 * s, 1.0 * s, 8.8 * s, 5.4 * s, 1.5 * s)
      .fill('#3b4248')
      .stroke({ width: 1.2 * s, color: '#141619' });
    b.rect(-3.2 * s, 2.2 * s, 6.4 * s, 1.4 * s).fill('#566069');
  }

  // 5. 鼠族大圆耳
  if (isRatkin) {
    b.circle(-5.8 * s, -8.2 * s, 3.8 * s).fill('#d8b48e').stroke({ width: 1.8 * s, color: '#141619' });
    b.circle(-5.8 * s, -8.2 * s, 2.0 * s).fill('#e5989b');
    b.circle(5.8 * s, -8.2 * s, 3.8 * s).fill('#d8b48e').stroke({ width: 1.8 * s, color: '#141619' });
    b.circle(5.8 * s, -8.2 * s, 2.0 * s).fill('#e5989b');
  }

  // 6. 独立头部与五官
  b.circle(0, -4.4 * s, 5.7 * s).fill('#f5d7bc').stroke({ width: 1.9 * s, color: '#141619' });

  tracePoly(b, [
    [-5.4 * s, -5.2 * s],
    [-4.6 * s, -8.8 * s],
    [0, -10.0 * s],
    [4.6 * s, -8.8 * s],
    [5.4 * s, -5.2 * s],
    [2.8 * s, -6.4 * s],
    [0, -5.2 * s],
    [-2.8 * s, -6.4 * s],
  ])
    .fill(hairCol)
    .stroke({ width: 1.3 * s, color: '#141619' });

  if (p.drafted || p.xenotype === 'ratkin_vanguard') {
    tracePoly(b, [
      [-5.8 * s, -5.8 * s],
      [-4.8 * s, -9.8 * s],
      [4.8 * s, -9.8 * s],
      [5.8 * s, -5.8 * s],
    ])
      .fill(p.xenotype === 'ratkin_vanguard' ? '#355c8a' : '#495448')
      .stroke({ width: 1.5 * s, color: '#141619' });
    b.rect(-3.6 * s, -7.8 * s, 7.2 * s, 1.6 * s).fill('#90e0ef');
  } else if (isRatkin && !isWildMan) {
    b.roundRect(-4.2 * s, -9.6 * s, 8.4 * s, 1.8 * s, 0.8 * s)
      .fill('#f8f9fa')
      .stroke({ width: 1.0 * s, color: '#141619' });
  }

  if (isSleeping) {
    b.moveTo(-3.2 * s, -3.8 * s).lineTo(-1.2 * s, -3.8 * s).stroke({ width: 1.4 * s, color: '#141619' });
    b.moveTo(1.2 * s, -3.8 * s).lineTo(3.2 * s, -3.8 * s).stroke({ width: 1.4 * s, color: '#141619' });
  } else {
    b.circle(-2.2 * s, -3.8 * s, 1.15 * s).fill('#141619');
    b.circle(2.2 * s, -3.8 * s, 1.15 * s).fill('#141619');
    b.circle(-3.4 * s, -2.4 * s, 1.1 * s).fill({ color: 0xe5989b, alpha: 0.58 });
    b.circle(3.4 * s, -2.4 * s, 1.1 * s).fill({ color: 0xe5989b, alpha: 0.58 });
  }

  if (p.drafted || p.cardId === 'fight' || p.cardId === 'hunt') {
    b.rect(0.5 * s, 1.2 * s, 3.8 * s, 2.4 * s)
      .fill('#6b4423')
      .stroke({ width: 1.2 * s, color: '#141619' });
    b.roundRect(3.5 * s, 0.6 * s, 6.8 * s, 2.8 * s, 0.8 * s)
      .fill('#2b3036')
      .stroke({ width: 1.3 * s, color: '#141619' });
    b.rect(9.8 * s, 1.1 * s, 5.2 * s, 1.5 * s)
      .fill('#495057')
      .stroke({ width: 1.1 * s, color: '#141619' });
    b.rect(4.8 * s, 1.3 * s, 3.6 * s, 1.0 * s).fill('#64dfdf');
    b.circle(3.2 * s, 2.8 * s, 1.6 * s).fill('#f5d7bc').stroke({ width: 1.1 * s, color: '#141619' });
    b.circle(8.2 * s, 2.6 * s, 1.6 * s).fill('#f5d7bc').stroke({ width: 1.1 * s, color: '#141619' });
  } else if (p.activeWork) {
    const wk = p.activeWork.kind;
    b.circle(5.8 * s, 2.4 * s, 1.8 * s).fill('#f5d7bc').stroke({ width: 1.1 * s, color: '#141619' });
    if (wk === 'mine' || wk === 'chop') {
      b.moveTo(4.5 * s, 4.2 * s).lineTo(9.8 * s, -1.2 * s).stroke({ width: 2.0 * s, color: '#7f5539' });
      tracePoly(b, [
        [7.5 * s, -2.5 * s],
        [11.5 * s, -1.8 * s],
        [10.2 * s, 1.5 * s],
      ])
        .fill('#adb5bd')
        .stroke({ width: 1.2 * s, color: '#141619' });
    } else if (wk === 'haul_blueprint' || wk === 'haul_corpse') {
      b.roundRect(2.8 * s, 0.5 * s, 6.2 * s, 5.0 * s, 1.2 * s)
        .fill('#b08252')
        .stroke({ width: 1.3 * s, color: '#141619' });
      b.moveTo(2.8 * s, 3.0 * s).lineTo(9.0 * s, 3.0 * s).stroke({ width: 1.1 * s, color: '#3b2818' });
    } else {
      b.roundRect(5.2 * s, 0.8 * s, 4.5 * s, 2.4 * s, 1 * s)
        .fill('#e6be44')
        .stroke({ width: 1.2 * s, color: '#141619' });
      b.circle(10.0 * s, 1.8 * s, 2.0 * s).fill('#64dfdf');
    }
  } else if (isSleeping) {
    b.circle(7.5 * s, -9.5 * s, 1.5 * s).fill({ color: 0xffffff, alpha: 0.75 });
    b.circle(9.8 * s, -12.2 * s, 2.1 * s).fill({ color: 0x90e0ef, alpha: 0.85 });
  } else if (p.cardId === 'chat') {
    b.roundRect(5.5 * s, -12.5 * s, 7.2 * s, 5.2 * s, 2 * s)
      .fill('#ffffff')
      .stroke({ width: 1.2 * s, color: '#141619' });
    b.circle(7.8 * s, -9.9 * s, 0.8 * s).fill('#141619');
    b.circle(10.2 * s, -9.9 * s, 0.8 * s).fill('#141619');
  }

  const bars = sp.bars;
  bars.clear();

  const barW = 20 * s;
  const barY = -15.2 * s;

  if (p.activeWork) {
    const wProg = Math.max(0, Math.min(1, p.activeWork.workProgress / Math.max(1, p.activeWork.workTotal)));
    const workY = barY - 5.5 * s;
    bars.rect(-barW / 2, workY, barW, 4 * s).fill({ color: 0x121518, alpha: 0.92 });
    bars.rect(-barW / 2 + 0.5, workY + 0.5, (barW - 1) * wProg, 3 * s).fill('#f5d451');
  }

  if (p.attackWindup !== undefined) {
    const aProg = Math.max(0, Math.min(1, p.attackWindup / Math.max(0.1, p.attackWindupTotal ?? 0.8)));
    const castY = barY - 10.5 * s;
    bars.rect(-barW / 2, castY, barW, 4 * s).fill({ color: 0x241414, alpha: 0.92 });
    bars.rect(-barW / 2 + 0.5, castY + 0.5, (barW - 1) * aProg, 3 * s).fill('#ff7675');
  }

  if (p.inMeleeGrapple) {
    bars.circle(0, barY - 15.5 * s, 3.2 * s).fill('#ff5252').stroke({ width: 1.2, color: '#ffffff' });
  }

  if (p.isStranger) return;
  const hpRatio = Math.max(0, Math.min(1, p.hp / p.maxHp));
  const moodRatio = Math.max(0, Math.min(1, p.needs.mood / 100));
  bars.rect(-barW / 2, barY, barW, 4.4 * s).fill({ color: 0x121518, alpha: 0.9 });
  bars.rect(-barW / 2 + 0.5, barY + 0.5, (barW - 1) * hpRatio, 1.9 * s).fill(hpRatio > 0.5 ? '#5cb85c' : '#e05252');
  bars.rect(-barW / 2 + 0.5, barY + 2.6 * s, (barW - 1) * moodRatio, 1.3 * s).fill('#4ea8de');
}

/**
 * 绘制敌袭者、机械族与按 RimWorld 真实物种体型比例缩放的野生动物
 */
export function redrawHostileGraphic(g: Graphics, h: Hostile, T: number): void {
  g.clear();
  const s = T / 26;

  if (h.kind === 'siege_rat_mech') {
    g.ellipse(0, 7.2 * s, 11.5 * s, 4.6 * s).fill({ color: 0x000000, alpha: 0.42 });
    g.roundRect(-10.5 * s, -2.5 * s, 6.5 * s, 7.5 * s, 2.5 * s)
      .fill('#9a968c')
      .stroke({ width: 1.8 * s, color: '#141619' });
    tracePoly(g, [
      [-6.5 * s, -5.8 * s],
      [4.5 * s, -6.5 * s],
      [8.2 * s, -3.2 * s],
      [8.2 * s, 4.8 * s],
      [4.5 * s, 7.5 * s],
      [-6.5 * s, 6.2 * s],
    ])
      .fill('#d4cfc4')
      .stroke({ width: 2.0 * s, color: '#141619' });
    g.rect(-4.2 * s, -3.8 * s, 6.2 * s, 8.2 * s).fill('#495057');
    g.circle(-1.0 * s, 0.4 * s, 2.6 * s).fill('#00b4d8').stroke({ width: 1.2 * s, color: '#caf0f8' });
    g.circle(6.8 * s, 0.5 * s, 3.8 * s).fill('#b8b2a6').stroke({ width: 1.8 * s, color: '#141619' });
    g.rect(7.6 * s, -1.8 * s, 2.2 * s, 4.6 * s).fill('#ff2a2a');
    g.rect(1.5 * s, 4.5 * s, 11.5 * s, 3.2 * s)
      .fill('#2b3036')
      .stroke({ width: 1.4 * s, color: '#141619' });
    g.rect(9.5 * s, 5.2 * s, 3.2 * s, 1.6 * s).fill('#64dfdf');
  } else if (h.kind.startsWith('raider')) {
    const isBoss = h.kind === 'raider_boss';
    const isShield = h.kind === 'raider_shield';
    const armorCol = isBoss ? '#c99e32' : isShield ? '#4a5560' : '#9e2a2b';
    const shoulderCol = isBoss ? '#f5d451' : isShield ? '#707d8c' : '#5e1919';

    g.ellipse(0, 7.6 * s, 9.2 * s, 3.8 * s).fill({ color: 0x000000, alpha: 0.4 });
    g.circle(-5.4 * s, -7.8 * s, 3.4 * s).fill('#7a5c4c').stroke({ width: 1.6 * s, color: '#141619' });
    g.circle(5.4 * s, -7.8 * s, 3.4 * s).fill('#7a5c4c').stroke({ width: 1.6 * s, color: '#141619' });

    tracePoly(g, [
      [-5.2 * s, -0.8 * s],
      [5.2 * s, -0.8 * s],
      [7.4 * s, 7.2 * s],
      [5.6 * s, 8.6 * s],
      [-5.6 * s, 8.6 * s],
      [-7.4 * s, 7.2 * s],
    ])
      .fill(armorCol)
      .stroke({ width: 2.0 * s, color: '#141619' });

    g.roundRect(-6.8 * s, -0.6 * s, 4.2 * s, 3.6 * s, 1.2 * s)
      .fill(shoulderCol)
      .stroke({ width: 1.3 * s, color: '#141619' });
    g.roundRect(2.6 * s, -0.6 * s, 4.2 * s, 3.6 * s, 1.2 * s)
      .fill(shoulderCol)
      .stroke({ width: 1.3 * s, color: '#141619' });
    g.moveTo(-4.5 * s, 0.2 * s).lineTo(4.5 * s, 7.2 * s).stroke({ width: 1.8 * s, color: '#212529' });

    g.circle(0, -4.0 * s, 5.4 * s).fill('#c99e82').stroke({ width: 1.8 * s, color: '#141619' });
    g.roundRect(-4.6 * s, -5.2 * s, 9.2 * s, 3.2 * s, 1 * s)
      .fill('#1f2428')
      .stroke({ width: 1.1 * s, color: '#141619' });
    g.circle(-2.1 * s, -3.6 * s, 1.25 * s).fill('#ff2a2a');
    g.circle(2.1 * s, -3.6 * s, 1.25 * s).fill('#ff2a2a');

    if (isShield) {
      g.circle(0, 1.0 * s, 11.8 * s)
        .fill({ color: 0x64dfdf, alpha: 0.14 })
        .stroke({ width: 1.8 * s, color: '#64dfdf', alpha: 0.88 });
      g.rect(4.2 * s, -2.5 * s, 3.2 * s, 9.0 * s)
        .fill('#adb5bd')
        .stroke({ width: 1.3 * s, color: '#141619' });
    } else {
      g.rect(2.8 * s, 0.4 * s, (isBoss ? 12.2 : 10.2) * s, (isBoss ? 3.4 : 2.6) * s)
        .fill('#1f2327')
        .stroke({ width: 1.3 * s, color: '#000000' });
      g.rect(9.5 * s, 0.9 * s, 3.8 * s, 1.4 * s).fill(isBoss ? '#f5d451' : '#ff6b6b');
    }
  } else if (h.kind === 'deer') {
    // ---- RimWorld 牡鹿 (Buck / Deer · 中等优雅食草兽比例 0.86x) ----
    const sd = s * 0.86;
    g.ellipse(0, 5.6 * sd, 9.6 * sd, 3.2 * sd).fill({ color: 0x000000, alpha: 0.34 });
    g.circle(-9.4 * sd, -0.8 * sd, 2.0 * sd).fill('#f8f9fa').stroke({ width: 1.1 * sd, color: '#2b1e16' });
    tracePoly(g, [
      [-8.8 * sd, -1.6 * sd],
      [-5.2 * sd, -4.2 * sd],
      [4.0 * sd, -3.8 * sd],
      [6.4 * sd, 0.5 * sd],
      [4.2 * sd, 4.4 * sd],
      [-6.8 * sd, 4.4 * sd],
    ])
      .fill('#9c6638')
      .stroke({ width: 1.7 * sd, color: '#24170e' });
    g.ellipse(-1.2 * sd, -1.8 * sd, 5.2 * sd, 1.8 * sd).fill('#b57c4a');
    tracePoly(g, [
      [3.0 * sd, -2.2 * sd],
      [6.4 * sd, -6.8 * sd],
      [10.2 * sd, -5.8 * sd],
      [10.6 * sd, -3.2 * sd],
      [6.0 * sd, 0.2 * sd],
    ])
      .fill('#9c6638')
      .stroke({ width: 1.5 * sd, color: '#24170e' });
    g.moveTo(6.8 * sd, -6.4 * sd)
      .lineTo(4.8 * sd, -11.0 * sd)
      .moveTo(5.6 * sd, -8.8 * sd)
      .lineTo(3.2 * sd, -9.6 * sd)
      .moveTo(8.0 * sd, -6.4 * sd)
      .lineTo(9.2 * sd, -10.8 * sd)
      .stroke({ width: 1.5 * sd, color: '#e6ccb2' });
    g.circle(8.2 * sd, -4.8 * sd, 1.05 * sd).fill('#141619');
  } else if (h.kind === 'rabbit') {
    // ---- RimWorld 野兔 (Hare / Snowhare · 娇小啮齿小动物比例 0.55x，明显小于殖民者) ----
    const sr = s * 0.55;
    g.ellipse(0, 4.4 * sr, 6.4 * sr, 2.5 * sr).fill({ color: 0x000000, alpha: 0.3 });
    g.circle(-5.8 * sr, 0.8 * sr, 2.1 * sr).fill('#ffffff').stroke({ width: 1.2 * sr, color: '#2b2520' });
    g.ellipse(-0.6 * sr, 0.4 * sr, 5.8 * sr, 4.1 * sr)
      .fill('#d8cfc4')
      .stroke({ width: 1.8 * sr, color: '#2b2520' });
    const hx = 4.4 * sr;
    g.circle(hx, -1.4 * sr, 3.2 * sr).fill('#e3dbd2').stroke({ width: 1.6 * sr, color: '#2b2520' });
    g.ellipse(hx - 1.3 * sr, -6.4 * sr, 1.35 * sr, 3.6 * sr).fill('#d8cfc4').stroke({ width: 1.3 * sr, color: '#2b2520' });
    g.ellipse(hx + 1.1 * sr, -6.1 * sr, 1.35 * sr, 3.4 * sr).fill('#d8cfc4').stroke({ width: 1.3 * sr, color: '#2b2520' });
    g.ellipse(hx + 1.1 * sr, -6.1 * sr, 0.65 * sr, 2.0 * sr).fill('#e5989b');
    g.circle(hx + 1.2 * sr, -1.8 * sr, 1.05 * sr).fill('#1f1f1f');
  } else {
    // ---- 狂暴山猫 / 掠食兽 (Lynx / Feral Cat · 紧凑敏捷中小型比例 0.72x) ----
    const sc = s * 0.72;
    g.ellipse(0, 5.2 * sc, 8.2 * sc, 2.9 * sc).fill({ color: 0x000000, alpha: 0.33 });
    g.moveTo(-6.8 * sc, 0.5 * sc)
      .lineTo(-10.8 * sc, -2.5 * sc)
      .lineTo(-11.8 * sc, -4.8 * sc)
      .stroke({ width: 2.0 * sc, color: '#3b2832' });
    g.ellipse(-0.8 * sc, 0.4 * sc, 7.6 * sc, 4.4 * sc)
      .fill('#8f6878')
      .stroke({ width: 1.6 * sc, color: '#24161c' });
    const headX = 5.8 * sc;
    g.circle(headX, -1.6 * sc, 3.6 * sc).fill('#9e7485').stroke({ width: 1.5 * sc, color: '#24161c' });
    tracePoly(g, [
      [headX - 2.4 * sc, -3.9 * sc],
      [headX - 1.0 * sc, -7.2 * sc],
      [headX + 0.4 * sc, -4.3 * sc],
    ])
      .fill('#755160')
      .stroke({ width: 1.2 * sc, color: '#24161c' });
    tracePoly(g, [
      [headX + 0.4 * sc, -3.9 * sc],
      [headX + 2.0 * sc, -7.0 * sc],
      [headX + 3.0 * sc, -3.7 * sc],
    ])
      .fill('#755160')
      .stroke({ width: 1.2 * sc, color: '#24161c' });
    g.circle(headX + 1.4 * sc, -2.0 * sc, 1.15 * sc).fill('#ff3b3b');
  }

  // 血条与战斗蓄力条（按物种高度自适应偏移）
  const barScale = h.kind === 'rabbit' ? 0.68 : h.kind === 'cat' ? 0.8 : h.kind === 'deer' ? 0.9 : 1.0;
  const barW = 18 * s * barScale;
  const barY = (h.kind === 'rabbit' ? -9.5 : h.kind === 'cat' ? -11.5 : -14.2) * s;
  const hpRatio = Math.max(0, Math.min(1, h.hp / Math.max(1, h.maxHp)));
  g.rect(-barW / 2, barY, barW, 2.8 * s).fill('#121518');
  g.rect(-barW / 2 + 0.5, barY + 0.4, (barW - 1) * hpRatio, 2.0 * s).fill('#e05252');

  if (h.attackWindup !== undefined) {
    const aProg = Math.max(0, Math.min(1, h.attackWindup / Math.max(0.1, h.attackWindupTotal ?? 1.0)));
    g.rect(-barW / 2, barY - 4.2 * s, barW, 3.2 * s).fill('#241414');
    g.rect(-barW / 2 + 0.5, barY - 3.8 * s, (barW - 1) * aProg, 2.3 * s).fill('#ff7675');
  }
  if (h.inMeleeGrapple) {
    g.circle(0, barY - 8.2 * s, 3.0 * s).fill('#ff5252').stroke({ width: 1, color: '#ffffff' });
  }
}
