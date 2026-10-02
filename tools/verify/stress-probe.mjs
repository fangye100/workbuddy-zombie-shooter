/**
 * P4 M4 规模与降级压测探针（docs/20 §M4）。
 *
 * 测的不是「能不能跑」，而是**跑起来是什么数字** —— M4 的交付物就是这组数字：
 *
 *   ① 200 只僵尸在场：帧率（samples 的 p50 / min）、draw call、三角形数
 *   ② 降级生效：远处实体（LOD Proxy）走胶囊批次，近处走真模型批次 —— 同帧共存
 *   ③ JS heap（performance.memory，Chrome 下可用）
 *   ④ 全程 console 无 error（WGSL / 装配链错误在这里暴露）
 *   ⑤ 数字落盘 JSON，供 docs 引用与前后对比（**不能靠人抄**）
 *
 * 用法：
 *   node tools/verify/stress-probe.mjs --headed [--count=200] [--spread=40]
 * 退出码：0 = 全部通过；1 = 有断言失败或 console error。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  sleep,
  waitFor,
  createRecorder,
  makeArgParser,
  ensureServer,
  launchEditorSession,
  normalizeEditorState,
} from './editor-smoke-lib.mjs';

const { arg, has } = makeArgParser(process.argv);
const PORT = Number(arg('port', 5100));
const CDP_PORT = Number(arg('cdp', 9345));
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME = arg('chrome', '') || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COUNT = Number(arg('count', 200));
/** 近场组铺开半径（米）。远场组固定铺在玩家 +150m（跨过 vatDistance=60 的降级线） */
const SPREAD = Number(arg('spread', 12));

const { results, check, summary } = createRecorder();

/** 分位数（不引入依赖：样本量小，直接排序取） */
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[i];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, url } = await ensureServer(PORT, 'apps/editor/vite.config.ts');
  const { chrome, cdp } = await launchEditorSession({
    chromePath: CHROME,
    cdpPort: CDP_PORT,
    headed: has('headed'),
    appUrl: url,
    windowSize: '1500,950',
  });
  const report = { count: COUNT, spread: SPREAD, samples: [], batches: null, heap: null };
  try {
    await cdp.send('Page.navigate', { url });
    await normalizeEditorState(cdp);

    // ---- Play 激活（场景 boot 竞态下轮询重试，M2/M5 探针同款）----
    await waitFor(
      () =>
        cdp
          .eval(
            `(() => { const stop = document.querySelector('#btn-stop');
               if (stop && stop.disabled) { document.querySelector('#btn-play').click(); return false; }
               return true; })()`,
          )
          .then((r) => r === true),
      { timeout: 20000, interval: 500, label: 'Play 激活' },
    );
    await sleep(1200); // 等装配（GLB 解析 + 烘焙）+ 帧率稳定

    report.bakeProfile = await cdp.eval(`(()=>window.__editor.bakeProfile())()`);

    // ---- ① 基线：关卡自带编成 ----
    const base = await cdp.eval(`(()=>{
      const s = window.__editor.playCtl.session.runtime;
      const st = window.__editor.renderer.stats;
      return { npc: s.countNpc(), draws: st.drawCalls, tris: st.triangles };
    })()`);
    report.baseline = base;

    // ---- ② 注入 200 只（压测通道 debugSpawn：不进房间计数，不搅动波次）----
    const spawned = await cdp.eval(`(()=>{
      const s = window.__editor.playCtl.session.runtime;
      const p = s.playerEntityId;
      const x = s.table.posX[p], z = s.table.posZ[p];
      // 🔴 必须分**两组**：近处（≤25m，Full 真模型）+ 远处（>60m，应退胶囊）。
      // 只把 200 只铺在近处是测不出降级有没有生效的（第一次实跑就踩了这个坑：
      // 断言 proxy>0 失败，因为全员都在阈值内）。
      const near = s.debugSpawn('E-01', x, z, ${Math.floor(COUNT / 2)}, ${SPREAD});
      const far = s.debugSpawn('E-01', x + 150, z, ${COUNT - Math.floor(COUNT / 2)}, 40);
      return near + far;
    })()`);
    check(`压测注入 ${COUNT} 只（debugSpawn 返回实际生成数）`, spawned >= COUNT * 0.9, `spawned=${spawned}`);
    await sleep(1500); // 让帧率在新的实体量下稳定

    // ---- ③ 采样帧率（2 秒窗口，间隔 200ms）----
    for (let k = 0; k < 10; k++) {
      const s = await cdp.eval(
        `(()=>{const st=window.__editor.renderer.stats;
                return {fps:window.__editor.fps(), draws:st.drawCalls, tris:st.triangles}})()`,
      );
      report.samples.push(s);
      await sleep(200);
    }

    // ---- ④ 批次构成：真模型批次与胶囊批次同帧共存（LOD 降级生效的证据）----
    const batches = await cdp.eval(`(()=>{
      const ids = window.__editor.renderer.debugDynamicMeshIds();
      const s = window.__editor.playCtl.session.runtime;
      let proxy = 0, full = 0;
      for (const e of s.view()) { if (e.kind !== 'npc') continue; if (e.lodTier >= 2) proxy++; else full++; }
      return { ids, proxy, full, npc: s.countNpc() };
    })()`);
    report.batches = batches;
    check(
      '在场实体数 ≥ 压测量（200 只真的在跑）',
      batches.npc >= COUNT * 0.9,
      `npc=${batches.npc}`,
    );
    check(
      'LOD 已分流：近处真模型 + 远处胶囊同帧共存',
      batches.proxy > 0 && batches.full > 0,
      `full=${batches.full} proxy=${batches.proxy}`,
    );
    check(
      '批次里同时有 actor:* 与 capsule:*（降级落到渲染批次上，不只是改了个字段）',
      batches.ids.some((i) => i.startsWith('actor:')) && batches.ids.some((i) => i.startsWith('capsule:')),
      JSON.stringify(batches.ids).slice(0, 200),
    );

    // ---- ⑤ heap（Chrome 专有 API，拿不到就记 null，不算失败）----
    report.heap = await cdp.eval(
      `(()=>{const m=performance.memory; return m?{used:m.usedJSHeapSize,limit:m.jsHeapSizeLimit}:null})()`,
    );

    const fpsList = report.samples.map((s) => s.fps).filter((f) => f > 0).sort((a, b) => a - b);
    report.fps = {
      p50: quantile(fpsList, 0.5),
      min: fpsList[0] ?? 0,
      max: fpsList[fpsList.length - 1] ?? 0,
      samples: fpsList.length,
    };
    check(
      `帧率采样有效（${report.fps.samples} 个样本，p50=${report.fps.p50?.toFixed?.(1) ?? '?'}fps）`,
      report.fps.samples >= 5 && report.fps.p50 > 0,
      JSON.stringify(report.fps),
    );

    // ---- ⑥ 截图 + console 卫生 ----
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'stress-200.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    report.screenshot = shotPath;
    check('截图留档', true, shotPath);
    check('无 console error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | ').slice(0, 300));
    check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | ').slice(0, 300));
  } finally {
    // 数字必须落盘：M4 的交付物就是它，靠人从控制台抄等于没记
    const outPath = path.join(OUT_DIR, 'stress-report.json');
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n压测数字落盘：${outPath}`);
    await chrome.kill();
    if (server !== null) server.kill();
  }

  const code = summary(cdp.consoleErrors, cdp.exceptions);
  process.exit(code);
}

main().catch((err) => {
  console.error('压测探针异常终止：', err.message);
  process.exit(1);
});
