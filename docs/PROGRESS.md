# 实现进度（P0 单机 MVP）

> 与 docs/DESIGN.md 对齐的状态记录。每完成一块打勾并注明对应设计章节。

## 北极星
**模拟一个现实的社会**（DESIGN §0）。当前 P0 在验证"小人自主运转"的最小闭环，
神谕/信仰/LLM 属 P1.5+，此处仅保留确定性骨架。

## 已完成（P0）

| 设计项 | 章节 | 状态 | 说明 |
|---|---|---|---|
| 世界生成 | §3 空间模型 | ✅ | Minecraft-like 值噪声（fBm）：海拔+湿度双轴 → 水/沙/草/沙漠/森林/矿/山。出生点 5x5 保证草地 + **近圈资源保证**（饥荒式开局：出生点 3-8 圈确定性撒树/矿/石，开局采矿不落空） |
| 小人自主 AI | §3/§6 | ✅ | 抽 3 选 1 卡系统（种子化不放回）+ 收益择优；基础卡 + DNA 天赋卡（夜猫子/热爱工作/好斗/虔诚/懒惰/强壮/机灵） |
| 意图失真（简化） | §2/§6 | ✅ | 违抗 roll：仅当选中工作卡且有未选本我卡时触发，概率受懒惰/心情/信仰调制，30s 冷却防刷屏 |
| 插槽系统 | §3 插槽/§6 | ✅ | DNA 决定槽位 + 天赋卡占槽；统一卡模型（天赋卡→技能/习惯/神谕策略卡属 P0.5） |
| COC 技能成长 | §3 技能成长 | ✅ | 技能百分制（work/fight/craft/social/faith）；成长=用技能后掷 d100>当前值→+1d10（COC 规则）；技能检定 rollEventSkill（技能越高越稳）；工作→work、战斗→fight；随存档持久化 |
| COC 八属性 | §3 属性卡 | ✅ | **STR/CON/SIZ/DEX/APP/INT/POW/EDU 全八属性**；天赋调制（强壮→STR/SIZ↑、机灵→INT/DEX↑、夜猫子→POW↑）；用途落地：CON+SIZ→HP 上限、POW→SAN 抗压+压制恶意槽、DEX→战斗闪避、STR→采集产出、APP→信仰传播、INT+EDU→技能起点、INT→检定加成；HUD 八属性显示 |
| 七宗罪欲望 | §3 欲望系统 | ✅ | **P0 版**：七宗罪满足度 + 先天罪孽倾向（DNA.sins，天赋调制）；吃→暴食、休息→懒惰、工作→贪婪、祈祷→傲慢；定期检查→欲望驱动卡权重（匮乏的欲望→对应系列卡权重↑）+ 心情影响；恶意槽（长期匮乏→偷窃/砸建筑/暴躁）；HUD 显示、存档持久化。色欲/嫉妒满足途径待 P1 |
| 寻路 | §3 | ✅ | A*（暗黑格 ×3 代价）+ trailCache 缓存 |
| 需求系统 | §3 | ✅ | 饥饿/精力/心情衰减 + 紧急需求（饿→吃、困→睡）+ 饿死 |
| SAN 理智 | §3 SAN | ✅ | 目睹死亡掉理智（距离衰减）；黑夜远离篝火持续流失；篝火旁恢复；<25 狂乱（发呆/乱跑），行为接管 |
| 昼夜 | §3 | ✅ | 120s/天；夜晚精力消耗快 + 屏幕遮罩 + SAN 黑暗恐惧 |
| 环境系统 | §6 环境调制 | ✅ | **天气/气温**（EnvState）：气温随昼夜波动（正午热/深夜凉）+ 天气偏移；确定性雨-晴循环；环境调制卡权重（下雨→户外工作×0.5、娱乐×1.6；酷暑/严寒→户外工作×0.6、生理×1.3）；HUD 显示天气 |
| 马尔可夫偏置 | §6 卡相互作用 | ✅ | **MARKOV_BIAS**：上一轮卡系列→本轮权重偏置（干完活想歇、吃饱想动、闲了想干活…），数据表驱动（mod 可扩展）；lastSeries 决策链记录 |
| 叙事压力 | §6 叙事压力 | ✅ | **和平越久袭击越猛**：和平时长积累 → 战斗压力（1→2×）→ 袭击间隔缩短 + 规模放大（数量、血量）；"和平→压力→冲突"节奏闭环 |
| 生产 | §3 欲望咬合 | ✅ | 伐木/采矿进度+骰子产出、工作台→工具（采集 ×1.3）、农田产粮、矿洞持续产矿（饥荒式矿场，40s 一轮） |
| 篝火光环 | §3/饥荒式 | ✅ | 篝火 = 社会锚点：半径 6 内心情回暖 + 夜晚不易困（SAN 恢复已由 SanSystem 覆盖）；与祈祷/疗伤/SAN 共同构成篝火的多功能定位 |
| 建造 | §3 | ✅ | 篝火/墙/地板/门/农田/工作台/矿洞；蓝图排队 + 幽灵预览 + 建造进度 |
| 战斗/袭击 | §3 | ✅ | 狼群周期性袭击（人数 scaling），攻击小人/建筑，死亡掉落 |
| 伤亡系统 | §3 | ✅ | HP、战斗受伤、饿死、死亡事件（喂给 SAN 与日志） |
| 历史日志 | §3 历史系统 | ✅ | **结构化仿真日志**（HistoryLog）：订阅全部 GameEvent → 条目（时间/天/类型/实体/地点/原因/事实），可查询（type/eid）、可导出（toJSON）、HUD 有 📜 历史面板；事实只来自 sim（LLM 只润色原则就位） |
| 流言/对话 | §6 狗屁倒灶 | ✅ | **微互动层**（确定性模板，零 LLM）：相遇→打招呼/抱怨/表情，心情+好感度双向变化；话题从结构化历史抽取（聊最近的事）→ `social` 事件入历史；HUD feed 显示 💬 闲聊。**传教对抗**（DESIGN §3 对抗检定）：高信仰者尝试说服→传教者(APP/2+faith/2) vs 目标(POW+信仰抵抗)掷骰比成败→成功升信仰+好感、失败反感。闲聊/深聊 LLM 层待 P1 |
| 修理 | §3 | ✅ | 受损建筑自动修理（RepairSystem） |
| 人口 | §3 | ✅ | 死亡/成长（PopulationSystem） |
| 随机事件 | §6/用户Q5 | ✅ | **预制剧本事件系统**（EventSystem + EventProvider 接口）：流浪者加入/丰收/矿脉/瘟疫/游商/庆典，**状况匹配事件列表**（每个事件带 `condition`——有农田才丰收、有余粮才收留流浪者、人多才有瘟疫…只有符合当前局面的事件进候选池，权重+冷却+minTime 调制）；**provider 可插换 = 预留 LLM 插入能力**（P0 确定性随机，P1 换 LLM provider）；事件入历史 |
| 社会关系 | §3/用户Q8 | ✅ | **好感度驱动行为**：亲密(≥40)相邻→心情加成（协作正向反馈）；敌对(≤-20)相邻→口角、积累冲突→动手（STR 判定、掉血、负好感加深，战争萌芽）；关系由社交微互动/传教积累 |
| 派系优先级 | §3/用户Q8 | ✅ | **AI 按环境下达工作优先指令**（RimWorld 工作优先的确定性版）：每 10s 评估资源短缺/建造队列 → 调制全营地对应工作卡权重（食<60→farm↑、木<40→chop↑、矿<15→mine↑、排队→build↑）；随环境自动转变 |
| 自主扩张 | §3/用户Q1/Q8 | ✅ | **AutonomousBuildSystem**：AI 评估资源与营地状态自动规划扩建（无篝火→起篝火、人多吃紧→加火、缺粮→扩农田、缺工具→工作台、矿少→矿洞、富余→围墙、**信仰高→建教堂**）；20-30s 评估一次注入 buildQueue，小人照常执行；营地自主生长（观察模拟器核心） |
| 教堂 + 神谕 | §3/用户Q2/Q3 | ✅ | **教堂**（2x2，信仰≥35 自动建）+ **神谕影响**：玩家选中教堂→"发布神谕"按钮→祝福附近(半径6)高信仰小人（信任=信仰/100 过滤，低信仰不受影响）：30s 心情 buff + 信仰↑；教堂是神谕唯一物理接口（DESIGN §3）；神谕不直接指挥，只影响目标层 |
| 社会单位/部落记忆 | 用户Q9+即时指令 | ✅ | **有篝火 = 独立派系**。每个篝火 = SocialUnit：部落记忆（成员/事件/看法）、名字、成员归属。**教堂 = 篝火升级**（容量：篝火记 2-3 连接、教堂 5-10）。**篝火间信任机制**：成员协作→看法增；双向友好→贸易（木换食）；双向敌对→派掠夺者攻打对方（战争）→加深仇恨；**派系 = 单位间的看法关系**（友好→贸易/伙伴、敌对→战争，无抽象联盟层）：双向敌对→派掠夺者攻打对方（战争）→加深仇恨。出生点初始篝火=首派系；野生篝火事件刷新新势力 |
| 存档 | §5 | ✅ | **IndexedDB**（异步、大容量），30s 自动存档；旧 localStorage 存档已弃用；含社会单位（派系/记忆/看法/库存/玩家所属）持久化 |
| 渲染 | §1 | ✅ | PixiJS v8；SVG 素材（btoa data-uri → GraphicsContext）；地形/建筑/小人/敌人生成 |
| 视角切换 | §1 渲染 | ✅ | **2D 俯视 ↔ 2.5D 同轴**（右下角按钮）；2.5D 按世界 y 排序实现前后遮挡（树/建筑/小人/敌人统一进 entityLayer，zIndex=y×10+层级） |
| HUD | §1 | ✅ | 资源条、建造菜单、速度控制（⏸/1x/2x/3x）、缩放按钮（+/-）+ PageUp/PageDown、帮助、事件 feed、选中面板（COC 属性/天赋/插槽/需求/HP/信仰/理智/闪念）、建筑面板 |
| 测试 | §6 | ✅ | vitest：RNG 确定性、地形确定性、抽卡、移动/建造/采矿闭环、SAN 目睹死亡/篝火恢复 |
| mod 注册表 | §7 | ✅ | **ModRegistry**（DESIGN §7 扩展性原则）：运行时注册 tile/building/item/**enemy**/card/recipe/event/expansionPlan/intent/work/system/hook + overrideDef/overrideTuning + 冲突检测；`SimOptions.mods` 构造期挂载；详见 docs/DATA_DRIVEN.md（§6 验收 17 项全 ✅，89 测试覆盖） |
| 数据驱动化 | §7 | ✅ | **sim 层 defId 特判清零**：craft 自配方/发光/升级(upgradesTo)/神谕(capabilities)/派系优先级表/敌对种类(enemies.ts)/派系袭击(raider def)/采集目标(growable+harvest)/采后瓦片(harvestReplaces)/光环(aura.radius)/AI 建造成本(def.cost)/出生建筑(tuning) 全部走 defs/tuning/registry，mod 不改内核（DATA_DRIVEN.md §6） |
| 存档健壮性 | §5 | ✅ | save/load JSON-safe：slots 存卡 id 还原（不再存闭包）、load 重建成员归属防假团灭、修复重建时 splice 跳杀残留 pawn |
| P1 server 骨架 | §5/§8/§9 | ✅ | **权威在 server**：Node 复用 `src/sim`（零 DOM ✓ tsx 直跑）+ WSS 通道；协议 `src/shared/protocol.ts`（welcome 全量 tile+defs 只读表 / 2Hz snapshot / tileChanged+feed 增量 / C→S 复用 Sim.Command）；server：固定步进 accumulator + `addTileListener` 增量推送（world.setTile 相同值去重不触发）；client：`?remote=ws://…` 连入，`RemoteSim` 实现与本地 Sim 同构读取面（world/pawns/建筑/需求/属性/欲望/卡池/事件），HUD+Renderer 双端共用；命令经 WSS 上行、server 权威执行、快照回显（e2e：scripts/e2e/remote-viewer.mjs 8 断言全过）。**断线重连（补强）**：client 指数退避自动重连（1s→2s→4s…封顶 15s）+ 首连失败明确报错（红屏提示配置错误）+ 顶部 reconnect hint（`remote-hint`）；**看门狗兜底**：connected 后 5s 无任何消息即判定 server 假死/网络黑洞 → 主动断开重连（不依赖 TCP 超时，`RemoteSim.watchdogMs` 可调）；server kill/重启 e2e 冒烟页面自动恢复（reconnect.test.ts 6 用例） |
| tick delta 增量 | §8/§9 | ✅ | **快照增量（P2 第一块）**：`src/server/diff.ts` 纯函数对比相邻快照 → 只发变化（`DeltaMsg`）：pawn 按 eid 逐字段 diff（x/y/hp/job/needs/faith/skills/slots/desires…）、新 pawn 首现必带 attrs、死亡 removed+pawnList；建筑按 key(y*width+x) 对齐 diff hp、拆除 removed；hostiles/stockpile/buildQueue 整体覆盖；全局字段各自携带。server：500ms 一轮 diff 广播 + 5s 全量对账（防增量丢失/相消漂移）+ 新连接先收全量底（广播过的快照即 diff 基线）；client：`applyDelta` 合并进 pawnCache/世界（读取面零改动，HUD/Renderer 无需区分）。12s e2e 实测 delta 26 帧 vs snapshot 4 帧（带宽 -90%）。测试：diff.test.ts 7 用例 + reconnect.test.ts applyDelta 1 用例 + scripts/e2e/remote-delta.mjs（帧构成/时间/位置断言） |
| 渲染插值 | §1/§8 | ✅ | **位置插值（渲染平滑）**：delta 500ms 一跳 → 渲染层 `interpPos`（pawn + 敌对）按 sim 时间线性插值（段起终点 + t0/t1，k 线性收敛）；`RemoteSim.renderNow()`：**播放时钟**——权威 t 锚定墙钟 + 帧间 extrapolate（speed 加权，paused 冻结），否则 time 只在消息到达时跳变、插值恒 k=1 失效；本地模式同样走插值（每 tick 段极短 ≈ 贴合真实）。顺带修复：死亡/重生 pawn 的渲染残留清理（delta 下 removed 广播后 sprite 及时移除，本地模式同受益）。e2e：scripts/e2e/remote-interp.mjs 采样 60 帧 sprite 位置出现 6-13 个渐进中间值（非 48px 跳变） |
| LLM 慢决策层 | §6/§10 | ✅ | **`LLM_ENDPOINT` 环境变量即启用**（OpenAI 兼容 chat completions）：`src/server/llm.ts` 预取模型（后台拉取 → 事件队列 → EventSystem 同步消费，失败指数退避降级确定性）；LLM 输出 JSON schema（name/text/effects）→ 白名单执行器（resource/mood/hp/recruit，数值钳制，**不进选择链路** ✓ DESIGN §6）；世界摘要随请求携带；`SimOptions.eventProvider` 构造注入。冒烟：mock LLM → server → feed 广播 `🎁 获得 ore 10 ✨ 星陨之夜` |
| 命令权威校验 | §8/§9 | ✅ | **联机安全（P2 前置）**：server `src/server/cmdValidate.ts` 把关上行命令——类型白名单/形状/坐标越界/建筑与职业存在性/`pawnId` 存在性/令牌桶频率（30 条/s，per-client 连接级）；非法命令丢弃并记录（不踢连接）；client 的 build/oracle/assign/move 显式带 pawnId（观察模式 server 无 selected 镜像）+ sim.issueCommand 的 assign 分支支持 pawnId。测试：cmdValidate.test.ts 5 用例 + viewer e2e 9 断言（build 回显 / move 指挥位移） |

