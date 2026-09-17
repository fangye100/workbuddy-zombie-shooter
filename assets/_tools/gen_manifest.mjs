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

/** 读 GLB 的 JSON chunk（拿动画名/骨骼数，不加载网格） */
function glbInfo(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'
    const jsonLen = buf.readUInt32LE(12);
    const js = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
    return {
      animations: (js.animations ?? []).map((a) => a.name ?? 'clip'),
      joints: js.skins?.[0]?.joints?.length ?? 0,
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

// ---------------- 角色 ----------------
const roster = JSON.parse(fs.readFileSync(path.join(ASSETS, 'characters/roster.json'), 'utf8'));
for (const c of [...roster.npcs, ...roster.bosses]) {
  const base = `characters/models/${c.id}`;
  const dir = path.join(ASSETS, 'characters/models', c.id);
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

  const views = {};
  for (const v of ['front', 'side', 'attack']) {
    const imgDir = path.join(ASSETS, 'characters/images', c.id, v);
    if (fs.existsSync(imgDir)) {
      const f = fs.readdirSync(imgDir).find((x) => x.endsWith('.png'));
      if (f) views[v] = `characters/images/${c.id}/${v}/${f}`;
    }
  }

  const lods = [];
  // 🔴 LOD0 = 混元原生高模（原生 4096² baseColor 贴图，真源）。
  // 旧 LOD0（textured/*_baked.glb）是「原贴图→顶点色→逐面平涂」的有损中间产物，不是原生模型。
  const rawGlb = fs.readdirSync(dir).find((f) => new RegExp(`^${c.id.replace(/-/g, '')}_\\d{8}_\\d{6}\\.glb$`).test(f)) ?? null;
  if (rawGlb) lods.push({ label: 'LOD0 · 原生高模(混元raw ~80k面)', file: `${base}/${rawGlb}`, tris: 80000 });
  if (baked) lods.push({ label: 'LOD1 · 贴图低模', file: `${base}/textured/${baked}`, tris: c.tris });
  if (riggedOnly) lods.push({ label: 'LOD2 · +骨骼', file: `${base}/rigged/${riggedOnly}`, tris: c.tris });
  if (animated) lods.push({ label: 'LOD3 · +动画', file: `${base}/rigged/${animated}`, tris: c.tris });

  out.characters.push({
    id: c.id, name: c.name, en: c.en ?? '', kind: roster.bosses.includes(c) ? 'boss' : 'npc',
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
  if (raw) lods.push({ label: 'LOD0 · 高模(raw ~50万面)', file: raw, tris: 500000 });
  // 🔴 tex2（原贴图转移版）优先于 tex（顶点色烘焙版）优先于顶点色 OBJ：
  // tex2 = raw 混元原贴图经三维空间对应转移到低模 UV（真色）；tex = 顶点色放大（旧法，弃用）。
  const tex2 = fs.existsSync(path.join(dir, 'tex2'))
    ? fs.readdirSync(path.join(dir, 'tex2')).filter((f) => f.endsWith('_baked.glb')) : [];
  const texGlbs = fs.existsSync(path.join(dir, 'tex'))
    ? fs.readdirSync(path.join(dir, 'tex')).filter((f) => f.endsWith('_baked.glb')) : [];
  if (tex2.length) {
    lods.push({ label: 'LOD1 · 低模+原贴图', file: `${base}/tex2/${tex2[0]}`, tris: e.tris });
  } else if (texGlbs.length) {
    lods.push({ label: 'LOD1 · 低模+贴图', file: `${base}/tex/${texGlbs[0]}`, tris: e.tris });
  }
  if (low) lods.push({ label: 'LOD2 · 低模(顶点色)', file: low, tris: e.tris });

  out.environments.push({
    id: e.id, name: e.name, en: e.en ?? '', kind: e.kind,
    act: e.act ? actName[e.act] ?? `Act${e.act}` : '通用',
    footprint: e.footprint, tris: e.tris,
    cover: e.cover ?? '', blocksSight: e.blocksSight, blocksMove: e.blocksMove,
    destructible: e.destructible ?? null,
    silhouette: e.silhouette ?? '', look: e.look ?? '', accent: e.accent ?? '',
    placement: e.placement ?? '',
    img, preview, lods,
    animations: [], joints: 0,
  });
}

const outDir = path.join(ASSETS, '_data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'asset-manifest.json'), JSON.stringify(out, null, 1), 'utf8');
console.log(`manifest: ${out.characters.length} 角色 / ${out.environments.length} 环境 → assets/_data/asset-manifest.json`);
