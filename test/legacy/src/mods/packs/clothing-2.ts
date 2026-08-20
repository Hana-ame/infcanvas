// 服饰扩展包（2026-08-20，用户「丰富服饰可以自己设计」）：
// 新增材质（丝绸/棉/毛皮）+ 染料（绿/紫/黑/白/金）+ 款式（袍/裙/帽/靴/披风/铠甲）
// 设计：每种材质有独特 warmth 值（毛皮极暖/丝绸凉爽/棉适中），每种款式有独特 meta 效果。
// 染料扩展：绿（苔藓）/紫（贝壳）/黑（墨鱼）/白（石灰）/金（金粉——稀有）。
// 新款式 × 新材质 × 新染料 = 大量组合（程序生成染色版）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';
import { K_WARMTH, K_WEARABLE, K_DYE } from '../../sim/mods/contracts';

const CFG = {
  wearMood: 3,         // 穿衣基础心情
  dyeMood: 2,           // 染色额外心情
  // 新材质 warmth 值
  silkWarmth: -2,       // 丝绸：极凉爽（夏天神器）
  cottonWarmth: 1,      // 棉：适中（四季皆宜）
  furWarmth: 8,         // 毛皮：极暖（冬天神器，比皮大衣还暖）
  // 新款式
  robeWarmth: 2,        // 长袍：保暖中等 + 覆盖全身
  skirtWarmth: 0,       // 裙：不保暖但美观（mood 加成高）
  hatWarmth: 1,         // 帽：轻微保暖
  bootsWarmth: 1,       // 靴：轻微保暖 + 移动加成
  cloakWarmth: 4,      // 披风：保暖好 + 可叠加在其他衣物上
  armorWarmth: 3,      // 铠甲：保暖 + 防御（meta.defense）
  // 染料心情加成
  goldDyeMood: 5,       // 金色最珍稀
};

// 新材质
const NEW_MATERIALS: Record<string, { name: string; warmth: number; source: string }> = {
  silk:     { name: '丝绸',  warmth: CFG.silkWarmth,   source: 'silkWorm' },  // 蚕丝→纺织
  cotton:   { name: '棉布',  warmth: CFG.cottonWarmth,  source: 'cottonBush' }, // 棉花→纺纱
  fur:      { name: '毛皮',  warmth: CFG.furWarmth,     source: 'pelt' },      // 兽毛→鞣制（比皮革更厚）
};

// 新款式
const NEW_GARMENTS: Record<string, { name: string; warmth: number; meta?: Record<string, unknown> }> = {
  robe:    { name: '长袍',  warmth: CFG.robeWarmth,    meta: { coverage: 'full' } },
  skirt:   { name: '裙',    warmth: CFG.skirtWarmth,   meta: { beauty: 3 } },
  hat:     { name: '帽',    warmth: CFG.hatWarmth,     meta: { slot: 'head' } },
  boots:   { name: '靴',    warmth: CFG.bootsWarmth,   meta: { slot: 'feet', moveBonus: 1.1 } },
  cloak:   { name: '披风',  warmth: CFG.cloakWarmth,  meta: { slot: 'back', stackable: true } },
  armor:   { name: '铠甲',  warmth: CFG.armorWarmth,  meta: { slot: 'body', defense: 5 } },
};

// 新染料
const NEW_DYES: Record<string, { name: string; item: string; source: string; rarity: number }> = {
  green:  { name: '绿',  item: 'greenDye',  source: 'mossBush',   rarity: 0.002 },  // 苔藓
  purple: { name: '紫',  item: 'purpleDye',  source: 'shellBush',  rarity: 0.0015 }, // 贝壳（稀有）
  black:  { name: '黑',  item: 'blackDye',   source: 'inkBush',    rarity: 0.001 },  // 墨鱼
  white:  { name: '白',  item: 'whiteDye',   source: 'chalkBush', rarity: 0.002 },  // 石灰
  gold:   { name: '金',  item: 'goldDye',    source: 'goldBush',   rarity: 0.0005 }, // 金粉（极稀有）
};

// 原有染料名（复用）
const EXISTING_DYE_NAMES: Record<string, string> = { red: '红', blue: '蓝', yellow: '黄' };