## 分支实验记录（feature/colony-survival-dims，2026-08-13）

### 实验目标
四维度殖民地（取水/娱乐/食物/建材）+ 房屋/玩具建筑 + 科技初始只给娱乐（探索式开局），验证能否跑起来。

### 发现并修复的问题（分析报告）

**1. 探索卡蓝图无限入队**（测试超时）
- 现象：探索卡反复触发 → 蓝图堆积 → 队列爆炸
- 根因：探索执行器无去重（神谕垦田令有 buildQueue.some 去重，探索漏了）
- 修复：蓝图已在队列（同 defId）→ 跳过
- 注释：cardSystem.ts execExplore「蓝图已在队列（重复探索）→ 跳过（防蓝图堆积：垦田令同款去重）」

**2. 寻路风暴（性能爆炸，217 倍修复）**
- 现象：模拟 175s 后单步 50ms+，6000 步 99s（cpu profile：findPathRaw 58.9% + findPath 15.7% + GC 11.4%）
- 根因：狼袭击打断小人路径 → path 反复重建 → 每帧寻路 miss（trailCache 命中率低）+ A* 堆分配 → GC 风暴
- 修复（用户指令"寻路次数不要每帧都发生，缓存每一步走 + 限定最大距离"）：
  - `tuning.path.pathCd`（0.5s）寻路节流：moveAdjacent 在冷却内不寻路
  - `tuning.pawn.maxWorkDist`（36）工作目标最大距离：超距不寻路（玩家命令 moveTo 不限）
  - farScanRadius 45→36 与 maxWorkDist 一致（远扫目标超距会被拒，避免白扫）
