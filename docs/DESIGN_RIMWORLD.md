# InfCanvas (RimWorld Standard Edition) — Master Design Document

## 1. Design Philosophy: Zero-Learning-Curve RimWorld Experience
Players are assumed to be familiar with **RimWorld** and should never have to learn an unfamiliar custom UI or abstract card-drawing system:
- **100% RimWorld Art Style**: Top-down orthographic colonist silhouettes (head, torso, Ratkin ears/tail, drafted weapons), earthy muted terrain palette, mineral veins embedded in rock strata, thick-walled buildings with interior floors, selection brackets, and floating status bars.
- **100% RimWorld UI & Controls**:
  - **Top-Center Colonist Bar**: Portrait boxes with mood background fill, health bar, drafted crossed-swords badge (`⚔`), click to select, double-click to center camera.
  - **Top-Left Categorized Resource Readout**: Collapsible categories (`Food`, `Raw Materials`, `Minerals & Metals`, `Manufactured & Medicine`).
  - **Bottom-Left Inspect Pane**: Beveled dark-slate panel with pop-up tabs (`Bio`, `Genes`, `Skills (≤3)`, `Needs`, `Health`, `Gear`).
  - **Bottom-Center Command Gizmos**: `68×68` square command buttons (`R` Draft, `1/2/3` Tactical Skills, `F` Fire/Attack, `⛏` Mine, `X` Deconstruct).
  - **Bottom Main Tab Bar**: `Architect (建造规划)`, `Work (工作 1-4)`, `Schedule (日程)`, `Biotech (鼠鼠基因)`, `World/Bases (野生据点)`, `Raid/PvP (多人袭击)`, `Research (研究树)`, `DLC/Mods (DLC入口)`, `Menu (系统)`.
  - **Bottom-Right Clock, Weather & Tile Readout**: `⏸ / 1x / 2x / 3x`, Date/Quadrum, Temp `°C`, Weather, and mouse hover tile/elevation/mineral inspector.
  - **Right-Side Alerts & Letters**: Critical colony alerts + color-coded clickable envelope notifications.

## 2. Retained Core (`infcanvas`)
- **Infinite Deterministic World (`world.ts`)**: Seed-based fractal elevation `z ∈ [0..4]`, moisture-driven 2×2 forests, lakes, rock strata, and mineral veins (`steel_ore`, `gold_ore`, `jade_ore`, `stone_chunk`, `herb_plant`, `berry`, `tree`).
- **Chunk Spatial Indexing & Delta Sync (`chunk-index.ts`, `game-server.ts`)**: `64×64` chunk partitioning, interest-scoped WebSocket synchronization (`scope` + `droppedChunks`).
- **Archived Legacy Systems**: Legacy gacha/card-draw (`cards.ts`, `tech-pool.ts`) and legacy docs are archived in `archive/cards/` and `archive/docs/`.
