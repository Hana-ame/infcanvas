/**
 * server-save.test.ts —— R1-5 服务器侧存档 + R1-1 心跳广播的集成测试。
 *
 * 测试客户端沿用 server.test.ts 的「构造即挂缓冲」写法：
 * 服务器在 open 后立刻发 welcome，等 open 再挂监听会丢首包（真实竞态）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/game-server';
import { SaveStore, isSafeSaveName, timestampName } from '../server/save-store';
import { ModRegistry } from '../mods';
import { Sim } from '../sim';
import { snapshotOf } from '../sim/sim-save';

interface TestClient {
  ws: WebSocket;
  next<T>(t: string, timeoutMs?: number): Promise<T>;
  close(): void;
}
/** 构造即挂缓冲——见 server.test.ts 同名注释（真实竞态踩坑） */
function makeClient(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffer: { t: string }[] = [];
    const waiters: { t: string; resolve: (m: unknown) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string };
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) {
        clearTimeout(waiters[i]!.timer);
        waiters.splice(i, 1)[0]!.resolve(m);
      } else {
        buffer.push(m);
      }
    });
    ws.on('open', () =>
      resolve({
        close: () => ws.close(),
        ws,
        next<T>(t: string, timeoutMs = 8000): Promise<T> {
          const bi = buffer.findIndex((m) => m.t === t);
          if (bi >= 0) return Promise.resolve(buffer.splice(bi, 1)[0] as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`等 ${t} 超时`)), timeoutMs);
            waiters.push({ t, resolve: res as (m: unknown) => void, timer });
          });
        },
      }),
    );
    ws.on('error', reject);
  });
}

describe('R1-5 存档名安全（目录穿越防线）', () => {
  it('放行 [A-Za-z0-9_-]，拦掉一切路径字符', () => {
    expect(isSafeSaveName('t123')).toBe(true);
    expect(isSafeSaveName('my-save_2')).toBe(true);
    expect(isSafeSaveName('../../etc/passwd')).toBe(false);
    expect(isSafeSaveName('a/b')).toBe(false);
    expect(isSafeSaveName('a\\b')).toBe(false);
    expect(isSafeSaveName('..')).toBe(false);
    expect(isSafeSaveName('')).toBe(false);
    expect(isSafeSaveName('a.b')).toBe(false); // 点也可能被用来做后缀欺骗
    expect(isSafeSaveName('x'.repeat(65))).toBe(false); // 超长名
  });

  it('pathFor 对非法名抛错；带/不带 .json 后缀都归一到同一路径', () => {
    const st = new SaveStore('/tmp/whatever');
    expect(st.pathFor('a')).toBe(join('/tmp/whatever', 'a.json'));
    expect(st.pathFor('a.json')).toBe(join('/tmp/whatever', 'a.json'));
    expect(() => st.pathFor('../escape')).toThrow(/非法存档名/);
  });

  it('timestampName 产出符合字符集的名称', () => {
    expect(timestampName(1700000000000)).toBe('t1700000000000');
    expect(isSafeSaveName(timestampName(Date.now()))).toBe(true);
  });
});

describe('R1-5 SaveStore 读写往返', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'infcanvas-save-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写入后可读回，JSON 内容一致', () => {
    const real = new Sim({ seed: 3, registry: ModRegistry.default() });
    const st = new SaveStore(dir);
    const p = st.write('t1', snapshotOf(real));
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).seed).toBe(3);
  });

  it('读不存在的档抛错（响亮失败，不静默当新局）', () => {
    const st = new SaveStore(dir);
    expect(() => st.read('nope')).toThrow(/不存在/);
    expect(st.has('nope')).toBe(false);
    expect(st.has('../escape')).toBe(false); // 非法名不抛，直接 false
  });

  it('坏 JSON 抛错（不静默吞掉损坏的档）', () => {
    const st = new SaveStore(dir);
    st.write('bad', { saveVersion: 1 } as never);
    // 覆写成非法 JSON

    writeFileSync(join(dir, 'bad.json'), '{ not json', 'utf8');
    expect(() => st.read('bad')).toThrow();
  });
});

describe('R1-5 + R1-1 服务器集成', () => {
  let h: GameServerHandle;
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'infcanvas-srvsave-'));
  });
  afterEach(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('心跳：服务端按 pingMs 周期广播 ping（客户端靠它判定链路活着）', async () => {
    h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, pingMs: 80 });
    const c = await makeClient(`ws://127.0.0.1:${h.port}`);
    const ping = await c.next<{ t: string; d: { time: number } }>('ping');
    expect(ping.d.time).toBeGreaterThanOrEqual(0);
    // 周期确实在重复发（不是只发一次）
    await c.next('ping');
    c.close();
  });

  it('save/load 白名单已登记：未授权的 save 被拒且不计为成功', async () => {
    h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, saveDir: dir });
    const c = await makeClient(`ws://127.0.0.1:${h.port}`);
    await c.next('welcome');
    const before = h.rejectedCommands();
    c.ws.send(JSON.stringify({ t: 'cmd', c: { type: 'save', args: { name: 'hack' } } }));
    await new Promise((r) => setTimeout(r, 200));
    // 未设 admin token → 管理命令一律拒绝（不能任何人存档）
    expect(h.rejectedCommands()).toBeGreaterThan(before);
    expect(h.lastSave()).toBeNull();
    expect(existsSync(join(dir, 'hack.json'))).toBe(false);
    c.close();
  });

  it('src=system 的 save 成功落盘并可被 lastSave 读回', async () => {
    h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, saveDir: dir });
    const c = await makeClient(`ws://127.0.0.1:${h.port}`);
    await c.next('welcome');
    c.ws.send(JSON.stringify({ t: 'cmd', c: { type: 'save', args: { name: 'good' }, src: 'system' } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.lastSave()).not.toBeNull();
    expect(h.lastSave()!.name).toBe('good');
    expect(existsSync(join(dir, 'good.json'))).toBe(true);
    c.close();
  });

  it('save 参数校验：目录穿越名被白名单校验拦下', async () => {
    h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, saveDir: dir });
    const c = await makeClient(`ws://127.0.0.1:${h.port}`);
    await c.next('welcome');
    const before = h.rejectedCommands();
    c.ws.send(JSON.stringify({ t: 'cmd', c: { type: 'save', args: { name: '../evil' }, src: 'system' } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.rejectedCommands()).toBeGreaterThan(before);
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
    c.close();
  });

  it('读档：--load 让服务器从存档续跑（time/鼠数还原）', async () => {
    // 先起一个服存档
    h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, saveDir: dir, pingMs: 10_000 });
    const c1 = await makeClient(`ws://127.0.0.1:${h.port}`);
    await c1.next('welcome');
    h.sim.step(0.1);
    h.sim.step(0.1);
    const savedTime = h.sim.time;
    const savedPawns = [...h.sim.pawns()].length;
    c1.ws.send(JSON.stringify({ t: 'cmd', c: { type: 'save', args: { name: 'resume' }, src: 'system' } }));
    await new Promise((r) => setTimeout(r, 200));
    c1.close();
    await h.close();

    // 用 --load 重新起服：time 应从存档点续跑
    h = await createGameServer({ registry: ModRegistry.default(), port: 0, saveDir: dir, loadFrom: 'resume', pingMs: 10_000 });
    expect(h.sim.time).toBeGreaterThanOrEqual(savedTime);
    expect([...h.sim.pawns()].length).toBe(savedPawns);
  });
});
