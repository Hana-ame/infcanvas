/**
 * scripts/mods.ts —— .mod.json 加载器 CLI（ROADMAP R2-2 任务 3）。
 *
 * 用法：npm run mods -- [目录] [--dry]
 *   --dry  只报告装载清单与错误，不真的装配（用于"我这包能不能上"的体检）
 *
 * 报告内容：发现的文件 / 坏 JSON（文件名级定位）/ 拓扑序 / 装配结果 / 契约违例 / 各注册面数量。
 * 退出码：0 = 全部可用；1 = 有文件坏或装配失败（供 CI 卡门）。
 */
import { ModRegistry } from '../src/mods/registry';
import { DEFAULT_PLAYSTYLE_PACKS } from '../src/mods/packs/playstyle';
import { mountWithBase, readModDir, scanModDir } from '../src/server/mod-loader';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dir = args.find((a) => !a.startsWith('--')) ?? 'mods';

function main(): number {
  console.log(`扫描目录：${dir}${dry ? '（--dry 体检模式）' : ''}\n`);
  const files = scanModDir(dir);
  if (files.length === 0) {
    console.log(`${dir} 下没有 *.mod.json 文件`);
    console.log('   放一个 { manifest:{id,title}, defs:{...} } 文件进去即可，无需改代码。');
    return 0;
  }
  const { ok, err } = readModDir(dir);

  // (1) 坏文件先报（文件名级定位）
  for (const e of err) {
    console.log(`[FAIL] ${e.file}`);
    console.log(`   ${e.reason}`);
  }

  // (2) 装配（--dry 时只做拓扑与解析，不 apply）
  let failed = err.length > 0;
  if (!failed && ok.length > 0) {
    try {
      const { registry, report } = mountWithBase(DEFAULT_PLAYSTYLE_PACKS, ok);
      void registry;
      console.log('\n装配完成');
      console.log(`   拓扑序：${report.order.join(' -> ')}`);
      console.log(`   JSON 包：${report.loaded.join(', ') || '（无）'}`);
      const t = registry.effectiveTuning();
      console.log(
        `   注册面：卡 ${registry.cards.length} / 建筑 ${Object.keys(t.buildings).length}` +
          ` / 敌人 ${Object.keys(t.enemies).length} / 科技 ${Object.keys(t.techs).length}`,
      );
      if (dry) console.log('\n--dry 模式：未实际启动世界，仅校验拓扑与契约');
    } catch (e) {
      failed = true;
      console.log(`[FAIL] 装配失败：${(e as Error).message}`);
    }
  } else if (ok.length === 0) {
    console.log('\n没有可解析的 mod 文件');
  }

  console.log(
    failed
      ? `\n结果：${err.length} 个文件解析失败，请按上面的文件名逐个修复`
      : `\n结果：${ok.length}/${files.length} 个文件可用`,
  );
  return failed ? 1 : 0;
}

process.exitCode = main();
