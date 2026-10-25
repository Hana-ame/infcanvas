# Infinite Canvas (`infcanvas`) Pathfinding Architecture

## 1. Problem Statement on an Unbounded Map
Unlike traditional RimWorld (which operates on a fixed `250×250` array where regions can be pre-baked at map load), `infcanvas` operates on an **unbounded coordinate space** $(x, y) \in (-\infty, +\infty)$ where terrain and elevation $z(x,y) \in [0, 4]$ are derived deterministically via spatial hashing (`hash2`), and buildings/features mutate dynamically.

A naive single-tier A* fails on an infinite map for three reasons:
1. **Unbounded Open Set Growth**: When a target is behind a wide lake or cliff, A* explores $O(D^2)$ tiles before failing or exhausting `maxIter`.
2. **Dynamic Obstacle Invalidation**: Rebuilding a global navigation mesh on every wall placement is impossible on an infinite plane.
3. **Mass Raid Stampede**: When a Raid Commander spawns 20+ raiders targeting a colony, running 20 independent long-range A* searches causes severe frame spikes.

---

## 2. Three-Tier Hierarchical Solution (`src/sim/hpa-infinite.ts`)

### Tier 1 — Micro Octile A* (`Manhattan Dist <= 32` tiles)
- **Algorithm**: Binary MinHeap 8-directional A* (`findPath`) with admissible octile heuristic:
  $$h(\Delta x, \Delta y) = \max(\Delta x, \Delta y) + (\sqrt{2} - 1)\min(\Delta x, \Delta y)$$
- **Strict Invariants**:
  - **Integer Grid Quantization**: Start and goal coordinates are rounded to integer tile centers before key encoding.
  - **Corner-Cutting Prevention (`斜角禁切`)**: Diagonal step $(x,y) \to (x+dx, y+dy)$ is permitted if and only if both cardinal neighbors $(x+dx, y)$ and $(x, y+dy)$ are step-valid.
  - **Per-Edge Elevation Gate**: Step validity checks $|z(tx, ty) - z(fx, fy)| \le \text{pawn.climb}$ plus uphill/downhill cost weighting.
  - **Collinear Path Simplification (`simplifyPath`)**: Removes redundant intermediate collinear nodes via cross-product check, cutting path array memory by ~60%.

### Tier 2 — Chunk-Portal HPA* + Waypoint Graph (`32 < Dist <= 512` tiles)
- **Chunk Partitioning**: The infinite plane is divided into `CHUNK_SIZE = 64×64` chunks indexed by `tileChunkKey(x, y)`.
- **Lazy Border Portal Extraction**:
  - When a chunk $(cx, cy)$ is touched by a cross-chunk query, its 4 borders (North $y=y_0$, South $y=y_0+63$, West $x=x_0$, East $x=x_0+63$) are scanned for maximal contiguous walkable segments.
  - Up to 2 representative **Portal Nodes** per border edge are created and connected to adjacent chunk portals where $|\Delta z| \le \text{climb}$.
- **Intra-Chunk Portal Cache & O(1) Dirty Chunk Invalidation**:
  - Shortest paths and costs between portals within chunk $(cx, cy)$ are cached per `(chunkKey, climb, chunkVersion)`.
  - When a building is placed or destroyed at $(x, y)$, **only** `tileChunkKey(x, y)` increments its version (`invalidateChunk(ck)`), leaving 99% of other chunks' cached portal graphs untouched!
- **Waypoint Beacon Fusion**:
  - Campfires (`fire`), Watchtowers (`waypoint`), and NPC Outpost Beacons act as express high-level highway nodes (`RoutePlanner`), seamlessly bridging explored chunks.

### Tier 3 — Multi-Unit Raid Flow Field & Macro Corridor Stepping (`Dist > 512` tiles or Squads)
- **Raid Flow Field (`FlowFieldPlanner`)**:
  - When $\ge 4$ units (e.g., a Player Raid wave or drafted colonist squad) move toward the same target $(tx, ty)$, a bounded Dijkstra integration field is computed once over the local window and shared across all units in $O(1)$ lookup per unit!
- **Macro-Chunk Corridor Stepping (`Dist > 512` tiles)**:
  - Decomposes ultra-long cross-biome treks (e.g., $1,000+$ tiles across negative and positive coordinates) into `56`-tile corridor checkpoints snapped to the nearest passable elevation-compatible tile, with LRU + `:F` negative-result cache eviction.
