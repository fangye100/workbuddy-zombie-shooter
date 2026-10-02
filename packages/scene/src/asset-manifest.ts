/**
 * 资产清单（assets/_data/asset-manifest.json）—— LOD 家族的唯一领域逻辑。
 *
 * 2026-09-23 从编辑器 main.ts 的内联实现上提（用户要求：功能迁移之外更要
 * **代码复用**——同一份 manifest 解析/家族归组逻辑只留一份，编辑器与
 * assets/asset-browser.html 之外的任何消费方都从这里取）。
 *
 * 数据形状（真源 = assets/_data/asset-manifest.json，由资产管线产出）：
 *   { characters: AssetManifestEntry[], environments: AssetManifestEntry[] }
 *   entry.lods[] = { label, file, tris?, verts?, bytes? }
 *
 * 约定与坑：
 *   - manifest 的 `file` 相对 **assets/**（asset-browser.html 也住在 assets/ 里，
 *     它的相对路径因此成立）；编辑器的资产路径带 `assets/` 前缀。
 *     `normalizeManifestPath` 统一补前缀，两种写法归一成项目根相对路径。
 *   - 解析**不抛异常**：清单是外部数据，坏条目跳过并计入 diagnostics
 *     （与项目其余加载器的「降级不丢信息」约定一致）。
 */

/** 一档 LOD（label 展示用；tris/verts/bytes 供对比 HUD，可能缺省） */
export interface AssetLod {
  label: string;
  /** 项目根相对路径（已归一化带 assets/ 前缀） */
  path: string;
  tris?: number;
  verts?: number;
  bytes?: number;
}

/** 同一资产的全部 LOD 档（保持 manifest 顺序，LOD0 在前） */
export type LodFamily = AssetLod[];

/** 资产清单条目（只取本库关心的字段，其余忽略） */
interface AssetManifestEntryLike {
  lods?: unknown;
}

export interface AssetManifestParseResult {
  /** 项目根相对路径 → LOD 家族。家族内每一档都指向同一个数组（查任一档即得全家） */
  families: Map<string, LodFamily>;
  /** 被跳过的坏条目计数（诊断用；不影响可用条目） */
  skipped: number;
}

/** `file` 字段归一化：相对 assets/ 的写法补上 assets/ 前缀；两种写法等价 */
export function normalizeManifestPath(file: string): string {
  const posix = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return posix.startsWith('assets/') ? posix : `assets/${posix}`;
}

/**
 * 解析资产清单 JSON（未知形状也安全）。
 * 同一家族的每一档都会登记进 families（键为归一化路径），查任一档即得全家。
 */
export function parseAssetManifest(json: unknown): AssetManifestParseResult {
  const families = new Map<string, LodFamily>();
  let skipped = 0;
  if (json === null || typeof json !== 'object') return { families, skipped };

  for (const section of ['characters', 'environments']) {
    const list = (json as Record<string, unknown>)[section];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (e === null || typeof e !== 'object') {
        skipped++;
        continue;
      }
      const lods = (e as AssetManifestEntryLike).lods;
      if (!Array.isArray(lods)) {
        skipped++;
        continue;
      }
      const family: AssetLod[] = [];
      for (const l of lods) {
        if (l === null || typeof l !== 'object') {
          skipped++;
          continue;
        }
        const rec = l as Record<string, unknown>;
        const file = typeof rec.file === 'string' ? rec.file : '';
        if (file === '') {
          skipped++;
          continue;
        }
        const lod: AssetLod = {
          label: typeof rec.label === 'string' && rec.label !== '' ? rec.label : 'LOD',
          path: normalizeManifestPath(file),
        };
        if (typeof rec.tris === 'number') lod.tris = rec.tris;
        if (typeof rec.verts === 'number') lod.verts = rec.verts;
        if (typeof rec.bytes === 'number') lod.bytes = rec.bytes;
        family.push(lod);
      }
      if (family.length === 0) {
        skipped++;
        continue;
      }
      for (const l of family) {
        // 后写覆盖先写：同一文件出现在多个家族时以最后一处为准（清单本身不该这样）
        families.set(l.path, family);
      }
    }
  }
  return { families, skipped };
}

/** 相对 LOD0 的降幅（返回百分数字符串；基准缺失或就是 LOD0 返回 null） */
export function lodDeltaVsLod0(family: LodFamily, path: string, key: 'tris' | 'verts' | 'bytes'): string | null {
  const idx = family.findIndex((l) => l.path === path);
  const base = family[0]?.[key];
  const cur = family[idx]?.[key];
  if (idx <= 0 || base === undefined || cur === undefined || base === 0) return null;
  const pct = Math.round(((cur - base) / base) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** 预览统计行：`79744 tris · 54414 verts` + （非 LOD0 时）`面数 −96%` 式降幅 */
export function formatLodStats(family: LodFamily, path: string): string {
  const lod = family.find((l) => l.path === path);
  if (lod === undefined) return '';
  const parts: string[] = [];
  if (lod.tris !== undefined) parts.push(`${lod.tris.toLocaleString('en-US')} tris`);
  if (lod.verts !== undefined) parts.push(`${lod.verts.toLocaleString('en-US')} verts`);
  const d = lodDeltaVsLod0(family, path, 'tris');
  if (d !== null) parts.push(`Δ${d}`);
  return parts.join(' · ');
}
