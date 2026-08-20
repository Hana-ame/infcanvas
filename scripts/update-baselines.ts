// DLC 基线自动更新脚本（2026-08-16）
// 用法: npx tsx scripts/update-baselines.ts
// 读取实际 systemDefs/systemIds/packIds → 写回测试文件基线
import { ModRegistry } from '../src/sim/mods/registry';
import { Sim } from '../src/sim/sim';
import * as fs from 'fs';

const mods = ModRegistry.default();
const sim = new Sim({ seed: 1, pawnCount: 1, registry: mods });

const systemDefsCount = mods.systemDefs.length;
const systemIdsCount = sim.systemIds.length;
const packIdsCount = mods.packIds.length;
const systemIdsList = sim.systemIds;

console.log('=== 当前基线 ===');
console.log(`systemDefs: ${systemDefsCount}`);
console.log(`systemIds: ${systemIdsCount}`);
console.log(`packIds: ${packIdsCount}`);
console.log(`systemIds 顺序: ${systemIdsList.join(', ')}`);

// Update assembly.test.ts
const assemblyPath = 'src/sim/__tests__/assembly.test.ts';
let assembly = fs.readFileSync(assemblyPath, 'utf-8');
// Update toHaveLength
assembly = assembly.replace(/expect\(order\)\.toHaveLength\(\d+\);/, `expect(order).toHaveLength(${systemIdsCount});`);
// Update EXPECTED_ORDER
const newOrder = `const EXPECTED_ORDER = [${systemIdsList.map(id => `'${id}'`).join(', ')}];`;
assembly = assembly.replace(/const EXPECTED_ORDER = \[[^\]]+\];/, newOrder);
// Update PACK_IDS (all except 'behavior')
const packIds = systemIdsList.filter(id => id !== 'behavior');
const newPackIds = `const PACK_IDS = [${packIds.map(id => `'${id}'`).join(', ')}];`;
assembly = assembly.replace(/const PACK_IDS = \[[^\]]+\];/, newPackIds);
// Update title
assembly = assembly.replace(/默认装配 = \d+ 系统/, `默认装配 = ${systemIdsCount} 系统`);
fs.writeFileSync(assemblyPath, assembly);
console.log(`\n✅ ${assemblyPath} updated`);

// Update dlc-framework-stress.test.ts
const stressPath = 'src/mods/__tests__/dlc-framework-stress.test.ts';
let stress = fs.readFileSync(stressPath, 'utf-8');
const stressLines = stress.split('\n');
// Line 23: systemDefs before = systemDefsCount
stressLines[22] = `    expect(m.systemDefs.length).toBe(${systemDefsCount}); // 注册面`;
// Line 25: after 1 DLC = systemDefsCount + 1
stressLines[24] = `    expect(m.systemDefs.length).toBe(${systemDefsCount + 1});`;
// Line 27: ① single DLC = systemIdsCount + 1
stressLines[26] = `    expect(sim.systemIds).toHaveLength(${systemIdsCount + 1}); // 装配面`;
// Line 53: ② 8 DLCs = systemIdsCount + 8
stressLines[52] = `    expect(sim.systemIds).toHaveLength(${systemIdsCount + 8});`;
// Line 92: ⑤ baseline = systemIdsCount
stressLines[91] = `    expect(sim.systemIds).toHaveLength(${systemIdsCount});`;
// Line 107: ⑥ 3 DLCs 1 disabled = systemIdsCount + 2
stressLines[106] = `    expect(sim.systemIds).toHaveLength(${systemIdsCount + 2}); // 3 挂 1 禁 → 装配只收 2 个 DLC 系统`;
// Line 122: ⑦ single DLC = systemIdsCount + 1
stressLines[121] = `    expect(sim.systemIds).toHaveLength(${systemIdsCount + 1});`;
fs.writeFileSync(stressPath, stressLines.join('\n'));
console.log(`✅ ${stressPath} updated`);

// Update dlc-deploy.test.ts
const deployPath = 'src/server/__tests__/dlc-deploy.test.ts';
let deploy = fs.readFileSync(deployPath, 'utf-8');
deploy = deploy.replace(/\d+ 默认/, `${systemIdsCount} 默认`);
deploy = deploy.replace(/expect\(sim\.systemIds\)\.toHaveLength\(\d+\);/, `expect(sim.systemIds).toHaveLength(${systemIdsCount + 2});`);
fs.writeFileSync(deployPath, deploy);
console.log(`✅ ${deployPath} updated`);

console.log('\n✅ 基线更新完成！运行 npm test 验证。');
