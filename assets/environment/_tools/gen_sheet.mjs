/**
 * 环境 / 道具设计表 → HTML 图鉴页。
 *
 * 真源是 `assets/environment/props.json`；本脚本只负责排版，数据一律从真源读，
 * 改数据后重跑本脚本即可，不要手改生成的 HTML。
 *
 * 用法：node assets/environment/_tools/gen_sheet.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'props.json'), 'utf8'));
const imgDir = path.join(root, 'images');

const TOKENS = JSON.parse(
  fs.readFileSync(path.resolve(root, '../style/tokens.json'), 'utf8'),
).groups.core;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COVER_LABEL = {
  none: '不挡',
  low: '半掩体',
  high: '全掩体',
  full: '全阻断',
  overhead: '头顶遮蔽',
};

const hasImage = (id) =>
  fs.existsSync(path.join(imgDir, `${id}.png`)) ||
  fs.existsSync(path.join(imgDir, `${id}_gen.png`));

/** 一件道具的卡片 */
function card(e) {
  const [w, d, h] = e.footprint;
  const accent = TOKENS[e.accent] ?? '#9AA0A6';
  const img = hasImage(e.id) ? `../images/${e.id}.png` : null;
  const gen = `${e.ai.base}, ${data.genViewSuffix}, ${data.styleSuffix}`;
  return `
  <article class="card" style="border-color:${accent}">
    <header>
      <span class="badge" style="background:${accent}">${esc(e.id)}</span>
      <h3>${esc(e.name)} <small>${esc(e.en)}</small></h3>
      <span class="kind">${e.kind === 'structure' ? '结构' : '道具'}</span>
    </header>
    <div class="thumb" style="${img ? '' : 'display:grid;place-items:center;color:#6B6880'}">
      ${img ? `<img src="${img}" alt="${esc(e.name)}">` : `<span>待出图</span>`}
    </div>
    <dl>
      <dt>占地</dt><dd>${w} × ${d} × ${h} m</dd>
      <dt>三角</dt><dd>${e.tris}</dd>
      <dt>掩体</dt><dd><b style="color:${accent}">${COVER_LABEL[e.cover] ?? e.cover}</b></dd>
      <dt>出场</dt><dd>Act ${e.acts.join('/')}</dd>
      <dt>数量</dt><dd>${esc(e.count)}</dd>
    </dl>
    <p class="sil"><b>轮廓</b> ${esc(e.silhouette)}</p>
    <p class="look"><b>外观</b> ${esc(e.look)}</p>
    <p class="place"><b>摆放</b> ${esc(e.placement)}</p>
    ${e.destructNote ? `<p class="dz"><b>可破坏</b> ${esc(e.destructNote)}</p>` : ''}
    ${e.ai.note ? `<p class="note">出图要点：${esc(e.ai.note)}</p>` : ''}
    <details>
      <summary>生成提示词（混元图生 3D）</summary>
      <code>${esc(gen)}</code>
    </details>
  </article>`;
}

function section(title, sub, entries) {
  return `
  <section>
    <h2>${esc(title)} <span>${esc(sub)}</span></h2>
    <div class="grid">${entries.map(card).join('')}</div>
  </section>`;
}

const byId = new Map(data.entries.map((e) => [e.id, e]));
const pick = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);

const actSections = data.acts
  .map((a) =>
    section(
      `Act ${a.act} · ${a.name}`,
      `${a.en} — ${a.arena}`,
      pick(a.ids),
    ),
  )
  .join('');

const shared = section('通用件', '跨幕复用，任何 Act 都能撒', pick(data.shared.ids));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>末日尸潮 · 环境道具设计表</title>
<style>
  :root{
    --ink:#14110F; --paper:#F5E7C8; --bone:#FFF6E2; --night:#171327;
    --dim:#9AA0A6; --line:#3A3550;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:32px;background:var(--night);color:var(--bone);
       font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  h1{font-size:24px;margin:0 0 4px}
  h1 small{font-size:14px;color:var(--dim);font-weight:400}
  .meta{color:var(--dim);font-size:13px;margin-bottom:8px}
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 28px}
  .legend div{background:#221E33;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px}
  h2{font-size:18px;margin:32px 0 4px;padding-bottom:6px;border-bottom:2px solid var(--line)}
  h2 span{font-size:13px;color:var(--dim);font-weight:400}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:14px}
  .card{background:#221E33;border:2px solid var(--line);border-radius:14px;padding:12px}
  .card header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .badge{color:var(--ink);font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px}
  .card h3{margin:0;font-size:15px;flex:1}
  .card h3 small{color:var(--dim);font-weight:400;font-size:12px}
  .kind{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
  .thumb{height:160px;background:var(--paper);border-radius:10px;overflow:hidden;margin-bottom:10px}
  .thumb img{width:100%;height:100%;object-fit:contain}
  dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0 0 8px;font-size:13px}
  dt{color:var(--dim)}
  dd{margin:0}
  .card p{margin:4px 0;font-size:13px}
  .card b{color:var(--bone)}
  .dz{color:#FFC531}
  .note{color:#2BC4D6;font-size:12px}
  details{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
  summary{cursor:pointer;color:var(--dim);font-size:12px}
  code{display:block;margin-top:6px;font-size:11px;color:var(--dim);
       background:#0A0812;padding:8px;border-radius:6px;word-break:break-word}
</style>
</head>
<body>
<h1>末日尸潮 · 环境 / 道具设计表 <small>v${esc(data.version)}</small></h1>
<div class="meta">
  真源 <code>assets/environment/props.json</code> · 共 ${data.entries.length} 件
  （${data.entries.filter((e) => e.kind === 'prop').length} 道具 + ${data.entries.filter((e) => e.kind === 'structure').length} 结构）·
  三角合计 ${data.entries.reduce((a, e) => a + e.tris, 0)} · 单位 1 unit = 1 m，Y-up
</div>
<div class="meta">预算：${esc(data.budget.propTris)} / ${esc(data.budget.structureTris)} · ${esc(data.budget.readability)}</div>
<div class="legend">
  ${Object.entries(COVER_LABEL)
    .map(([k, v]) => `<div><b>${v}</b> · ${esc(data.coverClasses[k])}</div>`)
    .join('')}
</div>
${shared}
${actSections}
</body>
</html>`;

const out = path.join(root, '环境道具设计表.html');
fs.writeFileSync(out, html, 'utf8');
console.log('written', path.relative(process.cwd(), out), html.length, 'chars');
