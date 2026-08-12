// mod 打包器：目录（mod.json + defs.json + scripts.js）→ 单文件 .mod.json
// 用法: npm run mod:pack [packages/demo-berry]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(process.cwd(), 'src/mods/packages');
const name = process.argv[2] ?? 'demo-berry';
const dir = join(srcDir, name);
const outDir = join(process.cwd(), 'mods');

const modJson = join(dir, 'mod.json');
if (!existsSync(modJson)) {
  console.error(`找不到 ${modJson}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(modJson, 'utf-8'));
const pkg: Record<string, unknown> = { manifest };
for (const part of ['defs', 'scripts']) {
  const f = join(dir, `${part}.json`);
  const js = join(dir, `${part}.js`);
  const src = existsSync(f) ? f : existsSync(js) ? js : null;
  if (src) pkg[part] = readFileSync(src, 'utf-8');
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${name}.mod.json`);
writeFileSync(out, JSON.stringify(pkg, null, 2));
console.log(`已打包 ${name} → ${out}`);
