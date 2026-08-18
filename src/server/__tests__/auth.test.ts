// 联机可选鉴权测试（2026-08-16 审计低项 L1）：wsTokenOk 是纯函数（无 ws 依赖），
// 直接单测值域——URL 查询参数 token 匹配；未配置 token = 全开放。
import { describe, it, expect } from 'vitest';
import { wsTokenOk } from '../auth';

describe('server 可选 token 鉴权（L1，2026-08-16）', () => {
  it('未配置 token（SERVER_TOKEN 缺省）→ 任何连接放行（向后兼容开放）', () => {
    expect(wsTokenOk('/?token=xxx', undefined)).toBe(true);
    expect(wsTokenOk('/', undefined)).toBe(true);
    expect(wsTokenOk('', undefined)).toBe(true);
  });

  it('配置 token：URL 查询参数匹配才放行', () => {
    const expected = 's3cret';
    expect(wsTokenOk('/?token=s3cret', expected)).toBe(true);
    expect(wsTokenOk('/?token=s3cret&x=1', expected)).toBe(true);
    // 各种失败：缺 token / 空 token / 错 token / 无查询段
    expect(wsTokenOk('/', expected)).toBe(false);
    expect(wsTokenOk('/?token=', expected)).toBe(false);
    expect(wsTokenOk('/?token=wrong', expected)).toBe(false);
    expect(wsTokenOk('/?x=1', expected)).toBe(false);
  });
});