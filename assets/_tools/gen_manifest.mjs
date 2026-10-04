#!/usr/bin/env node
/**
 * 资产浏览器 manifest 生成器：扫描 assets/ 产出 _data/asset-manifest.json。
 *
 * 数据一律从真源读（roster.json / props.json），磁盘只补充"文件是否在"。
 * 浏览器页（asset-browser.html）fetch manifest 渲染，不重复维护清单。
 *
 * LOD/动画/骨骼的判定（按钮显隐的依据）：
 *   角色 lods = [textured/*_baked.glb（贴图低模）, rigged/*_rigged.glb（+骨骼）,
 *                rigged/*_rigged_animated.glb（+动画）]
 *   环境 lods = [<ID>.glb（raw 高模）, <ID>_low.obj（低模）]
 *   animations = 解析 glb JSON chunk 的 animations[].name
 *   skeleton   = skins[0].joints.length > 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..');

/** 读 GLB 的 JSON chunk，拿动画名/骨骼数/实测三角数（不加载网格，只读 accessor 计数） */
function glbInfo(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'
    const jsonLen = buf.readUInt32LE(12);
    const js = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
    // 实测面数/顶点数：indices.count/3 + POSITION.count（多 primitive 累加，跳过点/线模式）
    let tris = 0, verts = 0;
    for (const m of js.meshes ?? []) {
      for (const p of m.primitives ?? []) {
        const mode = p.mode ?? 4;
        if (mode !== 4) continue;
        const pos = js.accessors?.[p.attributes?.POSITION];
        if (pos) verts += pos.count ?? 0;
        if (p.indices != null) {
          const ia = js.accessors?.[p.indices];
          if (ia) tris += Math.floor((ia.count ?? 0) / 3);
        } else if (pos) {
          tris += Math.floor((pos.count ?? 0) / 3);
        }
      }
    }
    return {
      animations: (js.animations ?? []).map((a) => a.name ?? 'clip'),
      joints: js.skins?.[0]?.joints?.length ?? 0,
      tris, verts,
      bytes: buf.length,
      // 贴图尺寸（只取第一张图所在的 bufferView 长度做粗略信号；精确尺寸留浏览器端）
      images: (js.images ?? []).length,
    };
  } catch {
    return null;
  }
}

function firstExists(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return n;
  }
  return null;
}

const out = { characters: [], environments: [] };

// LOD 质量/算法溯源数据（由 assets/environment/_tools/audit_lod_quality.py 生成）。
// 缺文件不阻塞 —— 页面只是少个标记，数据仍能正常索引。
const LOD_QUALITY_PATH = path.join(ASSETS, '_data/lod-quality.json');
const LOD_QUALITY = fs.existsSync(LOD_QUALITY_PATH)
  ? JSON.parse(fs.readFileSync(LOD_QUALITY_PATH, 'utf8'))
  : { environments: {} };
if (!fs.existsSync(LOD_QUALITY_PATH)) {
  console.warn('[warn] _data/lod-quality.json 不存在 → 环境 LOD 不显示算法标记'
    + '（生成：python assets/environment/_tools/audit_lod_quality.py）');
}

