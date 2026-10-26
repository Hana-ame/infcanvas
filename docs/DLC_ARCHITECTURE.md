# Official DLC Entry & Mod Architecture

## 1. Built-in Official DLC Packs (`DLC_PACKS`)
1. **`dlc-biotech-ratkin` (Biotech: 鼠鼠基因工程与血脉)**:
   - Unlocks Gene Splicing Lab, Xenotype Mutagens, Hereditary DNA mixing (`mixGenes`), and Royal Ratkin Vanguard xenotype.
2. **`dlc-raider-pvp` (Multiplayer Raid Commander / 玩家袭击争霸)**:
   - Unlocks Asymmetric PvP Raid Director, Siege Breachers, and Hostile Outpost Mercenary Conscription.
3. **`dlc-royalty-empire` (Royalty: 鼠国皇权与灵能)**:
   - Unlocks Royal Honor Titles, Golden Throne, and Psycast active skills.
4. **`dlc-ideology-cult` (Ideology: 地穴信条与祭坛)**:
   - Unlocks Burrow Tenets, Mood Rituals, and Totem Shrines.

## 2. UI & Programmatic Entry Points
- **In-Game UI**: Click **📦 DLC / 模组** in the bottom RimWorld main tab bar (or the top-right DLC badge) to open the RimWorld Expansion & Mod Manager, toggle DLCs live, or load custom `.mod.json` definitions.
- **Code API**: `ModRegistry.default({ dlc: ['dlc-biotech-ratkin', 'dlc-raider-pvp'] })` and `sim.hasDlc(id)`.
