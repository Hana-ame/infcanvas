// SVG 素材定义 —— 内联 SVG 字符串，Pixi 以 GraphicsContext 解析（任意缩放清晰）
// 每个素材是一个函数返回 svg 字符串，尺寸统一 32x32

const W = 32;
const H = 32;

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// 地形
export const TERRAIN_SVG: Record<string, string> = {
  tree: svg(`
    <ellipse cx="16" cy="14" rx="9" ry="11" fill="#2f7a35"/>
    <ellipse cx="16" cy="14" rx="6" ry="8" fill="#3f9a45"/>
    <rect x="14" y="24" width="4" height="6" fill="#7a5230"/>
    <ellipse cx="12" cy="12" rx="3" ry="3" fill="#57b35c" opacity="0.7"/>
  `),
  ore: svg(`
    <rect x="4" y="4" width="24" height="24" rx="3" fill="#7d7468"/>
    <circle cx="11" cy="12" r="3" fill="#d4b94a"/>
    <circle cx="21" cy="20" r="3" fill="#c9ad3f"/>
    <circle cx="19" cy="10" r="2" fill="#e0c95a"/>
    <circle cx="11" cy="21" r="2" fill="#b89a33"/>
  `),
  water: svg(`
    <path d="M2 16 Q8 10 14 16 T26 16 T38 16" stroke="#7fb3e8" stroke-width="3" fill="none" opacity="0.8"/>
    <path d="M2 23 Q10 18 18 23 T32 23" stroke="#5f9ad0" stroke-width="2.5" fill="none" opacity="0.6"/>
  `),
  stone: svg(`
    <ellipse cx="16" cy="18" rx="10" ry="8" fill="#9a9a9a"/>
    <ellipse cx="14" cy="16" rx="6" ry="4.5" fill="#b0b0b0"/>
    <ellipse cx="20" cy="21" rx="4" ry="3" fill="#888"/>
  `),
};

