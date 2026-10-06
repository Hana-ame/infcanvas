/**
 * server/index.ts —— 服务器 CLI 入口：npm run server -- [端口] [seed]
 */
import { createGameServer } from './game-server';
import { ModRegistry } from '../mods';

const port = Number(process.argv[2] ?? 8080);
const seed = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

createGameServer({ port, seed, registry: ModRegistry.default() }).then((h) => {
  console.log(`🐭 infcanvas 权威服务器已启动`);
  console.log(`   ws://127.0.0.1:${h.port}   seed=${seed ?? 42}`);
  console.log(`   客户端连接：?remote=ws://127.0.0.1:${h.port}`);
});
