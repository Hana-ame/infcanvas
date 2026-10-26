# Xenotypes (Ratkin / 鼠鼠), Biotech Genes & Strict 3-Skill Pawn System

## 1. Strict 3-Skill Cap per Pawn (`MAX_PAWN_SKILLS = 3`)
Per acceptance criteria (**"pawn技能最多3个"**):
- Every Pawn's `skills` array is strictly bounded to at most **3 skills** (`pawn.skills.length <= 3`).
- Attempting to assign or deserialize more than 3 skills automatically clamps/rejects excess entries via `enforceMaxThreeSkills()`.
- Each skill slot contains:
  - `id`: `'mining_construct' | 'combat_shoot' | 'combat_melee' | 'plants_cook' | 'medical_social' | 'research_craft'`
  - `name`: Display name (e.g., `掘地筑造`, `精准射击`, `疾风近战`, `农艺烹饪`, `战地医疗`, `科研巧工`)
  - `level`: `0..20` (RimWorld standard 0–20 skill scale)
  - `passion`: `0` (None), `1` (🔥 Minor Passion, 100% XP), `2` (🔥🔥 Burning Passion, 150% XP)
  - `activeName` & `cooldown`: Tactical active ability triggered via bottom-center Gizmos (`1`, `2`, `3` hotkeys).

## 2. Xenotypes / Races (`xenotype`)
1. **`ratkin` (鼠鼠族 / Ratkin Colonist)**:
   - Signature rounded rat ears & long tail silhouette, `+15%` move speed, `+25%` mining/foraging efficiency, natural burrow affinity.
2. **`ratkin_vanguard` (鼠鼠皇家卫队 / Ratkin Vanguard)**:
   - Armored ear-tufts & cloak, `+20%` max HP, `+25%` melee & defense power.
3. **`baseliner` (标准人类 / Baseline Colonist)**:
   - Balanced all-around stats and fast research/social adaptation.
4. **`feral_marauder` (荒野掠夺鼠 / Feral Marauder)**:
   - Hostile raider race with high aggression, climbing `+1`, and nocturnal raid bonus.

## 3. Biotech Genes (`genes`)
- `gene_rat_ears` (鼠耳灵觉): Sense radius `+25%`, dodge `+10%`.
- `gene_tunnel_claws` (掘地利爪): Mining & construction speed `+35%`, climb `+1`.
- `gene_night_vision` (夜视微光): Zero darkness penalty at night.
- `gene_iron_fur` (钢毛皮甲): Incoming physical damage `-20%`.
- `gene_fast_metabolism` (高速代谢): Move speed `+20%`, hunger rate `+10%`.
- `gene_herb_immunity` (百草抗性): Healing efficiency `+30%`, plague immunity.