// 建筑
export const BUILDING_SVG: Record<string, string> = {
  campfire: svg(`
    <rect x="7" y="26" width="18" height="4" rx="2" fill="#5a3a20"/>
    <rect x="9" y="24" width="3" height="4" fill="#8b5a2b"/>
    <rect x="20" y="24" width="3" height="4" fill="#8b5a2b"/>
    <path d="M16 24 L11 13 Q16 6 21 13 Z" fill="#e25822"/>
    <path d="M16 20 L13 13 Q16 8 19 13 Z" fill="#ff8c42"/>
  `),
  wall: svg(`
    <rect x="2" y="2" width="28" height="28" rx="2" fill="#8f8f8f"/>
    <rect x="4" y="4" width="24" height="24" rx="1" fill="#a8a8a8"/>
    <path d="M4 4 L28 28 M28 4 L4 28" stroke="#7a7a7a" stroke-width="2"/>
  `),
  floor: svg(`
    <rect x="2" y="2" width="28" height="28" rx="2" fill="#b8a884"/>
    <path d="M2 11 L30 11 M2 22 L30 22" stroke="#a08d6e" stroke-width="1.5"/>
    <path d="M11 2 L11 30 M22 2 L22 30" stroke="#a08d6e" stroke-width="1.5"/>
  `),
  door: svg(`
    <rect x="4" y="2" width="24" height="28" rx="2" fill="#8b6914"/>
    <rect x="7" y="4" width="18" height="24" rx="1" fill="#a8802a"/>
    <circle cx="21" cy="16" r="1.5" fill="#3a2a0a"/>
    <rect x="7" y="4" width="4" height="24" fill="#7a5a10" opacity="0.5"/>
  `),
  farm: svg(`
    <rect x="2" y="2" width="28" height="28" rx="2" fill="#5a7a2a"/>
    <rect x="5" y="5" width="22" height="22" fill="#4a6a22"/>
    <path d="M16 6 L13 12 H19 Z" fill="#9bc94a"/>
    <path d="M16 12 L13 18 H19 Z" fill="#8ab842"/>
    <path d="M16 18 L13 24 H19 Z" fill="#7ba83a"/>
  `),
  workbench: svg(`
    <rect x="3" y="16" width="26" height="12" rx="2" fill="#5a3a1a"/>
    <rect x="5" y="18" width="22" height="8" fill="#7a5230"/>
    <rect x="7" y="6" width="4" height="10" fill="#8b5a2b"/>
    <rect x="21" y="6" width="4" height="10" fill="#8b5a2b"/>
    <circle cx="16" cy="20" r="2" fill="#c0c0c0"/>
    <rect x="9" y="24" width="6" height="3" fill="#6a4a20"/>
  `),
  cave: svg(`
    <path d="M4 28 Q4 6 16 6 Q28 6 28 28 Z" fill="#4a3a2a"/>
    <path d="M8 28 Q8 12 16 12 Q24 12 24 28 Z" fill="#1a1208"/>
    <ellipse cx="16" cy="26" rx="9" ry="3" fill="#0a0603"/>
    <circle cx="13" cy="18" r="1.5" fill="#d4b94a"/>
    <circle cx="19" cy="22" r="1.3" fill="#c9ad3f"/>
    <path d="M16 12 Q18 6 16 2 Q14 6 16 12 Z" fill="#d4b94a" opacity="0.3"/>
  `),
  church: svg(`
    <rect x="8" y="12" width="16" height="16" fill="#8a6a9a"/>
    <path d="M16 2 L28 12 H4 Z" fill="#a07ac0"/>
    <path d="M16 2 L22 8 H10 Z" fill="#c0a0d8"/>
    <rect x="13" y="18" width="6" height="10" fill="#3a2a4a"/>
    <circle cx="16" cy="20" r="1.2" fill="#ffe08a" opacity="0.9"/>
    <rect x="6" y="12" width="3" height="16" fill="#7a5a8a"/>
    <rect x="23" y="12" width="3" height="16" fill="#7a5a8a"/>
  `),
  monument: svg(`
    <rect x="10" y="10" width="12" height="18" fill="#8a7a5a"/>
    <rect x="8" y="6" width="16" height="5" rx="1" fill="#a0906a"/>
    <rect x="13" y="2" width="6" height="5" fill="#b0a080"/>
    <circle cx="16" cy="4" r="1" fill="#ffe08a"/>
    <rect x="6" y="14" width="4" height="14" fill="#7a6a4a"/>
    <rect x="22" y="14" width="4" height="14" fill="#7a6a4a"/>
    <path d="M10 28 H22" stroke="#6a5a3a" stroke-width="3"/>
  `),
  fence: svg(`
    <rect x="4" y="4" width="4" height="24" fill="#8a6a3a" rx="1"/>
    <rect x="14" y="4" width="4" height="24" fill="#8a6a3a" rx="1"/>
    <rect x="24" y="4" width="4" height="24" fill="#8a6a3a" rx="1"/>
    <rect x="2" y="8" width="28" height="4" fill="#a0804a" rx="1"/>
    <rect x="2" y="18" width="28" height="4" fill="#a0804a" rx="1"/>
  `),
  rampart: svg(`
    <rect x="2" y="10" width="28" height="14" fill="#7a7268" stroke="#5a544c" stroke-width="1.5"/>
    <rect x="2" y="6" width="6" height="6" fill="#8a8278"/>
    <rect x="13" y="6" width="6" height="6" fill="#8a8278"/>
    <rect x="24" y="6" width="6" height="6" fill="#8a8278"/>
    <rect x="2" y="24" width="28" height="4" fill="#6a645c"/>
    <path d="M6 10 L8 4 L12 10" fill="#6a645c"/>
  `),
  raft: svg(`
    <path d="M2 22 L10 10 L26 14 L30 24 Z" fill="#a07030" stroke="#7a5220" stroke-width="1.5"/>
    <path d="M2 22 L30 24" stroke="#8a5a2a" stroke-width="2"/>
    <rect x="7" y="8" width="3" height="18" rx="1" fill="#c09040"/>
    <path d="M12 14 L14 8" stroke="#c09040" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 14 Q16 12 20 15 L24 13" stroke="#d8b060" stroke-width="1.5" fill="none"/>
  `),
  boat: svg(`
    <path d="M2 24 Q16 14 30 24 Z" fill="#7a5230" stroke="#5a3a1a" stroke-width="2"/>
    <rect x="7" y="19" width="18" height="6" rx="2" fill="#a8804a"/>
    <path d="M16 19 L22 4 L10 5 Z" fill="#e8d8b8" stroke="#a0805a" stroke-width="1.5"/>
    <path d="M16 19 L22 4 L10 5 Z" fill="none" stroke="#a0805a" stroke-width="1"/>
    <rect x="16" y="5" width="2" height="14" fill="#8a5a2a"/>
  `),
  bridge: svg(`
    <rect x="2" y="14" width="28" height="6" rx="1" fill="#8a6432"/>
    <rect x="2" y="14" width="28" height="2" fill="#a88048"/>
    <path d="M5 20 L5 28 M11 20 L11 28 M21 20 L21 28 M27 20 L27 28" stroke="#6a4a22" stroke-width="2.5"/>
    <path d="M2 12 H30 M2 18 H30" stroke="#b89858" stroke-width="1.5"/>
  `),
};