// ---------------- 角色 ----------------
const roster = JSON.parse(fs.readFileSync(path.join(ASSETS, 'characters/roster.json'), 'utf8'));
// 🔴 数组顺序即浏览器页展示顺序：主人公排最前。
// kind 由所属列表决定，不用「bosses.includes(c)」反查 —— 每加一个分组都要改判定式，必漏。
const chars = [
  { list: roster.protagonists ?? [], kind: 'player' },
  { list: roster.npcs ?? [], kind: 'npc' },
  { list: roster.bosses ?? [], kind: 'boss' },
].flatMap(({ list, kind }) => list.map((c) => ({ c, kind })));
for (const { c, kind } of chars) {
  const base = `characters/models/${c.id}`;
  const dir = path.join(ASSETS, 'characters/models', c.id);
  const dirExists = fs.existsSync(dir);
  const riggedDir = path.join(dir, 'rigged');
  const texturedDir = path.join(dir, 'textured');

  const baked = firstExists(texturedDir, fs.existsSync(texturedDir)
    ? fs.readdirSync(texturedDir).filter((f) => f.endsWith('_baked.glb')) : []);
  const riggedOnly = fs.existsSync(riggedDir)
    ? firstExists(riggedDir, fs.readdirSync(riggedDir).filter((f) => /_rigged\.glb$/.test(f))) : null;
  const animated = fs.existsSync(riggedDir)
    ? firstExists(riggedDir, fs.readdirSync(riggedDir).filter((f) => f.endsWith('_rigged_animated.glb'))) : null;

  // 动画/骨骼信息从 animated（最全）读，退回 rigged
  const infoSrc = animated ?? riggedOnly;
  const info = infoSrc ? glbInfo(path.join(riggedDir, infoSrc)) : null;

  // 常规三视图 + 可选的 T-pose 绑定参考（tpose/front、tpose/side 二级目录）。
  // key 即 manifest 里的视图名，浏览器页按它取中文标签。
  const VIEW_DIRS = {
    front: 'front', side: 'side', attack: 'attack',
    tposeFront: 'tpose/front', tposeSide: 'tpose/side',
  };
  const views = {};
  for (const [key, sub] of Object.entries(VIEW_DIRS)) {
    const imgDir = path.join(ASSETS, 'characters/images', c.id, sub);
    if (fs.existsSync(imgDir)) {
      const f = fs.readdirSync(imgDir).find((x) => x.endsWith('.png'));
      if (f) views[key] = `characters/images/${c.id}/${sub}/${f}`;
    }
  }

  const lods = [];
  // 🔴 LOD0 = 混元原生高模（原生 4096² baseColor 贴图，真源）。
  // 旧 LOD0（textured/*_baked.glb）是「原贴图→顶点色→逐面平涂」的有损中间产物，不是原生模型。
  // 🔴 每档的 tris/verts/bytes 一律**实测**（读 glb accessor），不用 roster 的预算值——
  //    预算值（如 E-01 的 900）与实际产出（现在 3000）早已脱节，拿它做 LOD 对比会误导。
  // 🔴 主人公目前只有 2D 概念图、没有 GLB —— 目录不存在时 readdirSync 会直接抛，
  //    整个 manifest 就生成不出来。缺模型是合法状态（浏览器页按「仅 2D」渲染）。
  const rawGlb = dirExists
    ? fs.readdirSync(dir).find((f) => new RegExp(`^${c.id.replace(/-/g, '')}_\\d{8}_\\d{6}\\.glb$`).test(f)) ?? null
    : null;
  const mk = (label, file, abs) => {
    const inf = glbInfo(abs);
    return { label, file, tris: inf?.tris ?? c.tris, verts: inf?.verts ?? null,
             bytes: inf?.bytes ?? null };
  };
  if (rawGlb) lods.push(mk('LOD0 · 原生高模(混元raw ~80k面)', `${base}/${rawGlb}`, path.join(dir, rawGlb)));
  if (baked) lods.push(mk('LOD1 · 贴图低模', `${base}/textured/${baked}`, path.join(texturedDir, baked)));
  if (riggedOnly) lods.push(mk('LOD2 · +骨骼', `${base}/rigged/${riggedOnly}`, path.join(riggedDir, riggedOnly)));
  if (animated) lods.push(mk('LOD3 · +动画', `${base}/rigged/${animated}`, path.join(riggedDir, animated)));

  out.characters.push({
    id: c.id, name: c.name, en: c.en ?? '', kind,
    threat: c.threat ?? '', role: c.role ?? '', height: c.height, tris: c.tris,
    silhouette: c.silhouette ?? '', look: c.look ?? '', accent: c.accent ?? '',
    hp: c.hp, speed: c.speed, attack: c.attack, weakness: c.weakness,
    views, lods,
    animations: info?.animations ?? [],
    joints: info?.joints ?? 0,
  });
}

