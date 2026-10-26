/**
 * mode.test.ts —— parseClientMode 覆盖矩阵
 *
 * 硬不变量：本地模式（{ kind: 'local' }）的整条调用链不触 WebSocket。
 * 本文件锁死"什么时候算本地模式"这一判定：一旦有人把 `?mode=local` 的路径
 * 误接了 ws、或者把 `?remote=` 从 remote 分支挪进 local 分支，这里当场红。
 *
 * 覆盖矩阵：
 *   - 无参数 → local（默认，纯前端）
 *   - 有 ?seed / ?save 但无 mode/remote → local（存档/种子不影响模式）
 *   - ?mode=local 显式 → local（即使同时带 ?remote= 也 local）
 *   - ?mode=remote + ?server → remote
 *   - ?mode=remote 但无 server → local（配置错误静默降级）
 *   - 历史兼容 ?remote=ws://... → remote
 *   - ?remote= 带 query 参数（token）→ 完整 URL 原样返回
 *   - 拼错的 mode 值 → 继续看 remote= 兜底
 *   - 空 mode → 忽略，走 legacy 兜底
 */
import { describe, expect, it } from 'vitest';
import { parseClientMode } from '../client/mode';

describe('parseClientMode', () => {
  it('空 search → local（默认纯前端）', () => {
    expect(parseClientMode('')).toEqual({ kind: 'local' });
    expect(parseClientMode('?')).toEqual({ kind: 'local' });
  });

  it('?seed / ?save 等本地参数不影响模式判定', () => {
    expect(parseClientMode('?seed=42')).toEqual({ kind: 'local' });
    expect(parseClientMode('?save=1')).toEqual({ kind: 'local' });
    expect(parseClientMode('?seed=42&save=1&hero=3')).toEqual({ kind: 'local' });
  });

  it('显式 ?mode=local → local（即使同时带 ?remote= 也 local）', () => {
    expect(parseClientMode('?mode=local')).toEqual({ kind: 'local' });
    expect(parseClientMode('?mode=local&remote=ws://127.0.0.1:8080')).toEqual({
      kind: 'local',
    });
  });

  it('?mode=local 与其他本地参数共存', () => {
    expect(parseClientMode('?mode=local&seed=42&save=1')).toEqual({ kind: 'local' });
  });

  it('?mode=remote + ?server → remote（URL 原样返回）', () => {
    expect(parseClientMode('?mode=remote&server=ws://127.0.0.1:8080')).toEqual({
      kind: 'remote',
      url: 'ws://127.0.0.1:8080',
    });
    // 带 token query 时整条 URL 保留，供 remote.connect 直接用
    expect(parseClientMode('?mode=remote&server=ws://h:8080?token=abc')).toEqual({
      kind: 'remote',
      url: 'ws://h:8080?token=abc',
    });
  });

  it('?mode=remote 无 server → local（配置错误静默降级，不硬失败）', () => {
    expect(parseClientMode('?mode=remote')).toEqual({ kind: 'local' });
    expect(parseClientMode('?mode=remote&server=')).toEqual({ kind: 'local' });
  });

  it('历史兼容：?remote=ws://... → remote', () => {
    expect(parseClientMode('?remote=ws://127.0.0.1:8080')).toEqual({
      kind: 'remote',
      url: 'ws://127.0.0.1:8080',
    });
    // 历史调用里 remote= 常带 token query：完整保留
    expect(parseClientMode('?remote=ws://h:8080?token=abc')).toEqual({
      kind: 'remote',
      url: 'ws://h:8080?token=abc',
    });
  });

  it('拼错的 mode 值 → 不作为信号，继续看 legacy remote= 兜底', () => {
    // 用户拼成 `remot` 忘了一个 e：mode 忽略，但 remote= 仍能救回来
    expect(parseClientMode('?mode=remot&remote=ws://x')).toEqual({
      kind: 'remote',
      url: 'ws://x',
    });
    // 拼错但没有 remote= 兜底 → 落到本地（比抛错友好）
    expect(parseClientMode('?mode=remot')).toEqual({ kind: 'local' });
  });

  it('空 mode= 不作为信号', () => {
    expect(parseClientMode('?mode=')).toEqual({ kind: 'local' });
    expect(parseClientMode('?mode=&remote=ws://x')).toEqual({
      kind: 'remote',
      url: 'ws://x',
    });
  });

  it('混合查询顺序无关：mode 在前 / 在后 / 中间都一样', () => {
    expect(parseClientMode('?mode=remote&seed=1&server=ws://a')).toEqual({
      kind: 'remote',
      url: 'ws://a',
    });
    expect(parseClientMode('?seed=1&mode=local&server=ws://a')).toEqual({ kind: 'local' });
  });
});
