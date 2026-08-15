// 跨包契约校验回归（2026-08-15 一致性：字符串契约不拼错、不静默失效）
// 发现背景：meta.warmth/meta.wearable/extra.worn 等字符串键由不同包读写，拼错静默失效、
//   只靠测试兜底（用户指摘后设计 contracts.ts 唯一权威表 + key 常量）。本测试保护：
//   ① 默认装配必须通过契约校验（写方都按要求写出）；
//   ② 写方漏写/写错键 → validateContracts 报违例（模拟拼错场景）；
//   ③ 卸载写方包 → 契约空真（不误伤"卸载不破坏核心"纪律）。
import { describe, it, expect } from 'vitest';
import { ModRegistry } from '../registry';
import { validateContracts, COMMAND_CONTRACTS, PROTOCOL_CONTRACTS, K_WARMTH, K_WEARABLE } from '../contracts';

describe('跨包契约校验（contracts.ts）', () => {
  it('默认装配：全部契约满足（validateContracts 空）', () => {
    const m = ModRegistry.default();
    expect(validateContracts(m)).toEqual([]);
  });

  it('写方在场却漏写契约键 → 违例（模拟拼错：衣物 warmth 被覆盖成非数字）', () => {
    const m = ModRegistry.default();
    // 模拟"写方改键名漏了读方"：peltShirt 的 warmth 被写成非数字（deepMerge 忽略
    // undefined patch，故用错误类型值模拟写错，而非删除键）
    m.overrideDef('item', 'peltShirt', { meta: { [K_WARMTH]: 'cold' } }); // 写错类型（拼错模拟：非数字 warmth）
    const errs = validateContracts(m);
    expect(errs.some((e) => e.includes('item.meta.warmth'))).toBe(true);
  });

  it('卸载写方（clothing）→ 契约空真，不误伤卸载纪律', () => {
    const m = ModRegistry.default();
    m.disableSystem('clothing');
    // 无衣物 → warmth/wearable 谓词空真；worn 条目恒真（登记性）
    expect(validateContracts(m)).toEqual([]);
  });

  it('写方与读方引用同一 key 常量（K_WEARABLE/K_WARMTH 与登记表一致）', () => {
    // 防常量改名后契约表/写方引用失联（表内 key 文档串 + 常量名对齐）
    expect(K_WEARABLE).toBe('wearable');
    expect(K_WARMTH).toBe('warmth');
  });

  it('命令契约：衣物在场（clothing 挂载）→ wear 处理器必须已注册（默认装配满足）', () => {
    const m = ModRegistry.default();
    expect(m.commandHandlers.has('wear')).toBe(true);
    expect(validateContracts(m)).toEqual([]);
  });

  it('命令契约违例：有衣物族但 wear 处理器未注册（处理器缺失模拟）', () => {
    // 发现背景：命令协议开放后处理器与玩法数据可漂移——契约表捕获"有衣物可穿却没有
    // wear 处理器"的静默失效。处理器随包 apply 注册、不随系统卸载消失（wear 是纯数据
    // 操作面），故直接删处理器模拟漂移；卸载 clothing 后契约仍满足（见下一条）
    const m = ModRegistry.default();
    m.commandHandlers.delete('wear');
    const errs = validateContracts(m);
    expect(errs.some((e) => e.includes('命令 wear'))).toBe(true);
  });

  it('卸载 clothing：契约仍满足（命令处理器随包不随系统——卸载不破坏玩法面）', () => {
    const m = ModRegistry.default();
    m.disableSystem('clothing');
    expect(m.commandHandlers.has('wear')).toBe(true); // 处理器仍在（脱衣/穿衣数据操作可用）
    expect(validateContracts(m)).toEqual([]);
  });

  it('协议契约：pawns.worn / items.w 登记在表（跨层字段语义唯一权威文档）', () => {
    // 协议字段编译期已有 shared/protocol.ts 类型保护，本断言防登记表被误删
    const all = [...COMMAND_CONTRACTS.map((c) => `命令 ${c.type}`), ...PROTOCOL_CONTRACTS.map((c) => c.key)];
    expect(all).toEqual(expect.arrayContaining(['protocol.pawns.worn', 'protocol.items.w', '命令 wear']));
  });
});