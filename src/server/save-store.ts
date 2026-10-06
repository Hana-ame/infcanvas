/**
 * server/save-store.ts —— 服务器侧存档的文件出入口（R1-5）。
 *
 * 为什么独立成文件：game-server 负责网络与 tick，存档是纯 IO + 序列化职责。
 * 抽出来后「存档名 → 路径」这条**安全关键**规则（禁目录穿越）可以单独单测，
 * 不必起 WebSocket 服务器。
 *
 * 路径安全：存档名来自网络消息，必须先过 isSafeSaveName 才能拼进路径。
 * 本模块在写盘前再校验一次（纵深防御）：即使调用方漏了过滤，仍会拒绝。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SaveData } from '../sim/sim-save';

/** 存档名安全校验，与 protocol 的同规则校验一致（两处独立实现互为纵深防御）。 */
export function isSafeSaveName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/**
 * 生成默认存档名：t<紧凑时间戳>。
 * 用紧凑形式而非完整毫秒数，是为了让文件名在 ls 里可读；
 * 两种形式都满足 [A-Za-z0-9_-] 字符集。
 */
export function timestampName(nowMs: number): string {
  return 't' + Math.floor(nowMs);
}

/**
 * 存档仓库：固定一个 saves/ 目录，提供「存 / 读 / 判存」三个动作。
 *
 * 为什么不做自动清理：服务端存档是要人工留存的（回滚、复盘），删档是玩家的
 * 破坏性决定，不该由系统在磁盘写满时擅自做。代价是磁盘会涨——这是自觉的取舍，
 * 写在这里以免以后有人当成 bug 顺手加个 LRU。
 */
export class SaveStore {
  constructor(private readonly dir: string) {}

  /** 返回绝对路径；名称非法时抛错（调用方负责翻译成给客户端的失败提示） */
  pathFor(name: string): string {
    const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
    if (!isSafeSaveName(stem)) throw new Error('非法存档名：' + name);
    return join(this.dir, stem + '.json');
  }

  /** 落盘：先 mkdir 再写。返回实际写入的绝对路径。 */
  write(name: string, data: SaveData): string {
    const p = this.pathFor(name);
    mkdirSync(this.dir, { recursive: true });
    // 临时文件 + rename：写到一半崩溃不会留下半个坏档（load 读到坏档会直接炸）
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, p);
    return p;
  }

  /** 读档；文件不存在或 JSON 损坏都抛错（坏档必须响亮失败，不静默当新局开） */
  read(name: string): unknown {
    const p = this.pathFor(name);
    if (!existsSync(p)) throw new Error('存档不存在：' + name);
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  /** 该存档是否存在（load 前预检，避免把「不存在」报成「解析失败」） */
  has(name: string): boolean {
    try {
      return existsSync(this.pathFor(name));
    } catch {
      return false;
    }
  }
}
