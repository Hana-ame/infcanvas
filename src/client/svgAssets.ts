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

// data URI（加载给 Pixi）
export function svgDataUri(s: string): string {
  return 'data:image/svg+xml;base64,' + btoa(s);
}
