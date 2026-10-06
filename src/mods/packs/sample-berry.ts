/**
 * mods/packs/sample-berry.ts —— 「浆果与刺蜂」的 TS 包版本（R2-3：同一内容两种部署形态）。
 *
 * 存在意义（R2-3 的验收点）：证明 mods/sample-berry.mod.json（纯数据，放文件即装）
 * 与本文件（TypeScript，DLC 式独立包）表达的是**同一份内容**，走**同一条挂载路径**。
 * 两者的区别只有"作者用什么写"：JSON 作者不需要碰代码仓库，TS 作者能写谓词/系统/命令。
 *
 * 纪律：requires: [] 是硬性显式声明（DLC 独立包，无前置）——与所有包一致。
 * 不进 playstyle 清单：DLC 不是默认内容，需要时按需显式挂载。
 *
 * 与 JSON 版的内容必须逐项对齐（tests/mod-deploy.test.ts 有对照断言，
 * 改了一边忘了另一边会直接测试失败）。
 */
import type { ModPack } from '../pack';
import { SER_GATHER } from '../contracts';

export const sampleBerryPack: ModPack = {
  id: 'sample-berry',
  requires: [],
  apply(m) {
    // ---- 与 JSON 版 mods/sample-berry.mod.json 逐项对应 ----
    m.registerItem({ id: 'blueberry', name: '蓝莓' });
    m.registerBuilding({
      id: 'blueberryBush',
      name: '蓝莓丛',
      cost: { wood: 6 }, // 资源键见 contracts K_STOCK_*
      hp: 60,
      tags: ['shelter'], // 标签词汇见 contracts K_TAG_*
      passable: true,
    });
    m.registerEnemy({ id: 'hornet', name: '刺蜂', hp: 18, dmg: 2, speed: 5.2, atkCd: 1.1, climb: 1 });
    m.registerCard({
      id: 'sample_pick_berry',
      label: '摘蓝莓',
      series: SER_GATHER,
      weight: 6,
      duration: 4,
      // JSON 版没有 action（v1 不支持函数字段），这里演示 TS 版的真正优势：
      // 有谓词（什么时候值得摘）与行为（摘完给什么）。
      condition: (p, ctx) => (ctx.stockpile['food'] ?? 0) < 40,
      action(p, ctx) {
        p.busyUntil = 0; // 立刻收工重抽，避免把这张卡当长承诺
      },
    });
  },
};