- 结果：6000 步 99s → 457ms
- 注释：sim.ts moveAdjacent 完整根因记录

**3. 探索卡执行器解析失败**
- 现象：抽到探索卡但建筑永远不建（toy=0）
- 根因：执行器从 label 解析建筑 id，但 label 是科技名（探索·玩具工艺 ≠ 'toy'）
- 修复：label 规范为 `探索:${buildingId}`（机器可解析），显示名走 name 字段

**4. 水井产出丢失（water 恒 0）**
- 现象：well 建成但 water 库存 0
- 根因：FarmSystem 只处理 tags 含 'farm' 的建筑，水井（passive recipe）被跳过
- 修复：FarmSystem 泛化——处理所有 passive recipe 建筑（农田/水井/mod 建筑通用）
- 注释：farmSystem.ts 文件头「曾踩坑：只认 farm tag 导致水井 water 永不产出」

**5. 探索卡抽不到（择优竞争）**
- 现象：探索卡在池中但从不执行
- 根因：utility 16 低于其他卡，pickBest 择优永远不选
- 修复：utility 40 + weight 8（娱乐语境下的探索冲动：抽到即可执行）

### 重玩验证（修复后）
- **渐进权重确认**：科技解锁初期只有娱乐探索命中（D2 解锁→立即"灵光一现建水井"），
  权重 ramp 300s 后普通建造接管（techBuildWeight 0→1，workBuild 无队列按权重规划）
