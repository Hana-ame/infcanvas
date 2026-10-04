/**
 * server/index.ts —— 服务器 CLI 入口：npm run server -- [端口] [seed]
 *
 * R1-5（2026-10-05 追加）：支持 --load <存档名> 启动即读档、--save-dir <目录> 指定存档位置。
 * R1-2：SERVER_TOKEN 由环境变量注入，命令行不传 token（避免出现在 shell history 与 ps 输出里）。
 */
import { createGameServer } from './game-server';
import { ModRegistry } from '../mods';

interface CliOpts {
  port: number;
  seed: number | undefined;
  load: string | undefined;
  saveDir: string | undefined;
}

/**
 * 解析 argv。约定：**位置参数在前（[端口] [seed]），长选项在后**。
 * 这么做是因为位置参数是历史调用方式（server 8080 42），不能破坏；
 * 靠「选项必须带 -- 前缀」就能与位置参数无歧义地分开，不必引入引号状态机。
 */
function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    port: Number(process.env.PORT ?? 8080),
    seed: undefined,
    load: undefined,
    saveDir: undefined,
  };
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--load') {
      opts.load = argv[++i];
    } else if (a === '--save-dir') {
      opts.saveDir = argv[++i];
    } else if (a.startsWith('-')) {
      // 未知选项直接忽略而不是报错：CLI 的目的是尽快把服务器跑起来，
      // 一个拼错的选项不该让人以为服务器本身坏了。
    } else if (positional === 0) {
      opts.port = Number(a);
      positional++;
    } else if (positional === 1) {
      opts.seed = Number(a);
      positional++;
    }
  }
  return opts;
}

const { port, seed, load, saveDir } = parseArgs(process.argv.slice(2));

createGameServer({
  port,
  seed,
  loadFrom: load,
  saveDir,
  registry: ModRegistry.default(),
}).then((h) => {
  console.log('🐭 infcanvas 权威服务器已启动');
  console.log(`   ws://127.0.0.1:${h.port}   seed=${seed ?? 42}`);
  console.log(`   客户端连接：?remote=ws://127.0.0.1:${h.port}`);
  // R1-2：明确提示鉴权状态。开着却忘了带 token 的玩家会一直看到断连横幅，
  // 提前打印这一行能让「连不上」在服务端侧就能自查出来。
  if (process.env.SERVER_TOKEN) {
    console.log('   🔒 已启用 Token 鉴权：连接需带 ?token=<SERVER_TOKEN>');
  } else {
    console.log('   🔓 未设 SERVER_TOKEN：任何人都能连接并指挥（仅建议本地）');
  }
  if (load) console.log(`   ⤴️ 已从存档读档：${load}`);
});
