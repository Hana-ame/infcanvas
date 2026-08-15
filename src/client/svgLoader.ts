// SVG 素材加载器 —— 把内联 SVG 解析成 Pixi GraphicsContext（可共享、任意缩放清晰）
import { Assets } from 'pixi.js';
import { TERRAIN_SVG, BUILDING_SVG, PAWN_SVG, HOSTILE_SVG, svgDataUri } from './svgAssets';

export type AssetId =
  | 'terrain:tree' | 'terrain:ore' | 'terrain:water' | 'terrain:stone'
  | 'building:campfire' | 'building:wall' | 'building:floor' | 'building:door' | 'building:farm' | 'building:workbench' | 'building:cave' | 'building:church' | 'building:monument'
  | 'pawn:mouse' | 'pawn:strong' | 'pawn:devout' | 'pawn:lazy' | 'pawn:workaholic' | 'pawn:owl'
  | 'hostile:cat' | 'hostile:generic';

export class SvgAssets {
  private textures = new Map<string, any>();

  async loadAll(): Promise<void> {
    const entries: { id: AssetId; svg: string }[] = [
      ...Object.entries(TERRAIN_SVG).map(([k, v]) => ({ id: `terrain:${k}` as AssetId, svg: v })),
      ...Object.entries(BUILDING_SVG).map(([k, v]) => ({ id: `building:${k}` as AssetId, svg: v })),
      ...Object.entries(PAWN_SVG).map(([k, v]) => ({ id: `pawn:${k}` as AssetId, svg: v })),
      ...Object.entries(HOSTILE_SVG).map(([k, v]) => ({ id: `hostile:${k}` as AssetId, svg: v })),
    ];
    await Promise.all(entries.map(async (e) => {
      try {
        const ctx = await Assets.load({
          src: svgDataUri(e.svg),
          // parseAsGraphicsContext：SVG 直接解析为可共享的 GraphicsContext（任意缩放矢量清晰，非位图）
          data: { parseAsGraphicsContext: true },
        });
        this.textures.set(e.id, ctx);
      } catch {
        this.textures.set(e.id, null);
      }
    }));
  }

  get(id: string): any | null {
    return this.textures.get(id) ?? null;
  }
}