- **水维度归集修复**（💧 恒 0 → 500）：玩家建的建筑（well）产水被野营 campfire 抢归集
  （addProductionNear 按"最近单位"归集）→ 改为按建筑 faction：'player' 建筑产出进全局生产池；
  转发层 Sim.addProductionNear 补 faction 参数（曾漏传导致修复无效）
- **平衡**：buildingDmg 6→3（well 被 5 狼 3 秒拆 → 反复重建循环）；探索落点 3-6→2-5（靠内圈）
- 长局 3600s：💧500(cap) 🍖402 🌲562 👥9-13 稳定，寻路风暴无复发（30s 跑完）

### 实验结果：殖民地能跑起来 ✅
- 人口 4→10（流浪者持续加入）；toy/well/house/raft 全部通过"娱乐探索"建成
- 科技顺序解锁：toyTech→wellTech→houseTech→raftTech→bridgeTech→boatTech
- 终局：👥10 💧386 🍖355 🌲500，四维度全通，无团灭

## 待办 / 差距

> 旧条目若已在上表 ✅ 则移除；以下为当前真实差距（按优先级排序，2026-08-10 核）。

| 项 | 目标（DESIGN） | 差距 |
|---|---|---|
| client 层数据驱动 UI | §7 分层原则（服务端 mod 逻辑 + 客户端 mod 表现） | ✅ **已打通**：建造菜单遍历 `sim.mods.buildings`、tile 渲染查 `sim.mods.tiles`（未知 id 兜底色不崩）、tile/建筑图标可 `sprite` 声明复用素材、敌人按 enemyId 散列着色；`?mods=url` 运行时加载 ESM mod（demo: src/mods/demo-berry.ts，e2e: scripts/e2e）。剩余：mod 自带上传 SVG 素材管线未做（暂复用内置 sprite） |
| 闭合类型开放 | §7 mod 扩展 | `BehaviorCard.series`/`DesireId` 已开放为 string + `BehaviorCard.desire`(欲望关联)、`satisfies` 已有；新增 `ModRegistry.registerDesire(id,label)`（新欲望维度自动进循环：初始/衰减/匮乏/恶意/满足）；**`BehaviorIntent.action`/`UnitLevel` 已开放为 string**（`registerIntent(id, executor)` 全链路：mod 卡 decide 产出任意 action → 行为系统 Map 分派；`registerUnitLevel(id, capacity)` 新派系等级 + 记忆/看法容量，未知等级回退最小容量）；HUD 欲望显示遍历 DESIRES 表。mod 通路测试：自定义 intent 卡全链路执行 + temple 等级容量 20 |
| 插槽保底 | §6 插槽 | ✅ **已修**：initSlots 保底 3 张基础卡（eat/rest/chop），maxSlots=2+2trait 不再"永久闲逛"（曾实测）；HUD 文案改为「卡池 n 张（槽 m）」 |
| 丢失 chew：出生点/野营 'campfire'、派系掠夺者已数据化 | §7 | 出生建筑已读 `autobuild.starterBuilding`；`scripts.spawnWildCamp` 仍写死 'campfire'（语义上"野生营地=篝火"成立，暂留） |
| 流言/对话完整 | §6 | 微互动已做（模板）；**话题沿社交网络传播已落地**（2026-08-12）：小人记住听到的八卦（`gossip` 字段），TTL 内（`social.gossipTtl` 60s，`gossipChance` 0.7）转述给下一个相遇者，`gossip_spread` 事件可观测，确定性模板（零 LLM）；剩余：闲聊/深聊（引用记忆的 LLM 对话）待 P1 |
| 七宗罪欲望完整 | §3 欲望系统 | ✅ **七途径全通**（2026-08-12）：暴食(进食)/懒惰(休息)/贪婪(工作 satisfies)/暴怒(战斗+恶意槽)/傲慢(祈祷) + **色欲**（正向社交互动，`social.lustFulfillPerInteract`）+ **嫉妒**（存在更强同伴时完成劳动，`desire.envyFulfillPerWork`，skillTotal 标杆） |
| COC 属性全用途 | §3 属性卡 | ✅ **SIZ 负重已落地**（2026-08-12）：采集一次搬回量 = `carryBase + max(0, SIZ-strBase)×carryPerSiz`（tuning.gather，默认 4/0.5），矿洞/采矿/伐木产出统一钳制（保底 1），与 STR 产出加成互补；单测 + 集成测试（`carryCapOf`/`capGainTo`） |
| LLM 层 | §6 | ✅ **已落地**：server `LLM_ENDPOINT` 即启用（OpenAI 兼容），预取+白名单效果+降级（见上表）；剩余：真实 LLM 冒烟（本机无出网 key）、provider 频率分级（付费/免费，DESIGN §10）、LLM 叙述进"历史/记忆"而非仅 feed |
| server 增量优化 | §8 | P2 继续 | ✅ **tick delta 已落地**（500ms 增量 + 5s 对账，见上表）；剩余：实体事件化推送、chunk 按需、插值、兴趣管理、客户端权威提交验证待 P2 联机 |
| mod 打包/沙箱 | §10 待定 | **自包含 .mod.json 包**（manifest+defs 纯 JSON 声明+scripts 函数式）✅：loader 校验/白名单沙箱/幂等挂载（166 测试）；**服务端 mod 管理器** ✅：`mods/*.mod.json` 自动挂载（坏包清晰报错拒服）、`MODS_DIR` 可配、`SimOptions.registry` 预建表；**客户端** ✅：`?mods=*.mod.json` 包或 ESM 源码双通道；CLI：`npm run mod:pack`。剩余：zip 批量/素材打包、联机 mod 同步校验 |
| 联机 | §8 | P2：WSS 协议、多客户端同步、兴趣管理、持久化、鉴权 | ✅ 命令权威校验已提前（见上表）：形状/范围/pawnId/频率把关 + e2e 断言；剩余：多客户端、兴趣管理、持久化、鉴权 |