// 小人（正面鼠）—— 按性格变体
export const PAWN_SVG: Record<string, string> = {
  mouse: svg(`
    <ellipse cx="16" cy="18" rx="10" ry="9" fill="#d8c8b0"/>
    <ellipse cx="11" cy="10" rx="4" ry="5" fill="#c8b898"/>
    <ellipse cx="21" cy="10" rx="4" ry="5" fill="#c8b898"/>
    <circle cx="11" cy="9" r="2.5" fill="#ffb0b0"/>
    <circle cx="21" cy="9" r="2.5" fill="#ffb0b0"/>
    <circle cx="13" cy="17" r="1.6" fill="#3a2a1a"/>
    <circle cx="19" cy="17" r="1.6" fill="#3a2a1a"/>
    <ellipse cx="16" cy="20" rx="2.5" ry="1.8" fill="#8a7a6a"/>
    <path d="M6 10 Q2 14 6 18" stroke="#c8b898" stroke-width="2.5" fill="none"/>
    <path d="M26 10 Q30 14 26 18" stroke="#c8b898" stroke-width="2.5" fill="none"/>
  `),
  strong: svg(`
    <ellipse cx="16" cy="18" rx="11" ry="10" fill="#b8a890"/>
    <ellipse cx="11" cy="10" rx="4" ry="5" fill="#a89880"/>
    <ellipse cx="21" cy="10" rx="4" ry="5" fill="#a89880"/>
    <circle cx="11" cy="9" r="2.5" fill="#e88"/>
    <circle cx="21" cy="9" r="2.5" fill="#e88"/>
    <circle cx="13" cy="17" r="1.8" fill="#2a1a0a"/>
    <circle cx="19" cy="17" r="1.8" fill="#2a1a0a"/>
    <rect x="13" y="20" width="6" height="3" rx="1" fill="#6a5a4a"/>
    <path d="M6 10 Q2 14 6 18" stroke="#a89880" stroke-width="3" fill="none"/>
    <path d="M26 10 Q30 14 26 18" stroke="#a89880" stroke-width="3" fill="none"/>
  `),
  devout: svg(`
    <ellipse cx="16" cy="18" rx="10" ry="9" fill="#e8e0d0"/>
    <ellipse cx="11" cy="10" rx="4" ry="5" fill="#d8d0c0"/>
    <ellipse cx="21" cy="10" rx="4" ry="5" fill="#d8d0c0"/>
    <circle cx="11" cy="9" r="2.5" fill="#ffc0c0"/>
    <circle cx="21" cy="9" r="2.5" fill="#ffc0c0"/>
    <circle cx="13" cy="17" r="1.6" fill="#4a3a2a"/>
    <circle cx="19" cy="17" r="1.6" fill="#4a3a2a"/>
    <ellipse cx="16" cy="20" rx="2.5" ry="1.8" fill="#9a8a7a"/>
    <path d="M8 8 L12 2 L20 4 L24 10" stroke="#c8b060" stroke-width="2" fill="none" opacity="0.8"/>
  `),
  lazy: svg(`
    <ellipse cx="16" cy="19" rx="11" ry="10" fill="#c8c0b0"/>
    <ellipse cx="11" cy="10" rx="4" ry="5" fill="#b8b0a0"/>
    <ellipse cx="21" cy="10" rx="4" ry="5" fill="#b8b0a0"/>
    <circle cx="11" cy="9" r="2.5" fill="#e8b0b0"/>
    <circle cx="21" cy="9" r="2.5" fill="#e8b0b0"/>
    <circle cx="13" cy="17" r="1.6" fill="#3a2a1a"/>
    <circle cx="19" cy="17" r="1.6" fill="#3a2a1a"/>
    <rect x="13" y="21" width="6" height="2" rx="1" fill="#7a6a5a"/>
    <path d="M6 10 Q2 14 6 18" stroke="#b8b0a0" stroke-width="2.5" fill="none"/>
    <path d="M26 10 Q30 14 26 18" stroke="#b8b0a0" stroke-width="2.5" fill="none"/>
  `),
  workaholic: svg(`
    <ellipse cx="16" cy="18" rx="10" ry="9" fill="#d0c8b8"/>
    <ellipse cx="11" cy="10" rx="4" ry="5" fill="#c0b8a8"/>
    <ellipse cx="21" cy="10" rx="4" ry="5" fill="#c0b8a8"/>
    <circle cx="11" cy="9" r="2.5" fill="#f0c0c0"/>
    <circle cx="21" cy="9" r="2.5" fill="#f0c0c0"/>
    <circle cx="13" cy="17" r="1.6" fill="#3a2a1a"/>
    <circle cx="19" cy="17" r="1.6" fill="#3a2a1a"/>
    <ellipse cx="16" cy="20" rx="2.5" ry="1.8" fill="#8a7a6a"/>
    <path d="M6 10 Q2 14 6 18" stroke="#c0b8a8" stroke-width="2.5" fill="none"/>
    <path d="M26 10 Q30 14 26 18" stroke="#c0b8a8" stroke-width="2.5" fill="none"/>
  `),
  owl: svg(`
    <ellipse cx="16" cy="18" rx="10" ry="10" fill="#8a6a4a"/>
    <ellipse cx="11" cy="9" rx="5" ry="6" fill="#7a5a3a"/>
    <ellipse cx="21" cy="9" rx="5" ry="6" fill="#7a5a3a"/>
    <circle cx="11" cy="10" r="3" fill="#e8e0c0"/>
    <circle cx="21" cy="10" r="3" fill="#e8e0c0"/>
    <circle cx="11" cy="10" r="1.5" fill="#3a2a1a"/>
    <circle cx="21" cy="10" r="1.5" fill="#3a2a1a"/>
    <path d="M12 20 L16 24 L20 20" stroke="#c8a050" stroke-width="2" fill="#c8a050"/>
    <ellipse cx="16" cy="18" rx="2" ry="1.5" fill="#5a3a1a"/>
  `),
};

