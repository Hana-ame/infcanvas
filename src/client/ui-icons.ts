/**
 * client/ui-icons.ts —— RimWorld 1.5 原版描图级（Vector-Traced）SVG 矢量图标库
 *                      （建筑、资源、武器、护甲、作业指令、遗迹设施、状态与主菜单全图标化）。
 */

export function svgIcon(kind: string, size = 16): string {
  const s = `width="${size}" height="${size}" viewBox="0 0 20 20" style="vertical-align:middle;flex:none;display:inline-block"`;
  switch (kind) {
    // ---- 结构与建筑（RimWorld 经典顶面+南立面 2.5D 描图） ----
    case 'wall':
      return `<svg ${s}><rect x="2" y="2.5" width="16" height="15" rx="1.2" fill="#a8875e" stroke="#141619" stroke-width="1.7"/><rect x="2" y="13" width="16" height="4.5" fill="#574128"/><rect x="4" y="4.5" width="12" height="7" fill="#c29e73"/><line x1="2" y1="13" x2="18" y2="13" stroke="#141619" stroke-width="1.3"/><line x1="10" y1="13" x2="10" y2="17.5" stroke="#141619" stroke-width="1.2"/></svg>`;
    case 'door':
      return `<svg ${s}><rect x="2" y="3" width="3.2" height="14" fill="#4f3b25" stroke="#141619" stroke-width="1.4"/><rect x="14.8" y="3" width="3.2" height="14" fill="#4f3b25" stroke="#141619" stroke-width="1.4"/><rect x="5.2" y="5" width="9.6" height="10" fill="#9c7851" stroke="#141619" stroke-width="1.5"/><line x1="10" y1="5" x2="10" y2="15" stroke="#141619" stroke-width="1.6"/><circle cx="8" cy="10" r="1.1" fill="#f5d451"/><circle cx="12" cy="10" r="1.1" fill="#f5d451"/></svg>`;
    case 'slope':
    case 'ladder':
      // 斜坡图标：严格保持 data-icon="transparent-ladder" 与无 polyline 契约
      return `<svg ${s} data-icon="transparent-ladder"><rect x="1.5" y="2.5" width="17" height="15" rx="3" fill="rgba(210,185,140,0.18)"/><rect x="3.5" y="4.5" width="13" height="11" rx="2.5" fill="rgba(210,185,140,0.34)"/><rect x="6" y="6.5" width="8" height="7" rx="2" fill="rgba(245,222,179,0.56)"/></svg>`;
    case 'grave':
      return `<svg ${s}><ellipse cx="10" cy="15" rx="6.8" ry="3.2" fill="#52412f" stroke="#141619" stroke-width="1.4"/><path d="M5.8 14 V6.8 A4.2 4.2 0 0 1 14.2 6.8 V14 Z" fill="#8d959e" stroke="#141619" stroke-width="1.6"/><path d="M10 5.5 V11.2 M7.6 8 H12.4" stroke="#f8f9fa" stroke-width="1.6"/></svg>`;
    case 'butcher_table':
    case 'butcher':
      return `<svg ${s}><rect x="1.5" y="4.5" width="17" height="11" rx="2" fill="#6b442a" stroke="#141619" stroke-width="1.6"/><circle cx="6.2" cy="10" r="3" fill="#c49a6c" stroke="#3b2614" stroke-width="1.2"/><ellipse cx="6.5" cy="10" rx="1.8" ry="1.2" fill="#c92a2a"/><path d="M11 7 H15.8 V11 H11 Z" fill="#dee2e6" stroke="#141619" stroke-width="1.2"/><circle cx="10" cy="17.5" r="1.5" fill="none" stroke="#e9ecef" stroke-width="1.1"/></svg>`;
    case 'citadel_hub':
      return `<svg ${s}><rect x="1.5" y="1.5" width="17" height="17" rx="2.5" fill="#2b3642" stroke="#141619" stroke-width="1.8"/><rect x="3" y="3" width="14" height="14" rx="1.5" fill="none" stroke="#f5d451" stroke-width="1.3"/><circle cx="10" cy="10" r="4.5" fill="#355c8a" stroke="#141619" stroke-width="1.4"/><circle cx="10" cy="10" r="2.2" fill="#f5d451"/></svg>`;
    case 'grand_stockpile_5x5':
      return `<svg ${s}><rect x="1.5" y="1.5" width="17" height="17" rx="2" fill="#3b3240" stroke="#9d8ca3" stroke-width="1.6"/><rect x="3.8" y="3.8" width="5.2" height="5.2" rx="1" fill="#a46d41" stroke="#141619" stroke-width="1"/><rect x="11" y="3.8" width="5.2" height="5.2" rx="1" fill="#adb5bd" stroke="#141619" stroke-width="1"/><rect x="3.8" y="11" width="5.2" height="5.2" rx="1" fill="#f5d451" stroke="#141619" stroke-width="1"/><rect x="11" y="11" width="5.2" height="5.2" rx="1" fill="#2b9348" stroke="#141619" stroke-width="1"/></svg>`;
    case 'great_bonfire':
    case 'campfire':
      return `<svg ${s}><circle cx="10" cy="14.5" r="5.5" fill="#3b2c1e" stroke="#6c757d" stroke-width="1.5"/><line x1="5.5" y1="16" x2="14.5" y2="12" stroke="#6b4423" stroke-width="2.2"/><line x1="5.5" y1="12" x2="14.5" y2="16" stroke="#8d5b34" stroke-width="2.2"/><path d="M10 2 C15 7, 15.8 12, 10 16 C4.2 12, 5 7, 10 2 Z" fill="#e85d04" stroke="#141619" stroke-width="1.2"/><path d="M10 6 C12.5 9.2, 13 12.8, 10 15 C7 12.8, 7.5 9.2, 10 6 Z" fill="#f7b529"/><circle cx="10" cy="12.5" r="1.6" fill="#fff5a8"/></svg>`;
    case 'electric_beacon_tower':
      return `<svg ${s}><rect x="2.5" y="2.5" width="15" height="15" rx="3" fill="#2b343e" stroke="#141619" stroke-width="1.6"/><circle cx="10" cy="10" r="5" fill="#435364" stroke="#64dfdf" stroke-width="1.4"/><circle cx="10" cy="10" r="2.5" fill="#90e0ef"/><circle cx="10" cy="10" r="1.2" fill="#ffffff"/></svg>`;
    case 'wood_generator':
      return `<svg ${s}><rect x="2" y="3" width="16" height="14" rx="2" fill="#383e45" stroke="#141619" stroke-width="1.6"/><circle cx="7.2" cy="10" r="4.2" fill="#b87333" stroke="#141619" stroke-width="1.4"/><circle cx="7.2" cy="10" r="1.6" fill="#495057"/><rect x="12.5" y="10.5" width="4" height="3.5" rx="0.8" fill="#e85d04" stroke="#141619" stroke-width="1"/><polygon points="14.5,3.5 11.5,8.5 14.2,8.5 13,12.5 17,7.5 14.3,7.5" fill="#f5d451"/></svg>`;
    case 'solar_generator':
      return `<svg ${s}><rect x="1.5" y="3" width="17" height="14" rx="2" fill="#8d99ae" stroke="#141619" stroke-width="1.6"/><rect x="3" y="4.5" width="14" height="10" fill="#162b45"/><line x1="3" y1="9.5" x2="17" y2="9.5" stroke="#457b9d" stroke-width="1.1"/><line x1="7.6" y1="4.5" x2="7.6" y2="14.5" stroke="#457b9d" stroke-width="1.1"/><line x1="12.3" y1="4.5" x2="12.3" y2="14.5" stroke="#457b9d" stroke-width="1.1"/></svg>`;
    case 'battery':
      return `<svg ${s}><rect x="4" y="3" width="12" height="15" rx="2" fill="#2b333b" stroke="#141619" stroke-width="1.6"/><rect x="6" y="6" width="3.4" height="9.5" fill="#48cae4"/><rect x="10.6" y="6" width="3.4" height="9.5" fill="#48cae4"/><circle cx="7.5" cy="4.5" r="1" fill="#ff5252"/><circle cx="12.5" cy="4.5" r="1" fill="#f5d451"/></svg>`;
    case 'power_conduit':
    case 'power':
      return `<svg ${s}><polygon points="11.5,1.8 4.2,11 9.8,11 7.8,18.2 16,8.8 10.5,8.8" fill="#f5d451" stroke="#141619" stroke-width="1.4"/></svg>`;
    case 'shelf':
    case 'storage_cabinet':
    case 'store':
      return `<svg ${s}><rect x="2" y="3" width="16" height="14" rx="1.8" fill="#5c4028" stroke="#141619" stroke-width="1.6"/><line x1="2" y1="10" x2="18" y2="10" stroke="#141619" stroke-width="1.5"/><rect x="4" y="5" width="5" height="3.8" rx="0.8" fill="#d4a373" stroke="#141619" stroke-width="0.9"/><rect x="11" y="5" width="5" height="3.8" rx="0.8" fill="#7ca1c4" stroke="#141619" stroke-width="0.9"/><rect x="4.5" y="11.5" width="11" height="3.8" rx="0.8" fill="#e6be44" stroke="#141619" stroke-width="0.9"/></svg>`;
    case 'stove':
    case 'cook':
      return `<svg ${s}><rect x="1.5" y="4.5" width="17" height="11" rx="2" fill="#343a40" stroke="#141619" stroke-width="1.6"/><circle cx="6.2" cy="10" r="3.1" fill="#1b1e21" stroke="#ff6b35" stroke-width="1.4"/><circle cx="6.2" cy="10" r="1.8" fill="#9c6644"/><circle cx="13.8" cy="10" r="2.9" fill="#1b1e21" stroke="#adb5bd" stroke-width="1.4"/><circle cx="13.8" cy="10" r="1.3" fill="#f77f00"/></svg>`;
    case 'nutrient_paste_dispenser':
      return `<svg ${s}><rect x="2" y="3" width="16" height="14" rx="2" fill="#2f3e46" stroke="#141619" stroke-width="1.6"/><circle cx="7.5" cy="10" r="3.8" fill="#40916c" stroke="#141619" stroke-width="1.3"/><circle cx="7.5" cy="10" r="1.8" fill="#7ef09d"/><rect x="12.5" y="6.8" width="3.6" height="6.4" rx="1" fill="#ced4da" stroke="#141619" stroke-width="1.1"/></svg>`;
    case 'research_bench':
    case 'research':
      return `<svg ${s}><rect x="1.5" y="5" width="17" height="10.5" rx="2" fill="#6b4d32" stroke="#141619" stroke-width="1.6"/><rect x="3.5" y="7" width="6.5" height="5.5" fill="#2b6cb0" stroke="#ffffff" stroke-width="1"/><circle cx="14" cy="10.2" r="2.8" fill="#2b3036" stroke="#f5d451" stroke-width="1.4"/><circle cx="13.5" cy="9.6" r="1" fill="#64dfdf"/></svg>`;
    case 'hut':
      return `<svg ${s}><polygon points="10,2 18.5,9 16,9 16,18 4,18 4,9 1.5,9" fill="#8a6542" stroke="#141619" stroke-width="1.6"/><rect x="7.8" y="11.5" width="4.4" height="6.5" fill="#3d2c1d" stroke="#141619" stroke-width="1.1"/></svg>`;
    case 'bed':
    case 'sleep':
      return `<svg ${s}><rect x="3.5" y="2" width="13" height="16" rx="2" fill="#6e5034" stroke="#141619" stroke-width="1.6"/><rect x="5" y="3.5" width="10" height="3.8" rx="1.2" fill="#f8f9fa" stroke="#adb5bd" stroke-width="0.9"/><rect x="4.5" y="8" width="11" height="8.8" rx="1" fill="#2e6f9e" stroke="#141619" stroke-width="1.1"/><path d="M10 10.2 v4.4 M7.8 12.4 h4.4" stroke="#ffffff" stroke-width="1.8"/></svg>`;
    case 'field':
    case 'fertility':
      return `<svg ${s}><rect x="2" y="3" width="16" height="14" rx="1.5" fill="#382818" stroke="#789c54" stroke-width="1.5"/><circle cx="6" cy="7.2" r="2.2" fill="#529438"/><circle cx="14" cy="7.2" r="2.2" fill="#529438"/><circle cx="6" cy="12.8" r="2.2" fill="#7ef09d"/><circle cx="14" cy="12.8" r="2.2" fill="#7ef09d"/></svg>`;
    case 'tower':
      return `<svg ${s}><rect x="2" y="2" width="16" height="16" rx="3.5" fill="#b59e7a" stroke="#141619" stroke-width="1.7"/><rect x="5" y="5" width="10" height="10" rx="2" fill="#3b372e" stroke="#141619" stroke-width="1.3"/><circle cx="10" cy="10" r="2.8" fill="#64b5f6"/></svg>`;
    case 'turret':
      return `<svg ${s}><circle cx="8.5" cy="10.8" r="6" fill="#a8926e" stroke="#141619" stroke-width="1.6"/><circle cx="8.5" cy="10.8" r="3.8" fill="#2b3036" stroke="#adb5bd" stroke-width="1.2"/><rect x="8.5" y="9" width="9.8" height="3.6" rx="1" fill="#1b1e21" stroke="#141619" stroke-width="1.2"/><circle cx="8" cy="10.8" r="1.8" fill="#f5d451"/></svg>`;
    case 'trap':
      return `<svg ${s}><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" fill="#473625" stroke="#141619" stroke-width="1.6"/><polygon points="4.5,14 6.8,6.5 9,14" fill="#dee2e6" stroke="#141619" stroke-width="0.9"/><polygon points="11,14 13.2,6.5 15.5,14" fill="#dee2e6" stroke="#141619" stroke-width="0.9"/></svg>`;

    // ---- 遗迹内部可搜刮建筑专属图标 ----
    case 'ancient_locker':
      return `<svg ${s}><rect x="3.5" y="2" width="13" height="16" rx="1.5" fill="#435263" stroke="#64dfdf" stroke-width="1.5"/><line x1="10" y1="2" x2="10" y2="18" stroke="#141619" stroke-width="1.4"/><circle cx="8" cy="10" r="1.3" fill="#64dfdf"/><circle cx="12" cy="10" r="1.3" fill="#f5d451"/></svg>`;
    case 'ancient_crate':
      return `<svg ${s}><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" fill="#82633d" stroke="#f5d451" stroke-width="1.5"/><line x1="2.5" y1="9.5" x2="17.5" y2="9.5" stroke="#141619" stroke-width="1.5"/><rect x="8" y="7.5" width="4" height="4" rx="0.8" fill="#f5d451" stroke="#141619" stroke-width="1"/></svg>`;
    case 'ancient_worktable':
      return `<svg ${s}><rect x="1.5" y="5" width="17" height="10" rx="2" fill="#2c3a4a" stroke="#64dfdf" stroke-width="1.5"/><rect x="3.5" y="7" width="7" height="5" fill="#00b4d8"/><circle cx="14" cy="10" r="2.4" fill="#f5d451"/></svg>`;
    case 'ancient_cryptosleep_casket':
      return `<svg ${s}><rect x="2" y="4" width="16" height="12" rx="3.5" fill="#3d4352" stroke="#f5d451" stroke-width="1.6"/><rect x="4.5" y="6" width="11" height="8" rx="2" fill="#48cae4" stroke="#141619" stroke-width="1.1"/></svg>`;

    // ---- 武器与护甲图标（RimWorld Gear Tab 描图） ----
    case 'weapon_rifle':
      return `<svg ${s}><path d="M2 14 L7 9 L17.5 4 L18.5 5.8 L9.5 11.2 L7.5 14.5 L3.5 16 Z" fill="#8d5b34" stroke="#141619" stroke-width="1.4"/><line x1="7.5" y1="9.2" x2="18" y2="4.5" stroke="#ced4da" stroke-width="2.2"/><rect x="9" y="6.2" width="4.5" height="1.8" transform="rotate(-24 11 7)" fill="#495057"/></svg>`;
    case 'weapon_assault':
      return `<svg ${s}><path d="M2 13.5 L6.5 9.5 L17.8 4.8 L18.5 6.8 L11.5 10.2 L12.5 14 L10.2 14.8 L9.2 11.2 L5.5 15 Z" fill="#343a40" stroke="#141619" stroke-width="1.3"/><line x1="6" y1="9.5" x2="18" y2="5.2" stroke="#adb5bd" stroke-width="2"/><rect x="8.5" y="5.5" width="4.2" height="2" transform="rotate(-21 10.5 6.5)" fill="#f5d451"/></svg>`;
    case 'weapon_charge':
      return `<svg ${s}><rect x="2.5" y="7" width="15" height="6" rx="2" transform="rotate(-18 10 10)" fill="#2b3642" stroke="#64dfdf" stroke-width="1.4"/><line x1="4" y1="11.5" x2="16.5" y2="7.5" stroke="#64dfdf" stroke-width="2.2"/><circle cx="10" cy="9.6" r="1.8" fill="#ffffff"/></svg>`;
    case 'weapon_lance':
    case 'weapon_sword':
      return `<svg ${s}><line x1="3" y1="17" x2="16.5" y2="3.5" stroke="#8d5b34" stroke-width="2.4"/><polygon points="11.5,5.5 18,2 14.5,8.5 13,7" fill="#e9ecef" stroke="#141619" stroke-width="1.2"/><circle cx="11.5" cy="8.5" r="1.8" fill="#f5d451" stroke="#141619" stroke-width="1"/></svg>`;
    case 'weapon_crossbow':
      return `<svg ${s}><path d="M4 6 Q10 1.5 16 6" fill="none" stroke="#adb5bd" stroke-width="2.2"/><line x1="4" y1="6" x2="16" y2="6" stroke="#ced4da" stroke-width="1.1"/><line x1="10" y1="2.5" x2="10" y2="17.5" stroke="#8d5b34" stroke-width="2.6"/><polygon points="10,1.5 8,5 12,5" fill="#f5d451"/></svg>`;
    case 'apparel_helmet':
      return `<svg ${s}><path d="M4 13 C4 6, 16 6, 16 13 L17 15 H3 Z" fill="#4a5759" stroke="#141619" stroke-width="1.6"/><rect x="6" y="10" width="8" height="2.6" rx="1" fill="#64dfdf" stroke="#141619" stroke-width="1"/><circle cx="6" cy="6.5" r="2.2" fill="#d8b48e" stroke="#141619" stroke-width="1.1"/><circle cx="14" cy="6.5" r="2.2" fill="#d8b48e" stroke="#141619" stroke-width="1.1"/></svg>`;
    case 'apparel_duster':
      return `<svg ${s}><polygon points="6,3 14,3 17.5,8 15,9.5 13.5,7.5 14.5,17.5 5.5,17.5 6.5,7.5 5,9.5 2.5,8" fill="#9c6644" stroke="#141619" stroke-width="1.5"/><line x1="10" y1="3.5" x2="10" y2="17.5" stroke="#582f0e" stroke-width="1.4"/></svg>`;
    case 'apparel_vest':
      return `<svg ${s}><path d="M5.5 3.5 H8.5 L10 6 L11.5 3.5 H14.5 L15.5 9 L14.5 16.5 H5.5 L4.5 9 Z" fill="#3d5a45" stroke="#141619" stroke-width="1.6"/><rect x="7" y="8" width="6" height="5.5" rx="1" fill="#52796f" stroke="#141619" stroke-width="1"/></svg>`;
    case 'apparel_power':
      return `<svg ${s}><polygon points="4,4.5 8,3 12,3 16,4.5 17.5,9.5 14.5,17 5.5,17 2.5,9.5" fill="#ced4da" stroke="#141619" stroke-width="1.6"/><polygon points="7,6.5 13,6.5 11.8,13.5 8.2,13.5" fill="#355c8a" stroke="#f5d451" stroke-width="1.1"/><circle cx="10" cy="9.5" r="1.6" fill="#64dfdf"/></svg>`;
    case 'apparel_shirt':
      return `<svg ${s}><polygon points="6.5,4 13.5,4 16.5,7.5 14.5,9.5 13,8 13,16 7,16 7,8 5.5,9.5 3.5,7.5" fill="#457b9d" stroke="#141619" stroke-width="1.5"/></svg>`;
    case 'armor_sharp':
      return `<svg ${s}><path d="M10 2 L16.5 5 V10.5 C16.5 14.5, 13.5 17.2, 10 18.5 C6.5 17.2, 3.5 14.5, 3.5 10.5 V5 Z" fill="#3d5a80" stroke="#90e0ef" stroke-width="1.5"/><line x1="7" y1="13" x2="13" y2="6.5" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>`;
    case 'armor_blunt':
      return `<svg ${s}><path d="M10 2 L16.5 5 V10.5 C16.5 14.5, 13.5 17.2, 10 18.5 C6.5 17.2, 3.5 14.5, 3.5 10.5 V5 Z" fill="#5c4d3c" stroke="#f5d451" stroke-width="1.5"/><rect x="6.5" y="7" width="7" height="4.5" rx="1" fill="#f5d451"/></svg>`;
    case 'armor_heat':
      return `<svg ${s}><path d="M10 2.5 C14.5 7, 15.5 11.5, 10 17.5 C4.5 11.5, 5.5 7, 10 2.5 Z" fill="#e85d04" stroke="#ffba08" stroke-width="1.4"/><circle cx="10" cy="12.5" r="2.3" fill="#fff3b0"/></svg>`;
    case 'temp_comfort':
      return `<svg ${s}><rect x="8" y="2.5" width="4" height="11" rx="2" fill="#2b3440" stroke="#8cb8e8" stroke-width="1.4"/><circle cx="10" cy="14.5" r="3.5" fill="#ff6b6b" stroke="#8cb8e8" stroke-width="1.4"/><line x1="10" y1="6" x2="10" y2="14" stroke="#ff6b6b" stroke-width="1.8"/></svg>`;

    // ---- 资源与物品图标（RimWorld 原版物品栏描图） ----
    case 'meal':
      return `<svg ${s}><rect x="2.5" y="3.5" width="15" height="13" rx="3" fill="#ddb892" stroke="#141619" stroke-width="1.6"/><ellipse cx="10" cy="10.2" rx="5" ry="3.6" fill="#c94a38"/><circle cx="8.2" cy="9.4" r="1.4" fill="#7ef09d"/><circle cx="11.8" cy="10.8" r="1.3" fill="#f5d451"/></svg>`;
    case 'food':
    case 'berry':
      return `<svg ${s}><circle cx="7.2" cy="11.8" r="3.8" fill="#d62828" stroke="#141619" stroke-width="1.3"/><circle cx="12.8" cy="11.8" r="3.8" fill="#e63946" stroke="#141619" stroke-width="1.3"/><circle cx="10" cy="8.2" r="3.8" fill="#ff4d6d" stroke="#141619" stroke-width="1.3"/><path d="M10 4.5 L7.5 2 M10 4.5 L12.8 2" stroke="#52b788" stroke-width="2" stroke-linecap="round"/></svg>`;
    case 'meat':
      return `<svg ${s}><path d="M3.5 11 C3.5 5.5, 10 3.5, 15.5 6 C17.5 8, 16.5 14.5, 11 16.2 C5.5 16.2, 3.5 14, 3.5 11 Z" fill="#c92a2a" stroke="#141619" stroke-width="1.6"/><circle cx="11.8" cy="9.5" r="2.3" fill="#f8f9fa" stroke="#6b1515" stroke-width="1.1"/></svg>`;
    case 'leather':
      return `<svg ${s}><path d="M5 2.5 L15 2.5 L17.5 8 L15 17.5 L5 17.5 L2.5 8 Z" fill="#b07d4f" stroke="#141619" stroke-width="1.6"/><path d="M6.8 6.5 H13.2 M6.8 10.5 H13.2" stroke="#7f5539" stroke-width="1.3"/></svg>`;
    case 'wood':
      return `<svg ${s}><rect x="2" y="10.5" width="14.5" height="5.2" rx="2.3" fill="#8d5b34" stroke="#141619" stroke-width="1.5"/><rect x="3" y="5" width="14" height="5.2" rx="2.3" fill="#a46d41" stroke="#141619" stroke-width="1.5"/><circle cx="15.2" cy="7.6" r="1.9" fill="#ddb892"/><circle cx="15" cy="13.1" r="1.9" fill="#ddb892"/></svg>`;
    case 'stone':
      return `<svg ${s}><polygon points="3.5,15.5 2.5,9 8,4.5 15.5,5.5 17.5,12 14,16.5" fill="#8d99ae" stroke="#141619" stroke-width="1.6"/><polyline points="3,9 9.5,11 14,16" fill="none" stroke="#495057" stroke-width="1.3"/></svg>`;
    case 'ore':
      return `<svg ${s}><polygon points="3,15.5 4.8,5.8 11.2,3.8 17.2,8 15.2,16.2" fill="#6c757d" stroke="#141619" stroke-width="1.6"/><circle cx="8" cy="9" r="1.8" fill="#90e0ef"/><circle cx="12.5" cy="11.5" r="1.8" fill="#90e0ef"/></svg>`;
    case 'gold':
      return `<svg ${s}><polygon points="2.5,14.5 5.5,7.5 14.5,7.5 17.5,14.5" fill="#f5d451" stroke="#141619" stroke-width="1.6"/><polygon points="5,10 7.5,4.5 12.5,4.5 15,10" fill="#ffe066" stroke="#141619" stroke-width="1.4"/></svg>`;
    case 'jade':
      return `<svg ${s}><polygon points="10,2 16.5,8 13.2,17.2 6.8,17.2 3.5,8" fill="#2ec4b6" stroke="#141619" stroke-width="1.6"/><polyline points="10,2 10,17" stroke="#cbf3f0" stroke-width="1.1"/></svg>`;
    case 'herb':
    case 'medical':
      return `<svg ${s}><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="#2b9348" stroke="#141619" stroke-width="1.6"/><path d="M10 6.2 V13.8 M6.2 10 H13.8" stroke="#ffffff" stroke-width="2.4"/></svg>`;
    case 'components':
      return `<svg ${s}><circle cx="10" cy="10" r="6" fill="#adb5bd" stroke="#141619" stroke-width="1.8"/><circle cx="10" cy="10" r="2.4" fill="#141619"/><line x1="10" y1="1.5" x2="10" y2="4" stroke="#adb5bd" stroke-width="2.2"/><line x1="10" y1="16" x2="10" y2="18.5" stroke="#adb5bd" stroke-width="2.2"/><line x1="1.5" y1="10" x2="4" y2="10" stroke="#adb5bd" stroke-width="2.2"/><line x1="16" y1="10" x2="18.5" y2="10" stroke="#adb5bd" stroke-width="2.2"/></svg>`;

    // ---- 指令与交互图标 ----
    case 'mine':
      return `<svg ${s}><path d="M4 16 L13 7 M9 3 C14 3, 17 6, 17 11 L12.5 8.5 L8.5 4.5 Z" stroke="#141619" stroke-width="1.6" fill="#ced4da" stroke-linecap="round"/><line x1="3.5" y1="16.5" x2="11" y2="9" stroke="#a46d41" stroke-width="2.4" stroke-linecap="round"/></svg>`;
    case 'chop':
      return `<svg ${s}><polygon points="10,1.8 16.5,10.5 12.2,10.5 15.5,15 4.5,15 7.8,10.5 3.5,10.5" fill="#52b788" stroke="#141619" stroke-width="1.5"/><rect x="8.4" y="15" width="3.2" height="3.8" fill="#7f5539" stroke="#141619" stroke-width="1"/></svg>`;
    case 'harvest':
      return `<svg ${s}><path d="M5 15 C5 8, 11 4, 16.5 4 C14.5 9, 10.5 13, 5 15 Z" fill="#f5d451" stroke="#141619" stroke-width="1.5"/><line x1="3.8" y1="16.2" x2="9" y2="11" stroke="#8d5b34" stroke-width="2.2"/></svg>`;
    case 'deconstruct':
      return `<svg ${s}><path d="M4 16 L14 6 M11 3 L17 9 L14.5 11.5 L8.5 5.5 Z" fill="#ff9f43" stroke="#141619" stroke-width="1.6"/></svg>`;
    case 'hunt':
      return `<svg ${s}><circle cx="10" cy="10" r="6.5" fill="none" stroke="#ff6b6b" stroke-width="1.8"/><circle cx="10" cy="10" r="2.2" fill="#ff6b6b"/><line x1="10" y1="1.5" x2="10" y2="5" stroke="#ff6b6b" stroke-width="1.6"/><line x1="10" y1="15" x2="10" y2="18.5" stroke="#ff6b6b" stroke-width="1.6"/><line x1="1.5" y1="10" x2="5" y2="10" stroke="#ff6b6b" stroke-width="1.6"/><line x1="15" y1="10" x2="18.5" y2="10" stroke="#ff6b6b" stroke-width="1.6"/></svg>`;
    case 'scavenge':
      return `<svg ${s}><circle cx="8.5" cy="8.5" r="5.2" fill="rgba(100,223,223,0.28)" stroke="#64dfdf" stroke-width="2"/><line x1="12.5" y1="12.5" x2="17.5" y2="17.5" stroke="#f5d451" stroke-width="2.6" stroke-linecap="round"/></svg>`;
    case 'haul':
      return `<svg ${s}><rect x="2.5" y="5" width="11" height="10" rx="1.5" fill="#c99b72" stroke="#141619" stroke-width="1.5"/><path d="M12 10 H18 M15 7 L18 10 L15 13" stroke="#7ef09d" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
    case 'draft':
      return `<svg ${s}><path d="M4 16 L16 4 M12 4 H16 V8 M4 4 L16 16 M4 8 V4 H8" stroke="#ff6b6b" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`;
    case 'move':
      return `<svg ${s}><polygon points="10,2 17,10 13,10 13,17 7,17 7,10 3,10" fill="#7ef09d" stroke="#141619" stroke-width="1.5"/></svg>`;
    case 'trade':
    case 'world':
      return `<svg ${s}><circle cx="10" cy="10" r="7.5" fill="#2b5876" stroke="#8cb8e8" stroke-width="1.5"/><ellipse cx="10" cy="10" rx="3.8" ry="7.5" fill="none" stroke="#8cb8e8" stroke-width="1.1"/><line x1="2.5" y1="10" x2="17.5" y2="10" stroke="#8cb8e8" stroke-width="1.1"/></svg>`;
    case 'rotate':
      return `<svg ${s}><path d="M15 6 A6 6 0 1 0 16 11" fill="none" stroke="#f5d451" stroke-width="2"/><polygon points="15,2 18,7 12,7" fill="#f5d451"/></svg>`;
    case 'cancel':
      return `<svg ${s}><line x1="4" y1="4" x2="16" y2="16" stroke="#ff6b6b" stroke-width="2.5" stroke-linecap="round"/><line x1="16" y1="4" x2="4" y2="16" stroke="#ff6b6b" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    case 'roof':
      return `<svg ${s}><polygon points="10,2.5 18,10 15,10 15,17 5,17 5,10 2,10" fill="#4cd964" stroke="#141619" stroke-width="1.5"/></svg>`;
    case 'schedule':
      return `<svg ${s}><circle cx="10" cy="10" r="7.5" fill="#2b3440" stroke="#f5d451" stroke-width="1.6"/><polyline points="10,5.5 10,10.5 14,12.5" fill="none" stroke="#f5d451" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    case 'work':
      return `<svg ${s}><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" fill="#283038" stroke="#9ec2e6" stroke-width="1.5"/><line x1="2.5" y1="8" x2="17.5" y2="8" stroke="#9ec2e6" stroke-width="1.2"/><line x1="8" y1="3.5" x2="8" y2="16.5" stroke="#9ec2e6" stroke-width="1.2"/><circle cx="12.5" cy="12" r="2.2" fill="#7ef09d"/></svg>`;
    case 'architect':
      return `<svg ${s}><polygon points="3,16 14,5 16.5,7.5 5.5,18.5" fill="#f5d451" stroke="#141619" stroke-width="1"/><rect x="11" y="2" width="6.5" height="4" transform="rotate(45 14 4)" fill="#adb5bd" stroke="#141619" stroke-width="1"/></svg>`;
    case 'groups':
      return `<svg ${s}><circle cx="7" cy="7" r="3.2" fill="#8cb8e8" stroke="#141619" stroke-width="1"/><path d="M2.5 16 C2.5 12, 11.5 12, 11.5 16 Z" fill="#4ea8de" stroke="#141619" stroke-width="1"/><circle cx="13.5" cy="7.5" r="2.8" fill="#f5d451" stroke="#141619" stroke-width="1"/><path d="M10 16 C10 12.5, 17.5 12.5, 17.5 16 Z" fill="#d4a017" stroke="#141619" stroke-width="1"/></svg>`;
    case 'dlc':
      return `<svg ${s}><polygon points="10,2 17,6 17,14 10,18 3,14 3,6" fill="#3d5a80" stroke="#90e0ef" stroke-width="1.5"/><polyline points="3,6 10,10 17,6" fill="none" stroke="#90e0ef" stroke-width="1.2"/><line x1="10" y1="10" x2="10" y2="18" stroke="#90e0ef" stroke-width="1.2"/></svg>`;
    case 'help':
      return `<svg ${s}><circle cx="10" cy="10" r="7.5" fill="#3b4d5e" stroke="#f5d451" stroke-width="1.6"/><text x="10" y="14" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">?</text></svg>`;
    case 'corpse':
    case 'skull':
      return `<svg ${s}><circle cx="10" cy="8.5" r="5.5" fill="#dee2e6" stroke="#141619" stroke-width="1.5"/><rect x="7" y="12" width="6" height="4" rx="1" fill="#dee2e6" stroke="#141619" stroke-width="1.3"/><circle cx="8" cy="8.5" r="1.4" fill="#141619"/><circle cx="12" cy="8.5" r="1.4" fill="#141619"/></svg>`;
    case 'pawn_ratkin':
      return `<svg ${s}><circle cx="5.2" cy="4.8" r="3.4" fill="#d8b48e" stroke="#141619" stroke-width="1.4"/><circle cx="5.2" cy="4.8" r="1.7" fill="#e5989b"/><circle cx="14.8" cy="4.8" r="3.4" fill="#d8b48e" stroke="#141619" stroke-width="1.4"/><circle cx="14.8" cy="4.8" r="1.7" fill="#e5989b"/><polygon points="6,11 14,11 16,18 4,18" fill="#355c8a" stroke="#141619" stroke-width="1.4"/><circle cx="10" cy="8.2" r="4.8" fill="#f5d7bc" stroke="#141619" stroke-width="1.5"/><rect x="6.5" y="3.2" width="7" height="1.6" rx="0.8" fill="#ffffff" stroke="#141619" stroke-width="0.9"/><circle cx="8.2" cy="8" r="1" fill="#141619"/><circle cx="11.8" cy="8" r="1" fill="#141619"/></svg>`;
    case 'wind_turbine':
      return `<svg ${s}><rect x="2" y="13.5" width="16" height="4.5" rx="1.2" fill="#495057" stroke="#141619" stroke-width="1.4"/><line x1="10" y1="7" x2="10" y2="15" stroke="#ced4da" stroke-width="2.4"/><polygon points="10,7 10,1 12.2,6" fill="#e9ecef" stroke="#141619" stroke-width="0.9"/><polygon points="10,7 16,10.5 10.5,8.8" fill="#e9ecef" stroke="#141619" stroke-width="0.9"/><polygon points="10,7 4,10.5 9.5,8.8" fill="#e9ecef" stroke="#141619" stroke-width="0.9"/><circle cx="10" cy="7" r="1.8" fill="#64dfdf" stroke="#141619" stroke-width="1"/></svg>`;
    case 'dining_table':
      return `<svg ${s}><rect x="2.5" y="5" width="15" height="10" rx="2" fill="#8d5b34" stroke="#141619" stroke-width="1.6"/><rect x="4.5" y="6.8" width="11" height="6.4" rx="1" fill="#b07d4f"/><circle cx="7" cy="10" r="1.6" fill="#f8f9fa"/><circle cx="13" cy="10" r="1.6" fill="#f5d451"/></svg>`;
    case 'plant_pot':
      return `<svg ${s}><polygon points="6,11 14,11 12.5,17.5 7.5,17.5" fill="#bc6c25" stroke="#141619" stroke-width="1.4"/><circle cx="10" cy="7.5" r="4" fill="#52b788" stroke="#141619" stroke-width="1.2"/><circle cx="8" cy="8.5" r="2.5" fill="#74c69d"/><circle cx="12" cy="8.5" r="2.5" fill="#40916c"/></svg>`;
    case 'art_sculpture':
      return `<svg ${s}><rect x="4.5" y="14" width="11" height="3.8" rx="1" fill="#6c757d" stroke="#141619" stroke-width="1.4"/><polygon points="10,2.2 14.5,8.5 12,14 8,14 5.5,8.5" fill="#f5d451" stroke="#141619" stroke-width="1.4"/><circle cx="10" cy="7.5" r="1.6" fill="#ffffff"/></svg>`;
    case 'standing_lamp':
      return `<svg ${s}><circle cx="10" cy="10" r="6.5" fill="rgba(255,224,102,0.28)"/><circle cx="10" cy="10" r="3.5" fill="#ffe066" stroke="#141619" stroke-width="1.4"/><circle cx="10" cy="10" r="1.4" fill="#ffffff"/></svg>`;
    case 'royal_carpet':
      return `<svg ${s}><rect x="2" y="3" width="16" height="14" rx="2" fill="#800f2f" stroke="#f5d451" stroke-width="1.6"/><rect x="4.5" y="5.5" width="11" height="9" fill="none" stroke="#ffccd5" stroke-width="1"/><circle cx="10" cy="10" r="2.2" fill="#f5d451"/></svg>`;
    case 'spice_prep_table':
      return `<svg ${s}><rect x="1.5" y="4.5" width="17" height="11" rx="2" fill="#7f5539" stroke="#141619" stroke-width="1.6"/><circle cx="6" cy="10" r="2.6" fill="#e63946" stroke="#141619" stroke-width="1.1"/><circle cx="11" cy="9.5" r="2.2" fill="#f5d451" stroke="#141619" stroke-width="1.1"/><circle cx="15" cy="10.5" r="2" fill="#52b788" stroke="#141619" stroke-width="1.1"/></svg>`;
    case 'rice_grain':
    case 'wheat_flour':
      return `<svg ${s}><ellipse cx="10" cy="11" rx="6.5" ry="5" fill="#f8f9fa" stroke="#141619" stroke-width="1.5"/><path d="M5 11 Q10 15 15 11" fill="#e9c46a" stroke="#141619" stroke-width="1.2"/></svg>`;
    case 'corn_sweet':
    case 'potato_tuber':
      return `<svg ${s}><ellipse cx="10" cy="10" rx="4.5" ry="6.8" transform="rotate(-20 10 10)" fill="#f5d451" stroke="#141619" stroke-width="1.5"/><path d="M7 13 C7 9, 13 9, 13 15" fill="#52b788" stroke="#141619" stroke-width="1.1"/></svg>`;
    case 'glow_mushroom':
      return `<svg ${s}><path d="M3.5 10.5 C3.5 4, 16.5 4, 16.5 10.5 Z" fill="#48cae4" stroke="#141619" stroke-width="1.5"/><rect x="7.8" y="10.5" width="4.4" height="6.2" rx="1.5" fill="#caf0f8" stroke="#141619" stroke-width="1.3"/><circle cx="8" cy="7.5" r="1.2" fill="#ffffff"/><circle cx="12.2" cy="8" r="1" fill="#ffffff"/></svg>`;
    case 'frost_greens':
      return `<svg ${s}><circle cx="10" cy="10.5" r="6" fill="#52b788" stroke="#141619" stroke-width="1.5"/><path d="M10 5 V15 M7 8 L10 11 L13 8" stroke="#d8f3dc" stroke-width="1.5" fill="none"/></svg>`;
    case 'prime_cut':
      return `<svg ${s}><rect x="3" y="5" width="14" height="10" rx="3" fill="#d62828" stroke="#141619" stroke-width="1.6"/><path d="M5 8 H15 M6 11.5 H14" stroke="#ffc6ff" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    case 'fresh_fish':
      return `<svg ${s}><path d="M2.5 10 C6 5, 12 5, 15 10 C12 15, 6 15, 2.5 10 Z" fill="#4ea8de" stroke="#141619" stroke-width="1.5"/><polygon points="14.5,10 18,6.5 18,13.5" fill="#4ea8de" stroke="#141619" stroke-width="1.3"/><circle cx="6" cy="9.2" r="1.1" fill="#ffffff"/></svg>`;
    case 'poultry_egg':
      return `<svg ${s}><ellipse cx="10" cy="10.5" rx="5.2" ry="6.8" fill="#ffe5d9" stroke="#141619" stroke-width="1.5"/><circle cx="10" cy="11.5" r="2.6" fill="#ffb703"/></svg>`;
    case 'aromatic_spice':
      return `<svg ${s}><path d="M5 14 C5 8, 11 4, 15.5 4.5 C15 10, 11 15, 5 14 Z" fill="#e63946" stroke="#141619" stroke-width="1.5"/><circle cx="14" cy="14" r="1.5" fill="#f5d451"/></svg>`;
    case 'aged_cheese':
      return `<svg ${s}><polygon points="2.5,14.5 10,4.5 17.5,14.5" fill="#ffb703" stroke="#141619" stroke-width="1.6"/><circle cx="9.5" cy="11.5" r="1.4" fill="#fb8500"/><circle cx="12.8" cy="12.8" r="1" fill="#fb8500"/></svg>`;
    case 'wild_honey':
      return `<svg ${s}><rect x="4.5" y="5.5" width="11" height="11.5" rx="3" fill="#f77f00" stroke="#141619" stroke-width="1.5"/><rect x="6" y="3" width="8" height="2.8" rx="1" fill="#8d5b34" stroke="#141619" stroke-width="1.2"/><circle cx="10" cy="11.2" r="2.8" fill="#fcbf49"/></svg>`;
    case 'dish_charred_skewer':
    case 'dish_campfire_root_stew':
    case 'dish_grilled_river_fish':
    case 'dish_golden_fried_rice':
    case 'dish_creamy_mushroom_ragout':
    case 'dish_honey_glazed_ribs':
    case 'dish_ratkin_berry_cheese_pie':
    case 'dish_polar_spicy_hotpot':
    case 'dish_surf_turf_sashimi':
    case 'dish_royal_ratkin_banquet':
      return `<svg ${s}><circle cx="10" cy="10.5" r="7.2" fill="#f8f9fa" stroke="#141619" stroke-width="1.6"/><circle cx="10" cy="10.5" r="5.2" fill="#e85d04"/><circle cx="8.2" cy="9.5" r="1.6" fill="#f5d451"/><circle cx="12" cy="10" r="1.5" fill="#7ef09d"/><circle cx="10" cy="12.5" r="1.4" fill="#ffe5d9"/></svg>`;
    default:
      return `<svg ${s}><rect x="3" y="3" width="14" height="14" rx="2.5" fill="#495664" stroke="#141619" stroke-width="1.5"/><circle cx="10" cy="10" r="3" fill="#f5d451"/></svg>`;
  }
}
