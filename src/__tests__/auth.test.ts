/**
 * auth.test.ts —— R1-2 可选 Token 鉴权的纯函数测试。
 *
 * 为什么全部打纯函数而不是起 WebSocket：握手鉴权发生在 ws 的 'connection' 事件里，
 * 要覆盖它必须起真实 socket，慢且易 flaky；而这里要验的其实是**判定规则**
 * （没配=开放 / 配了必须匹配 / 拒绝时给什么 code），规则用纯函数表达最直接。
 */
import { describe, expect, it } from 'vitest';
import {
  authorizeAdmin,
  authorizeHandshake,
  extractToken,
  timingSafeEqualStr,
} from '../server/auth';

describe('R1-2 握手鉴权', () => {
  it('未配置 token = 完全开放（本地开发默认，行为与鉴权落地前一致）', () => {
    expect(authorizeHandshake(undefined, '/')).toEqual({ ok: true, reason: undefined });
    expect(authorizeHandshake('', '/')).toEqual({ ok: true, reason: undefined });
    expect(authorizeHandshake('', '/?token=随便什么')).toEqual({ ok: true, reason: undefined });
    expect(authorizeHandshake(null, '/')).toEqual({ ok: true, reason: undefined });
  });

  it('配置 token 后：缺 token 拒（missing-token）、不匹配拒（token-mismatch）、匹配放行', () => {
    expect(authorizeHandshake('secret', '/')).toEqual({ ok: false, reason: 'missing-token' });
    expect(authorizeHandshake('secret', '/?token=wrong')).toEqual({ ok: false, reason: 'token-mismatch' });
    expect(authorizeHandshake('secret', '/?token=')).toEqual({ ok: false, reason: 'token-mismatch' });
    expect(authorizeHandshake('secret', '/?token=secret')).toEqual({ ok: true, reason: undefined });
  });

  it('大小写敏感：Secret ≠ secret', () => {
    expect(authorizeHandshake('Secret', '/?token=secret')).toEqual({ ok: false, reason: 'token-mismatch' });
  });

  it('空 token 配置视为未配置（不该把所有人锁在门外）', () => {
    expect(authorizeHandshake('', '/')).toEqual({ ok: true, reason: undefined });
  });
});

describe('R1-2 URL 取 token', () => {
  it('相对路径 / 绝对 ws URL / 无 query / 其他参数 都能正确解析', () => {
    expect(extractToken('/ws?token=abc')).toBe('abc');
    expect(extractToken('ws://127.0.0.1:8080/?token=abc')).toBe('abc');
    expect(extractToken('/')).toBeNull();
    expect(extractToken('/ws')).toBeNull();
    expect(extractToken('/ws?a=1')).toBeNull();
    expect(extractToken('/ws?a=1&token=abc')).toBe('abc');
  });

  it('URL 编码过的 token 会被正确解码', () => {
    expect(extractToken('/ws?token=a%20b')).toBe('a b');
  });
});

describe('R1-2 定长比较（抗时序侧信道）', () => {
  it('相同串相等；长度不同或首字符不同都判不等', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'ab')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('R1-2 管理命令鉴权（save/load）', () => {
  it('source=system 一律放行（服务端内部发起，不经网络）', () => {
    expect(authorizeAdmin({ src: 'system' }, undefined)).toEqual({ ok: true, reason: undefined });
    expect(authorizeAdmin({ src: 'system' }, 'tok')).toEqual({ ok: true, reason: undefined });
  });

  it('普通连接（无 src/无 token）在未配置 admin token 时被拒', () => {
    expect(authorizeAdmin({}, undefined)).toEqual({ ok: false, reason: 'admin-token-not-configured' });
    expect(authorizeAdmin({}, '')).toEqual({ ok: false, reason: 'admin-token-not-configured' });
  });

  it('配置 admin token 后：持正确 token 放行，缺失/不匹配拒绝', () => {
    expect(authorizeAdmin({ token: 'adm' }, 'adm')).toEqual({ ok: true, reason: undefined });
    expect(authorizeAdmin({}, 'adm')).toEqual({ ok: false, reason: 'missing-token' });
    expect(authorizeAdmin({ token: 'nope' }, 'adm')).toEqual({ ok: false, reason: 'token-mismatch' });
  });
});