// HUD 图标（DOM 层：资源条 / 面板 / 按钮，与 Pixi 画面同一套风格）
export const HUD_SVG: Record<string, string> = {
  wood: svg(`
    <ellipse cx="16" cy="22" rx="11" ry="4" fill="#6a4a28"/>
    <circle cx="10" cy="14" r="6" fill="#a06828" stroke="#7a4a18" stroke-width="2"/>
    <circle cx="17" cy="11" r="6" fill="#b87830" stroke="#8a5820" stroke-width="2"/>
    <circle cx="23" cy="15" r="5" fill="#a06828" stroke="#7a4a18" stroke-width="2"/>
    <circle cx="16" cy="8" r="4" fill="#c88840"/>
  `),
  ore: svg(`
    <path d="M16 3 L29 11 V21 L16 29 L3 21 V11 Z" fill="#7d7468" stroke="#5a5248" stroke-width="1.5"/>
    <path d="M16 3 L16 29 M3 11 L29 21 M3 21 L29 11" stroke="#5a5248" stroke-width="1"/>
    <circle cx="11" cy="13" r="2.5" fill="#d4b94a"/>
    <circle cx="21" cy="19" r="2.5" fill="#c9ad3f"/>
    <circle cx="20" cy="11" r="2" fill="#e0c95a"/>
  `),
  water: svg(`
    <path d="M16 3 Q22 9 19 13 Q24 12 23 16 Q27 15 26 19 Q22 20 21 22 Q17 23 18 27 Q13 27 14 22 Q10 21 11 19 Q8 18 9 16 Q6 15 10 12 Q7 10 12 9 Q9 6 16 3 Z" fill="#5aa8e8" stroke="#3a88c8" stroke-width="1.5"/>
    <path d="M16 10 Q20 13 18 16 Q21 17 20 19 Q17 20 18 22 Q15 22 15 20 Q12 20 13 18 Q10 17 12 15 Q10 13 13 12 Q12 10 16 10 Z" fill="#b8e4ff" opacity="0.7"/>
  `),
  food: svg(`
    <path d="M8 14 L14 4 Q18 8 14 13 L20 20 L17 23 L11 16 Q7 20 4 16 Z" fill="#e8a23a" stroke="#b06a20" stroke-width="1.5"/>
    <ellipse cx="16" cy="26" rx="9" ry="4" fill="#7a5a2a" opacity="0.6"/>
    <circle cx="10" cy="12" r="2" fill="#ffd966" opacity="0.8"/>
  `),
  tools: svg(`
    <rect x="10" y="14" width="13" height="8" rx="2" fill="#b0a090" transform="rotate(-20 16 18)"/>
    <circle cx="16" cy="18" r="3" fill="#d8d0c0"/>
    <path d="M7 23 L12 18 L15 21 L10 26 Z" fill="#8a7a6a"/>
    <path d="M24 23 L29 18" stroke="#8a7a6a" stroke-width="3" stroke-linecap="round"/>
  `),
  people: svg(`
    <circle cx="12" cy="11" r="5" fill="#d8c8b0"/>
    <circle cx="22" cy="13" r="4" fill="#c8b898"/>
    <path d="M3 27 Q6 19 12 19 Q18 19 21 27 Z" fill="#b8a888"/>
    <path d="M15 27 Q18 21 22 21 Q27 21 30 27 Z" fill="#a89878"/>
  `),
  day: svg(`
    <circle cx="16" cy="16" r="7" fill="#ffd94a"/>
    <path d="M16 2 V6 M16 26 V30 M2 16 H6 M26 16 H30 M6 6 L9 9 M23 23 L26 26 M26 6 L23 9 M9 23 L6 26" stroke="#ffd94a" stroke-width="2.5" stroke-linecap="round"/>
  `),
  night: svg(`
    <path d="M24 4 Q30 12 24 20 Q16 26 8 20 Q2 12 8 4 Q14 9 24 4 Z" fill="#c8c0d8"/>
    <circle cx="20" cy="12" r="2" fill="#e8e0f0" opacity="0.8"/>
    <circle cx="12" cy="18" r="1.4" fill="#e8e0f0" opacity="0.6"/>
  `),
  warn: svg(`
    <path d="M16 3 L30 27 H2 Z" fill="#e8604a"/>
    <rect x="14" y="11" width="4" height="8" rx="1" fill="#fff"/>
    <circle cx="16" cy="23" r="2.2" fill="#fff"/>
  `),
  raid: svg(`
    <path d="M4 4 L16 12 L28 4 L22 14 L28 28 L16 20 L4 28 L10 14 Z" fill="#c8c8d0" stroke="#8a8a94" stroke-width="1.5"/>
    <path d="M16 12 L16 20" stroke="#8a8a94" stroke-width="1.5"/>
  `),
  help: svg(`
    <circle cx="16" cy="16" r="12" fill="#3a5a7a" stroke="#2a4a6a" stroke-width="2"/>
    <text x="16" y="22" text-anchor="middle" font-size="17" font-weight="bold" fill="#e8f0f8" font-family="system-ui">?</text>
  `),
  history: svg(`
    <circle cx="16" cy="16" r="12" fill="#3a6a5a" stroke="#2a5a4a" stroke-width="2"/>
    <path d="M16 8 V16 L21 19" stroke="#e8f0e8" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="16" cy="16" r="2.5" fill="#e8f0e8"/>
  `),
  factions: svg(`
    <path d="M4 8 L14 8 L16 4 L18 8 L28 8 L26 14 L28 20 L18 20 L16 24 L14 20 L4 20 L6 14 Z" fill="#8a5a3a" stroke="#6a4a2a" stroke-width="1.5"/>
    <path d="M16 8 V20 M10 12 L22 16 M10 16 L22 12" stroke="#d8b888" stroke-width="1.5" opacity="0.7"/>
  `),
  keys: svg(`
    <circle cx="11" cy="11" r="6" fill="#d8a03a" stroke="#a87a1a" stroke-width="2"/>
    <circle cx="11" cy="11" r="2.2" fill="#a87a1a"/>
    <path d="M16 14 L28 26 M22 20 L26 16" stroke="#a88a5a" stroke-width="2.5" stroke-linecap="round"/>
  `),
  card: svg(`
    <rect x="5" y="7" width="22" height="18" rx="2" fill="#c8a0d8" stroke="#a07ac0" stroke-width="1.5"/>
    <path d="M16 10 L18 14 L22 14.5 L19 17 L20 21 L16 19 L12 21 L13 17 L10 14.5 L14 14 Z" fill="#e8d0f0" opacity="0.9"/>
    <rect x="8" y="21" width="8" height="1.5" fill="#a07ac0" opacity="0.6"/>
  `),
  cancel: svg(`
    <circle cx="16" cy="16" r="11" fill="#4a4a52" stroke="#3a3a42" stroke-width="2"/>
    <path d="M11 11 L21 21 M21 11 L11 21" stroke="#e8e8f0" stroke-width="3" stroke-linecap="round"/>
  `),
  oracle: svg(`
    <circle cx="16" cy="16" r="11" fill="#5a3a6a" stroke="#a07ac0" stroke-width="2"/>
    <path d="M16 8 L18 13 L23 14 L19 17 L20 22 L16 19 L12 22 L13 17 L9 14 L14 13 Z" fill="#e8d0f0"/>
    <circle cx="16" cy="9" r="1.2" fill="#ffe08a"/>
  `),
};

// data URI（加载给 Pixi / DOM <img> 通用）
export function svgDataUri(s: string): string {
  return 'data:image/svg+xml;base64,' + btoa(s);
}

// 根据天赋选鼠头像变体（renderer 与 HUD 共用）
export function pawnAssetIdFor(traits: readonly string[] | undefined): string {
  const t = traits ?? [];
  if (t.includes('强壮')) return 'pawn:strong';
  if (t.includes('虔诚')) return 'pawn:devout';
  if (t.includes('懒惰')) return 'pawn:lazy';
  if (t.includes('热爱工作')) return 'pawn:workaholic';
  if (t.includes('夜猫子')) return 'pawn:owl';
  return 'pawn:mouse';
}