export const clothing2Pack: ModPack = {
  id: 'clothing-2',
  requires: ['clothing'],
  apply(m: ModRegistry): void {
    // ---- 新地形（染料来源灌木 + 丝绸/棉花来源）----
    for (const [id, d] of Object.entries(NEW_DYES)) {
      m.registerTile({
        id: d.source, name: `${d.name}染料丛`, z: 0, passable: true, buildable: false, moveCost: 1.2,
        color: `#${id === 'gold' ? 'daa520' : id === 'purple' ? '6a2a8a' : id === 'black' ? '2a2a2a' : id === 'white' ? 'e8e8e8' : '3a7a3a'}`,
        emoji: '🌿', growable: true,
        harvest: { product: d.item, time: 2, yieldSuccess: 1, yieldFail: 0, dc: 55 },
        sparse: { density: d.rarity },
      });
    }
    // 丝绸来源（蚕树）+ 棉花来源（棉丛）
    m.registerTile({
      id: 'silkWorm', name: '蚕树', z: 0, passable: false, buildable: false,
      color: '#8a8a3a', emoji: '🐛', growable: true,
      harvest: { product: 'silk', time: 3, yieldSuccess: 1, yieldFail: 0, dc: 60 },
      sparse: { density: 0.001 },
    });
    m.registerTile({
      id: 'cottonBush', name: '棉丛', z: 0, passable: true, buildable: false, moveCost: 1.2,
      color: '#c8c8a8', emoji: '🌿', growable: true,
      harvest: { product: 'cotton', time: 2, yieldSuccess: 2, yieldFail: 1, dc: 50 },
      sparse: { density: 0.003 },
    });

    // ---- 新物品（原料 + 染料 + 材质中间品）----
    for (const [id, mat] of Object.entries(NEW_MATERIALS)) {
      m.registerItem({ id, name: mat.name });
    }
    for (const [id, d] of Object.entries(NEW_DYES)) {
      m.registerItem({ id: d.item, name: `${d.name}染料` });
    }

    // ---- 新款式物品（meta.wearable + meta.warmth + 款式特殊 meta）----
    // 每个款式 × 每个新材质 = 一个物品
    for (const [garmentId, garment] of Object.entries(NEW_GARMENTS)) {
      for (const [matId, mat] of Object.entries(NEW_MATERIALS)) {
        const itemId = `${matId}${garmentId.charAt(0).toUpperCase()}${garmentId.slice(1)}`;
        const itemName = `${mat.name}${garment.name}`;
        // warmth = 材质 warmth + 款式 warmth 叠加
        const totalWarmth = mat.warmth + garment.warmth;
        m.registerItem({
          id: itemId, name: itemName,
          meta: { [K_WEARABLE]: true, [K_WARMTH]: totalWarmth, ...garment.meta },
        });
      }
      // 也用原有材质（皮革/麻布）做新款式
      for (const baseMat of ['leather', 'linen']) {
        const itemId = `${baseMat}${garmentId.charAt(0).toUpperCase()}${garmentId.slice(1)}`;
        const itemName = `${baseMat === 'leather' ? '皮' : '麻'}${garment.name}`;
        const baseWarmth = baseMat === 'leather' ? 3 : -1; // 皮革 warmth=3, 麻布 warmth=-1
        const totalWarmth = baseWarmth + garment.warmth;
        m.registerItem({
          id: itemId, name: itemName,
          meta: { [K_WEARABLE]: true, [K_WARMTH]: totalWarmth, ...garment.meta },
        });
      }
    }

    // ---- 染色版（新染料 × 所有款式 × 所有材质）----
    const allDyeNames: Record<string, string> = { ...EXISTING_DYE_NAMES };
    for (const [id, d] of Object.entries(NEW_DYES)) allDyeNames[id] = d.name;

    const allDyeItems: Record<string, string> = { red: 'redDye', blue: 'blueDye', yellow: 'yellowDye' };
    for (const [id, d] of Object.entries(NEW_DYES)) allDyeItems[id] = d.item;

    // 收集所有可穿戴物品 id（原有 3 + 新生成的）
    const allWearables: string[] = ['peltShirt', 'linenShirt', 'leatherCoat'];
    for (const g of Object.keys(NEW_GARMENTS)) {
      for (const mat of [...Object.keys(NEW_MATERIALS), 'leather', 'linen']) {
        const id = `${mat}${g.charAt(0).toUpperCase()}${g.slice(1)}`;
        allWearables.push(id);
      }
    }

    // 程序生成染色版物品
    for (const [dyeId, dyeName] of Object.entries(allDyeNames)) {
      for (const base of allWearables) {
        const itemId = `${dyeId}_${base}`;
        // 查原物品的 warmth
        const baseItem = m.items[base];
        if (!baseItem) continue;
        const baseWarmth = (baseItem.meta as Record<string, unknown>)?.[K_WARMTH] as number | undefined;
        const baseMeta = baseItem.meta as Record<string, unknown>;
        if (m.items[itemId]) continue; // 跳过已注册（原有染料 × 原有款式已在 clothing 包注册）
      m.registerItem({
          id: itemId, name: `${dyeName}的${baseItem.name}`,
          meta: { [K_WEARABLE]: true, [K_WARMTH]: baseWarmth ?? 0, [K_DYE]: dyeId, ...baseMeta },
        });
      }
    }

    // ---- 配方（新材质加工 + 新款式缝制 + 染色）----
    // 材质加工
    m.registerRecipe({ id: 'fur', name: '鞣制毛皮', kind: 'batch', input: [{ item: 'pelt', amount: 3 }], output: { item: 'fur', amount: 1 }, interval: 7 });
    m.registerRecipe({ id: 'silk', name: '抽丝纺绸', kind: 'batch', input: [{ item: 'silk', amount: 3 }], output: { item: 'silk', amount: 1 }, interval: 8 });
    m.registerRecipe({ id: 'cotton', name: '纺棉纱', kind: 'batch', input: [{ item: 'cotton', amount: 3 }], output: { item: 'cotton', amount: 2 }, interval: 5 });

    // 款式缝制（每种材质 × 每种款式 = 一个配方）
    const matMap: Record<string, string> = { fur: 'fur', silk: 'silk', cotton: 'cotton', leather: 'leather', linen: 'linen' };
    for (const [gId, g] of Object.entries(NEW_GARMENTS)) {
      for (const [matId, matName] of Object.entries(matMap)) {
        const itemId = `${matId}${gId.charAt(0).toUpperCase()}${gId.slice(1)}`;
        const recipeId = `sew_${matId}_${gId}`;
        const inputAmount = gId === 'robe' || gId === 'cloak' ? 2 : 1;
        const interval = gId === 'armor' ? 10 : 6;
        m.registerRecipe({
          id: recipeId, name: `缝制${matMap[matId] === 'fur' ? '毛皮' : matMap[matId] === 'silk' ? '丝绸' : matMap[matId] === 'cotton' ? '棉' : matMap[matId] === 'leather' ? '皮' : '麻'}${g.name}`,
          kind: 'batch', input: [{ item: matId, amount: inputAmount }],
          output: { item: itemId, amount: 1 }, interval,
        });
      }
    }

    // 染色配方（新染料 × 所有可穿戴）
    for (const [dyeId, dyeItem] of Object.entries(allDyeItems)) {
      for (const base of allWearables) {
        const itemId = `${dyeId}_${base}`;
        if (m.items[itemId]) {
          m.registerRecipe({
            id: `dye2_${dyeId}_${base}`, name: `染（${allDyeNames[dyeId]}）`,
            kind: 'batch',
            input: [{ item: base, amount: 1 }, { item: dyeItem, amount: 1 }],
            output: { item: itemId, amount: 1 }, interval: 4,
          });
        }
      }
    }

    // ---- 科技 ----
    m.registerTech({ id: 'craft:silk', name: '丝绸纺织', unlocks: [], desc: '蚕丝抽丝纺绸，凉爽丝绸衣物', fragments: 4 });
    m.registerTech({ id: 'craft:cotton', name: '棉花纺织', unlocks: [], desc: '棉花纺纱织布，四季皆宜棉衣', fragments: 3 });
    m.registerTech({ id: 'craft:fur', name: '毛皮鞣制', unlocks: [], desc: '厚实毛皮鞣制，严寒地区主力', fragments: 3 });
    m.registerTech({ id: 'craft:garments', name: '裁缝术', unlocks: [], desc: '长袍/裙/帽/靴/披风/铠甲 多款式裁剪', fragments: 4 });
    m.registerTech({ id: 'craft:dye2', name: '高级染料', unlocks: [], desc: '绿/紫/黑/白/金 五色新染料', fragments: 4 });
  },
};