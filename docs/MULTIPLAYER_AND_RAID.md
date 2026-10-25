# Multiplayer PvP/Co-op, Player-Controlled Raids & Wild NPC Bases

## 1. Player-Controlled Raids (`Raid 等由玩家扮演`)
Players can switch between **Colony Commander (防守/建设方)** and **Raid Commander (袭击扮演方)** at any time (or across separate WebSocket connections in online multiplayer):
- **Threat Points Economy**: Raid Commanders accumulate Threat Points (`raidPoints`) over time and scaled by colony wealth.
- **Raider Unit Roster**:
  - `raider_rat_scout` (疾风鼠斥候 — 15 pt): High-speed harasser.
  - `raider_sapper` (爆破掘地鼠 — 25 pt): Prioritizes breaching walls and defensive structures.
  - `raider_shield` (重甲鼠卫 — 35 pt): High-HP frontline tank.
  - `raider_sniper` (远程弩手鼠 — 30 pt): Long-range marksman.
  - `raider_boss` (赤爪督军 — 60 pt): Elite commander with 3 skills and squad buff aura.
- **Tactical Raider Orders**: Spawn at North/East/South/West perimeter or from a Hostile NPC Base, and command raiders with `march` (推进到坐标), `focus_target` (集火目标), `breach_walls` (破墙突袭), or `retreat` (战术撤退).

## 2. Wild NPC Bases (`friendly` & `hostile`)
Generated deterministically on the infinite canvas (`src/sim/npc-bases.ts`):
- **Friendly Outposts (`attitude: 'friendly'`)**:
  - *橡果鼠鼠集市 (Acorn Ratkin Bazaar)* & *白桦林盟友据点 (Birchvale Sanctuary)*
  - Supports **Resource Trading** (`Wood/Ore/Gold ↔ Meals/Herbs/Components`), **Gifting** (`+Reputation`), and **Allied Reinforcement Dispatch** (spawns friendly guards to help defend your colony against raids).
- **Hostile Outposts (`attitude: 'hostile'`)**:
  - *赤爪掠夺者营地 (Redclaw Marauder Camp)* & *锈牙海盗堡垒 (Rustfang Pirate Stronghold)*
  - Guarded by hostile defenders and turrets; periodically stages raids if left unchecked. Players can draft colonists to **Assault & Capture** hostile bases for large resource rewards (`Gold`, `Steel Ore`, `Meals`, `Herbal Medicine`).