// ---------------- 环境 ----------------
const props = JSON.parse(fs.readFileSync(path.join(ASSETS, 'environment/props.json'), 'utf8'));
const actName = Object.fromEntries(props.acts.map((a) => [a.act, a.name]));
for (const e of props.entries) {
  const base = `environment/models/${e.id}`;
  const dir = path.join(ASSETS, 'environment/models', e.id);
  const raw = fs.existsSync(path.join(dir, `${e.id}.glb`)) ? `${base}/${e.id}.glb` : null;
  const low = fs.existsSync(path.join(dir, `${e.id}_low.obj`)) ? `${base}/${e.id}_low.obj` : null;
  const img = fs.existsSync(path.join(ASSETS, 'environment/images', `${e.id}.png`))
    ? `environment/images/${e.id}.png` : null;
  const preview = fs.existsSync(path.join(dir, 'preview.png')) ? `${base}/preview.png` : null;

  const lods = [];
  const mkE = (label, file, abs) => {
    const inf = fs.existsSync(abs) ? glbInfo(abs) : null;
    return { label, file, tris: inf?.tris ?? e.tris, verts: inf?.verts ?? null,
             bytes: inf?.bytes ?? (fs.existsSync(abs) ? fs.statSync(abs).size : null) };
  };
  const metaPath = path.join(dir, 'tex2', `${e.id}_baked.glb.meta.json`);
  const build = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8')).userData?.lodBuildResult : null;
  if (raw) lods.push(mkE('LOD0 · 高模(raw ~50万面)', raw, path.join(dir, `${e.id}.glb`)));
  if (raw && build) lods[0].placementMatrix = build.sourcePlacementMatrix;
  // Prefer the authored, UV-preserving GLBs; retain fallback for legacy assets.
  const tex2 = fs.existsSync(path.join(dir, 'tex2'))
    ? fs.readdirSync(path.join(dir, 'tex2')).filter((f) => f.endsWith('_baked.glb')) : [];
  const texGlbs = fs.existsSync(path.join(dir, 'tex'))
    ? fs.readdirSync(path.join(dir, 'tex')).filter((f) => f.endsWith('_baked.glb')) : [];
  if (tex2.length) {
    lods.push(mkE('LOD1 · 低模+原贴图', `${base}/tex2/${tex2[0]}`, path.join(dir, 'tex2', tex2[0])));
  } else if (texGlbs.length) {
    lods.push(mkE('LOD1 · 低模+贴图', `${base}/tex/${texGlbs[0]}`, path.join(dir, 'tex', texGlbs[0])));
  }
  const lod2 = `${e.id}_lod2.glb`;
  if (fs.existsSync(path.join(dir, 'tex2', lod2))) {
    lods.push(mkE('LOD2 · 远景低模+原贴图', `${base}/tex2/${lod2}`, path.join(dir, 'tex2', lod2)));
  } else if (low) lods.push({ label: 'LOD2 · 低模(顶点色)', file: low, tris: e.tris, verts: null, bytes: null });

  // Provenance and measured stats are owned by audit_lod_quality.py.
  const lq = LOD_QUALITY.environments?.[e.id] ?? null;
  const lod1Alg = lq?.alg ?? null;
  const lod1Colorful = lq?.colorful ?? null;

  out.environments.push({
    id: e.id, name: e.name, en: e.en ?? '', kind: e.kind,
    act: e.acts?.length === 1 ? actName[e.acts[0]] : '通用',
    footprint: e.footprint, tris: e.tris,
    cover: e.cover ?? '', blocksSight: e.blocksSight, blocksMove: e.blocksMove,
    destructible: e.destructible ?? null,
    silhouette: e.silhouette ?? '', look: e.look ?? '', accent: e.accent ?? '',
    placement: e.placement ?? '',
    img, preview, lods,
    lod1Alg,
    lod1Colorful,                       // LOD1 贴图彩色占比实测值（浏览器端可复核）
    lod2Alg: lq?.lod2?.alg ?? null,
    placementReady: build?.levels?.length === 2 && build.levels.every((level) =>
      level.failures?.length === 0 && level.visualReview?.status === 'reviewed'),
    animations: [], joints: 0,
  });
}

const outDir = path.join(ASSETS, '_data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'asset-manifest.json.pending'), JSON.stringify(out, null, 1), 'utf8');
fs.renameSync(path.join(outDir, 'asset-manifest.json.pending'), path.join(outDir, 'asset-manifest.json'));
console.log(`manifest: ${out.characters.length} 角色 / ${out.environments.length} 环境 → assets/_data/asset-manifest.json`);
