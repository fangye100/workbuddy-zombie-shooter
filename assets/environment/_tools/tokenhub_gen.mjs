#!/usr/bin/env node
/**
 * TokenHub 批量资产生成器（环境/道具设计表 38 件）
 *
 * 用法：
 *   node tokenhub_gen.mjs --2d [--only P-01]     生成缺失的参考图（hy-image-v3 同步接口）
 *   node tokenhub_gen.mjs --3d [--only P-11]     图生 3D（hy-3d-3.0 提交+轮询，下载 glb+obj）
 *   node tokenhub_gen.mjs --status               查看 3D 任务进度（不提交新任务）
 *
 * Key 来源：环境变量 TOKENHUB_API_KEY，或 .workbuddy/tmp/tokenhub.env（gitignore）。
 * 日志：.workbuddy/tmp/tokenhub-2d.jsonl / tokenhub-3d.jsonl（断点续跑依据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROPS = path.join(ROOT, 'assets/environment/props.json');
const IMG_DIR = path.join(ROOT, 'assets/environment/images');
const MODEL_DIR = path.join(ROOT, 'assets/environment/models');
const TMP = path.join(ROOT, '.workbuddy/tmp');
const BASE = 'https://tokenhub.tencentmaas.com';

function key() {
  if (process.env.TOKENHUB_API_KEY) return process.env.TOKENHUB_API_KEY;
  const f = path.join(TMP, 'tokenhub.env');
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/TOKENHUB_API_KEY=(.+)/);
    if (m) return m[1].trim();
  }
  throw new Error('缺少 TOKENHUB_API_KEY（环境变量或 .workbuddy/tmp/tokenhub.env）');
}

const props = JSON.parse(fs.readFileSync(PROPS, 'utf8'));
const entries = new Map(props.entries.map((e) => [e.id, e]));
const fullPrompt = (e) => `${e.ai.base}, ${props.genViewSuffix}, ${props.styleSuffix}`;

function logLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/* ---------------- 2D：hy-image-v3 同步文生图 ---------------- */

