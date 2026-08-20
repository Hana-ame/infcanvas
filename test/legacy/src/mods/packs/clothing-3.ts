// P3-14: 更多服饰（2026-08-20）：鞋/手套/面具/披肩（部位系统扩展）
// 种子原则：只注册物品 + meta.slot → wear 命令自然穿戴 → warmth 叠加
// 部位 = meta.slot（head/feet/hands/face/back/body）；不同部位可同时穿
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';
import { K_WARMTH, K_WEARABLE } from '../../sim/mods/contracts';

export const clothing3Pack: ModPack = {
  id: 'clothing-3',
  requires: ['clothing'],
  apply(m: ModRegistry): void {
    // 鞋（feet）：保暖 + 移动加成
    m.registerItem({ id: 'c3-leatherBoots', name: '皮靴', meta: { [K_WEARABLE]: true, [K_WARMTH]: 1, slot: 'feet', moveBonus: 1.1 } });
    m.registerItem({ id: 'c3-furBoots', name: '毛皮靴', meta: { [K_WEARABLE]: true, [K_WARMTH]: 3, slot: 'feet', moveBonus: 1.15 } });
    // 手套（hands）：保暖 + 工作保护
    m.registerItem({ id: 'c3-leatherGloves', name: '皮手套', meta: { [K_WEARABLE]: true, [K_WARMTH]: 1, slot: 'hands', workBonus: 1.1 } });
    m.registerItem({ id: 'c3-furGloves', name: '毛皮手套', meta: { [K_WEARABLE]: true, [K_WARMTH]: 3, slot: 'hands', workBonus: 1.05 } });
    // 面具（face）：防疾病 + 保暖
    m.registerItem({ id: 'c3-woodenMask', name: '木面具', meta: { [K_WEARABLE]: true, [K_WARMTH]: 0, slot: 'face', diseaseResist: 0.3 } });
    m.registerItem({ id: 'c3-leatherMask', name: '皮面具', meta: { [K_WEARABLE]: true, [K_WARMTH]: 1, slot: 'face', diseaseResist: 0.5 } });
    // 披肩（back）：保暖 + 可叠加
    m.registerItem({ id: 'c3-leatherCape', name: '皮披肩', meta: { [K_WEARABLE]: true, [K_WARMTH]: 3, slot: 'back', stackable: true } });
    m.registerItem({ id: 'c3-furCape', name: '毛皮披风', meta: { [K_WEARABLE]: true, [K_WARMTH]: 5, slot: 'back', stackable: true } });

    // 配方
    m.registerRecipe({ id: 'c3-leatherBoots', name: '缝制皮靴', kind: 'batch', input: [{ item: 'leather', amount: 1 }], output: { item: 'c3-leatherBoots', amount: 1 }, interval: 4 });
    m.registerRecipe({ id: 'c3-furBoots', name: '缝制毛皮靴', kind: 'batch', input: [{ item: 'fur', amount: 1 }], output: { item: 'c3-furBoots', amount: 1 }, interval: 5 });
    m.registerRecipe({ id: 'c3-leatherGloves', name: '缝制皮手套', kind: 'batch', input: [{ item: 'leather', amount: 1 }], output: { item: 'c3-leatherGloves', amount: 1 }, interval: 4 });
    m.registerRecipe({ id: 'c3-furGloves', name: '缝制毛皮手套', kind: 'batch', input: [{ item: 'fur', amount: 1 }], output: { item: 'c3-furGloves', amount: 1 }, interval: 5 });
    m.registerRecipe({ id: 'c3-woodenMask', name: '雕刻木面具', kind: 'batch', input: [{ item: 'wood', amount: 2 }], output: { item: 'c3-woodenMask', amount: 1 }, interval: 3 });
    m.registerRecipe({ id: 'c3-leatherMask', name: '缝制皮面具', kind: 'batch', input: [{ item: 'leather', amount: 1 }], output: { item: 'c3-leatherMask', amount: 1 }, interval: 4 });
    m.registerRecipe({ id: 'c3-leatherCape', name: '缝制皮披肩', kind: 'batch', input: [{ item: 'leather', amount: 2 }], output: { item: 'c3-leatherCape', amount: 1 }, interval: 5 });
    m.registerRecipe({ id: 'c3-furCape', name: '缝制毛皮披风', kind: 'batch', input: [{ item: 'fur', amount: 2 }], output: { item: 'c3-furCape', amount: 1 }, interval: 6 });
  },
};