## 技术栈

- Vite + TypeScript + PixiJS v8 + bitecs ECS（SoA）+ vitest
- sim = 纯 TS 双端共用（`src/sim/` 零 DOM/PIXI），P1 起 server 直接 import
- 确定性：SimRng（种子化）+ 固定系统顺序 + 独立 world chunk 生成

## 存档注意

- IndexedDB 库名 `infcanvas-db`，store `saves`，key `autosave`
- 旧 localStorage `infcanvas-save*` 已不再读写（版本切换，旧存档作废）
| 兴趣驱动娱乐 | §6 娱乐 | ✅ **已落地**（2026-08-13）：娱乐从固定小卡池（闲逛/探索）改为**开放活动空间**——做什么由 pawn **兴趣属性**决定。起因：试玩发现 toy 被反复建 39 次吃光木头（toy:39/well:2/house:1）；先试「buildMinWood 游牧期门槛」拦截全部科技建造被用户否决（治标），改为兴趣属性治本。每人随机 1-3 个兴趣（`defs/interests.ts` 表驱动，gather/mine/fish/build/pray/wander/rest），兴趣带专属休闲卡进卡槽（initSlots）；带 `interest` 标记的卡（探索卡标 `build`）由 `ruleInterest` 按有无该兴趣调制权重（有兴趣 ×weightMul / 无兴趣 ÷weightMul）。效果：toy 建造 39→4 次，house 2、well 5，终局木 392（不再枯竭）。`techBuildChance` 同门控（无 build 兴趣不主动建科技建筑）。mod 可 `registerInterest`（或 `.mod.json` defs 声明 `interests`）扩展 |
| 玩家不参与模拟循环 | §5 权威模型 | ✅ **架构裁决落地**（2026-08-13）：**删除"玩家单位"实体**——模拟循环里只有自主派系，玩家不存在于循环中，只有通过**卡片**（神谕降旨/策略卡/printCard）与**指令**（issueCommand）干预。删除 `playerUnitId` 字段/`checkPossession` 团灭附身/`allocateResources` 玩家镜像/贸易 isPlayer 特判；全局仓库 `stockpile` 即玩家资源池（`faction='player'` 建筑产出直接进全局），各派系按成员数自给独立库存。相关测试改写（生产归集语义、筏上渔获确定性驱动），225 全过 |
| 篝火 = 区域历史载体（B 方案） | §930 派系涌现 | ✅ **落地**（2026-08-14）：用户设计「每个人保存一个篝火，在篝火周围生存；不舒适可另起篝火；篝火记载区域生活/历史；同 chunk 相近才可交流篝火情况；pawn 据此判断伙伴/敌人；记得个体间社会关系」。实现：`pawn.fireId`（归属篝火）+ `pawn.knownFires`（对听说的篝火的 stance/basis/at）；篝火 history = 区域事件（建筑/袭击/摧毁/战死，bus 订阅写入）；`exchangeFireStory` 交流（同 chunk 相遇、冷却防刷屏）→ 从历史关键词推断 enemy/friend；`migrateIfUncomfortable` 另起篝火（遭袭计数 raidCount ≥ 阈值才迁，防连锁分裂——首版仅凭"敌人近"致 15 空壳派系，改按篝火遭袭计数）。测试 +4，229 全过 |
| 派系碎片化治理 + 归属持续收敛 | B 方案连锁雪崩修复 | ✅ **落地**（2026-08-14，试玩暴露）：① **migrate 判据三修**——首版"敌人近"迁 → 狼驱散文明（12 次/15 空壳）；二版"狼在场计数" → 狼扫过一遍 raidCount 疯涨（90 分钟 40 次另起、41 单位 34 空壳）；终版**仅真实建筑被毁（💥 入史）才计数**，狼路过不算（可战斗/逃跑），新篝火落点远离旧营地 ≥migrateMinDist 防连锁再迁 → 收敛至 4 单位。② **归属持续收敛**——归属原只在"建 campfire/出生/迁徙"瞬间算，小人走到营地旁不重算 → 大量"人在营地旁却无火"游牧幽灵；加低频全量 reassign（20s）自然划入。③ **营地被毁清 fireId**——只删 membership 没清 fireId → 幽灵归属；修复。④ 测试 +2（营地被毁清火 / migrate 真实损失判据），230 全过 |
| 删派系实体层：派系 = 纯涌现展示 | 用户 2026-08-14 裁决「不要派系系统，派系单纯用涌现展示」 | ✅ **落地**：删除 SocialUnit 类型/units/membership/单位私有库存/单位间贸易战争传话/征服/单位命名升级/faction_event。保留并迁移涌现层：`pawn.fireId` 改指向 **campfire 建筑 key**；区域历史 memory 挂到 **campfire 建筑**（world.fireMemory）；`factionsView()` 运行时按 fireId 聚合（纯只读展示，无库存/贸易/战争）；另起篝火 migrate 纯建筑级。HUD 派系面板改为篝火聚居展示。测试删除派系实体用例、B 方案测试改造为涌现版。218 全过 |
| 私有食物 + 互助卡 + 需求入篝火史 | 用户 2026-08-14 设计「好感高→帮忙=满足食物娱乐；私有物品；篝火记载需求」 | ✅ **落地**（仅食物私有化，克制范围）：① `pawn.inventory` 私有食物——主动采集（矿洞/渔获）食入口袋，进食优先扣个人、无则公共粮仓兜底；木材/矿石仍全局。② **互助卡**（base 卡常驻槽位，weight 12）：附近有"缺食/受伤/低落"且我好感 ≥ helpFriendAt 的邻人，且自身稳定时可选；execHelp 送食（口袋转移）/疗伤/陪伴，受助方好感提升（互惠）。③ **需求写篝火历史**：濒死/低落小人的需求记入附近 campfire 记忆，经交流传播。测试 +4（私有食物入袋/进食优先个人/互助闭环/需求入史），222 全过。落井下石（敌视者不援手/破坏）按用户指示暂不做 |
| 世界观修正：野狼 → 野猫 | 用户指出「背景设定是鼠鼠和猫」，狼是早期幻觉设定 | ✅ 落地（2026-08-14）：enemies 表 wolf→cat（野猫），raidEnemy/catSpeed/catLoot、raidSystem 日志、篝火记忆文案、渲染 tint、HUD 文案、注释全部替换；测试同步。docs 旧行按铁律保留并追加更正段 |