async function gen2d(only) {
  const log = path.join(TMP, 'tokenhub-2d.jsonl');
  const have = new Set(fs.readdirSync(IMG_DIR).filter((f) => f.endsWith('.png')).map((f) => f.replace('.png', '')));
  const todo = props.entries.filter((e) => !have.has(e.id) && (!only || e.id === only));
  console.log(`2D 待生成 ${todo.length} 件（已有 ${have.size}）`);
  let ok = 0, fail = 0;
  for (const e of todo) {
    const prompt = fullPrompt(e);
    process.stdout.write(`[${e.id}] ${e.name} … `);
    try {
      const r = await post(`${BASE}/v1/wand/hunyuan-image/v3-generation`, {
        model: 'hy-image-v3' /* 正确 ID，不带 .0；带 .0 是 400 不存在 */,
        prompt,
        size: '1024x1024',
      });
      const url = r.json?.data?.[0]?.url;
      if (r.status !== 200 || !url) {
        fail++;
        console.log(`FAIL ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
        logLine(log, { id: e.id, ok: false, status: r.status, err: JSON.stringify(r.json).slice(0, 400), t: Date.now() });
        await sleep(3000);
        continue;
      }
      const bytes = await download(url, path.join(IMG_DIR, `${e.id}.png`));
      ok++;
      console.log(`OK ${(bytes / 1024).toFixed(0)}KB${r.json?.tokenhub_usage?.total_tokens ? ` (${r.json.tokenhub_usage.total_tokens} tokens)` : ''}`);
      logLine(log, { id: e.id, ok: true, bytes, usage: r.json?.tokenhub_usage ?? null, t: Date.now() });
    } catch (err) {
      fail++;
      console.log(`ERR ${err.message}`);
      logLine(log, { id: e.id, ok: false, err: err.message, t: Date.now() });
    }
    await sleep(1500); // 温和限速
  }
  console.log(`\n2D 完成：${ok} 成功 / ${fail} 失败`);
  return fail === 0 ? 0 : 1;
}

/* ---------------- 3D：hy-3d-3.0 图生 3D（提交+轮询+下载） ---------------- */

const stateFile = path.join(TMP, 'tokenhub-3d-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8'); }

async function submit3d(id) {
  const imgPath = path.join(IMG_DIR, `${id}.png`);
  if (!fs.existsSync(imgPath)) throw new Error(`参考图不存在：${imgPath}`);
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const body = {
    model: 'hy-3d-3.0',
    image_base64: b64,
    // 不传 result_format：默认返回 obj + glb 两种。传 'glb' 会被大小写敏感的
    // 校验拒绝（报错文案自相矛盾：glb 不在 [OBJ, GLB, ...] 内）
  };
  const r = await post(`${BASE}/v1/api/3d/submit`, body);
  if (r.status !== 200 || !r.json?.id) throw new Error(`提交失败 ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}

async function query3d(jobId) {
  const r = await post(`${BASE}/v1/api/3d/query`, { model: 'hy-3d-3.0', id: jobId });
  return r.json;
}

async function gen3d(only) {
  const log = path.join(TMP, 'tokenhub-3d.jsonl');
  const state = loadState();
  const want = props.entries.filter((e) => (!only || e.id === only) && fs.existsSync(path.join(IMG_DIR, `${e.id}.png`)));
  console.log(`3D 候选 ${want.length} 件（有参考图的）`);

  // 并发=3（API 上限）：维护一个待办池
  const queue = want.map((e) => e.id).filter((id) => !state[id]?.done);
  const MAX_PAR = 3;
  let done = 0, failed = 0;
  const counts = { done: want.filter((e) => state[e.id]?.done).length };

  async function worker(wid) {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      let st = state[id] ?? {};
      state[id] = st;
      try {
        if (!st?.jobId) {
          const sub = await submit3d(id);
          st.jobId = sub.id; st.status = sub.status; st.submitted = Date.now();
          saveState(state);
          console.log(`[w${wid}] ${id} 提交 ${sub.id}`);
        }
        // 轮询直到完成（最多 10 分钟）
        const t0 = Date.now();
        for (;;) {
          if (Date.now() - t0 > 10 * 60_000) throw new Error('轮询超时 10min');
          await sleep(5000);
          const q = await query3d(st.jobId);
          if (q?.status === 'completed') {
            const glb = q.data?.find((d) => d.type === 'glb');
            const obj = q.data?.find((d) => d.type === 'obj');
            if (!glb?.url) throw new Error('completed 但没有 glb url');
            const glbBytes = await download(glb.url, path.join(MODEL_DIR, id, `${id}.glb`));
            let objBytes = 0;
            if (obj?.url) { try { objBytes = (await download(obj.url, path.join(MODEL_DIR, id, `${id}.obj.zip`))); } catch { /* obj 可选 */ } }
            if (glb.preview_image_url) { try { await download(glb.preview_image_url, path.join(MODEL_DIR, id, 'preview.png')); } catch {} }
            st.done = true; st.status = 'completed'; st.glbBytes = glbBytes; st.finished = Date.now();
            saveState(state);
            done++; counts.done++;
            console.log(`[w${wid}] ${id} ✓ glb ${(glbBytes / 1024 / 1024).toFixed(1)}MB${objBytes ? ` + obj ${(objBytes / 1024 / 1024).toFixed(1)}MB` : ''}（${Math.round((Date.now() - t0) / 1000)}s，总进度 ${counts.done}/${want.length}）`);
            logLine(log, { id, ok: true, jobId: st.jobId, glbBytes, t: Date.now() });
            break;
          }
          if (q?.status === 'failed') throw new Error(`任务失败: ${JSON.stringify(q).slice(0, 200)}`);
          // in_progress / queued → 继续等
        }
      } catch (err) {
        failed++;
        st.status = 'error'; st.error = err.message;
        saveState(state);
        console.log(`[w${wid}] ${id} ✗ ${err.message}`);
        logLine(log, { id, ok: false, jobId: st?.jobId ?? null, err: err.message, t: Date.now() });
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_PAR }, (_, i) => worker(i + 1)));
  console.log(`\n3D 完成：新增 ${done} 成功 / ${failed} 失败；累计完成 ${counts.done}/${want.length}`);
  return failed === 0 ? 0 : 1;
}

async function showStatus() {
  const state = loadState();
  const rows = Object.entries(state).map(([id, s]) => `${id}: ${s.done ? '✓ done' : (s.status ?? 'pending')}${s.error ? ` (${s.error.slice(0, 60)})` : ''}`);
  console.log(rows.length ? rows.join('\n') : '(无 3D 任务记录)');
  const doneCount = Object.values(state).filter((s) => s.done).length;
  console.log(`\n完成 ${doneCount} / 目标 38`);
}

/* ---------------- main ---------------- */

const args = process.argv.slice(2);
if (args.includes('--status')) { await showStatus(); process.exit(0); }
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
if (args.includes('--2d')) process.exit(await gen2d(only));
if (args.includes('--3d')) process.exit(await gen3d(only));
console.log('用法：--2d | --3d | --status [--only <ID>]');
process.exit(2);
