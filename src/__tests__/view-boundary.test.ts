/**
 * view-boundary.test.ts —— 视图契约 / 表现层 / HUD 三层的结构性边界（2026-10-08 拆分轮）。
 *
 * 守住的三条红线（拆完必须**不能回潮**，所以都变成会红的断言）：
 *  1. **契约 ≠ 表现**：view.ts 只放契约（WorldView + 展示模型），表现数据表
 *     （CARD_LABEL / TRAIT_COLOR / TERRAIN_NAME / cardLabel）归 presentation.ts。
 *     回潮症状：为了"顺手"改个图标去动接口文件，契约与画法重新耦合。
 *  2. **表现层零逻辑依赖**：presentation.ts 只装文案/配色常量，不 import sim/server/registry。
 *     它必须能在不了解模拟的情况下独立阅读——那是"表现层"的定义。
 *  3. **HUD 只订阅快照**：hud.ts / hud/* / hud-faces.ts 不得 import sim 本体，
 *     只允许 `../sim/types`（纯类型）与 `../mods/contracts`（跨层词汇表常量）。
 *     HUD 一旦能摸到 Sim，就会开始"直接读内部状态"（跳过 WorldView 快照），
 *     那正是本轮要拆掉的路径——它让本地/联机两种模式的 HUD 各走一份代码。
 *
 * 另附库存键红线：HUD 取库存必须走 K_STOCK_* 契约常量而不是字面量，
 *  否则 mod 改键名时 HUD 会**静默显示 0**（玩家看不到熟食/肉/草药，机制等于不存在）。
 *
 * 手法与 time-source.test.ts / dlc-twin.test.ts 同款：读生产源码做结构性扫描。
 *  不测运行时行为（那是 hud-panels.test.ts / client-view.test.ts 的职责），
 *  只锁"依赖方向"这种一红就说明有人把层混回去了的结构性事实。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { K_STOCK_FOOD, K_STOCK_WOOD, K_STOCK_MEAL, K_STOCK_MEAT, K_STOCK_HERB } from '../mods/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
function src(rel: string): string {
  return readFileSync(join(HERE, rel), 'utf-8');
}

/** 取出一个文件里所有 `from '...'` / `import '...'` 的模块路径（跨行 import 也能捕到） */
function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const PRESENTATION_EXPORTS = ['CARD_LABEL', 'TRAIT_COLOR', 'TERRAIN_NAME', 'cardLabel'];

describe('视图契约 / 表现层边界', () => {
  it('view.ts 不定义表现数据表（契约文件不装画法）', () => {
    const view = src('../client/view.ts');
    for (const name of PRESENTATION_EXPORTS) {
      // `export const CARD_LABEL` / `export function cardLabel` 两种写法都堵
      const re = new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`);
      expect(re.test(view), `view.ts 不应再导出表现数据表 ${name}（应归 client/presentation.ts）`).toBe(false);
    }
  });

  it('presentation.ts 确实拥有这些表（唯一权威，不是删了没搬家）', () => {
    const pres = src('../client/presentation.ts');
    for (const name of PRESENTATION_EXPORTS) {
      const re = new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`);
      expect(re.test(pres), `presentation.ts 应导出 ${name}`).toBe(true);
    }
  });

  it('presentation.ts 零逻辑依赖（不 import sim / server / registry）', () => {
    const mods = importsOf(src('../client/presentation.ts'));
    for (const mod of mods) {
      expect(mod, `表现层文案表不应依赖 ${mod}`).not.toMatch(/sim|server|registry/);
    }
  });
});

describe('HUD 层只订阅快照（不摸 Sim 内部）', () => {
  const HUD_FILES = ['../client/hud.ts', '../client/hud-faces.ts', '../client/hud/panels.ts', '../client/hud/default-panels.ts'];

  it('HUD 各文件不得 import sim 本体（只允许 sim/types 纯类型与 mods/contracts 词汇表）', () => {
    for (const file of HUD_FILES) {
      const mods = importsOf(src(file));
      for (const mod of mods) {
        const bare = mod.replace(/^\.\.?\//, '');
        if (!mod.startsWith('.') || bare.startsWith('sim/types') || bare.startsWith('mods/contracts')) continue;
        // 允许的：client 内部相对引用（view / presentation / hud/*）、mods/contracts、sim/types
        expect(mod, `${file} 的 HUD 不得依赖 ${mod}（HUD 只能读 WorldView 快照）`).toMatch(
          /^\.[./]'?|^\.\.\/(view|presentation|hud-faces|hud\/|mods\/contracts|sim\/types)$|^\.\.\/\.\.\/mods\/contracts$/,
        );
      }
    }
  });

  it('HUD 库存读取一律走 K_STOCK_* 契约常量（不留裸字面量键）', () => {
    const panels = src('../client/hud/default-panels.ts');
    // 允许的写法：view.stockpile[K_STOCK_FOOD]；违规写法：view.stockpile['food']
    const literal = [...panels.matchAll(/stockpile\[\s*['"]([a-z_]+)['"]\s*\]/g)].map((m) => m[1]);
    expect(literal, 'HUD 不得用字面量取库存键（mod 改键名会静默显示 0）').toEqual([]);
    for (const name of ['K_STOCK_FOOD', 'K_STOCK_WOOD', 'K_STOCK_MEAL', 'K_STOCK_MEAT', 'K_STOCK_HERB']) {
      expect(panels, `HUD 应通过 ${name} 取库存`).toContain(`stockpile[${name}]`);
    }
  });

  it('契约键的字面值不变（本次改造只换写法，不改语义）', () => {
    // 锁住"改字面量→常量"是纯重写：若有人顺手改了键名，HUD 与 sim 会立刻分家。
    expect(K_STOCK_FOOD).toBe('food');
    expect(K_STOCK_WOOD).toBe('wood');
    expect(K_STOCK_MEAL).toBe('meal');
    expect(K_STOCK_MEAT).toBe('meat');
    expect(K_STOCK_HERB).toBe('herb');
  });
});
