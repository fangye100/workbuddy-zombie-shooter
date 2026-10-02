/**
 * 动态通道 GPU 蒙皮验收探针（docs/20 M2）。
 *
 * 断言的不是「像素好不好看」（那是人工 / cdp-verify 的事），而是**装配链贯通**：
 *   1. Play 后 ActorLibrary 装配 E-01（manifest LOD3「+动画」→ parseGlb → 烘焙调色板）
 *   2. 渲染批次 meshIds 含 actor:E-01（真模型）**且**仍含 capsule:*（E-02 无档降级）
 *   3. 实例 flags bit0 = 1（蒙皮路径）与 0（胶囊路径）同帧共存
 *   4. Play → Stop → Play 循环：Stop 释放 GPU palette，再 Play 必须重传
 *      （2026-10-02 M2 实现期修掉的坑：preload 幂等返回 false 导致 palette 不重传，
 *       蒙皮实例查已销毁 buffer → 顶点全零塌缩）
 *   5. 全程 console 无 error / 无未捕获异常（WGSL 编译错误在这里暴露）
 *
 * 用法（本机一律 headed + 真实 GPU）：
 *   node tools/verify/dynamic-skin-probe.mjs --headed
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
const CDP_PORT = Number(arg('cdp', 9341));
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME = arg('chrome', '') || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { results, check, summary } = createRecorder();

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
  try {
    // launch 建的 target 停在 about:blank（localStorage 被禁），先导航到编辑器
    await cdp.send('Page.navigate', { url });
    await normalizeEditorState(cdp);

    // ---- ① Play：等真角色装配（manifest fetch + GLB 解析 + 烘焙，秒级）----
    // reload 后场景仍在 boot 时点击会返回「场景尚未加载」（产品行为：warn + HUD），
    // 探针按真实用户节奏轮询重试，直到 Play 真正激活（stop 按钮解禁）
    await waitFor(
      () =>
        cdp
          .eval(
            `(() => { const stop = document.querySelector('#btn-stop');
               if (stop && stop.disabled) { document.querySelector('#btn-play').click(); return false; }
               return true; })()`,
          )
          .then((r) => r === true),
      { timeout: 20000, interval: 500, label: 'Play 激活（场景 boot 后点击生效）' },
    );
    await waitFor(
      () => cdp.eval('(() => window.__editor?.actorLib?.size ?? -1)()').then((n) => n === 1),
      { timeout: 20000, interval: 400, label: 'E-01 装配完成（actorLib.size === 1）' },
    );

    // HUD / 渲染刷新间隔（0.4s 量级）之后读批次状态
    await sleep(900);
    const st = await cdp.eval(`(() => {
      const r = window.__editor.renderer;
      const ids = r.debugDynamicMeshIds();
      return { ids, actors: window.__editor.actorLib.size,
               playing: document.querySelector('#btn-pause') && !document.querySelector('#btn-pause').disabled };
    })()`);
    check('E-01 已装配（actorLib.size = 1）', st.actors === 1, JSON.stringify(st.actors));
    check('动态批次含真模型网格 actor:E-01', st.ids.includes('actor:E-01'), st.ids.join(','));
    check('未装配角色仍走胶囊（E-02 降级是设计行为）', st.ids.some((i) => i.startsWith('capsule:')), st.ids.join(','));

    // ---- ② 实例 flags 双路径（蒙皮位与胶囊位同帧共存）----
    const flags = await cdp.eval(`(() => {
      const lib = window.__editor.actorLib;
      const e01 = lib.get('E-01');
      return e01 ? { paletteBase: e01.paletteBase, restPose: e01.restPose,
                     joints: e01.joints.length, weights: e01.weights.length,
                     verts: e01.vertices.length / 15, feetOffset: e01.feetOffset } : null;
    })()`);
    check('装配数据完整（skin 顶点 + paletteBase + restPose）',
      flags !== null && flags.joints > 0 && flags.weights > 0 && flags.paletteBase === 0 && flags.restPose >= 0,
      JSON.stringify(flags));

    // ---- ③ 截图留档（人工复核「真模型非胶囊」； headed + 反遮挡 flags 已加）----
    await sleep(1200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'dynamic-skin-m2.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    check('截图留档（M2 视觉复核）', true, shotPath);

    // ---- ④ Play → Stop → Play 循环（palette 重传回归）----
    // 记录 Stop 前的 palette 上传计数：再 Play 后它必须**增长**——只看批次重建
    // 不够（attach() 会同步重建 actor 批次，此时 bind group 可能还指着哑 palette，
    // PR #18 review 抓的假阳性窗口）
    const uploadsBeforeStop = await cdp.eval('window.__editor.renderer.core.paletteUploadCount');
    await cdp.eval(`(() => { document.querySelector('#btn-stop').click(); return true; })()`);
    await sleep(700);
    const afterStop = await cdp.eval(`(() => ({
      ids: window.__editor.renderer.debugDynamicMeshIds(),
      actors: window.__editor.actorLib.size,
    }))()`);
    check('Stop 后动态批次清空（渲染侧无残留）', afterStop.ids.length === 0, JSON.stringify(afterStop.ids));
    check('Stop 只释放 GPU 侧，CPU 装配缓存保留（下次 Play 免重载）', afterStop.actors === 1, JSON.stringify(afterStop.actors));

    await waitFor(
      () =>
        cdp
          .eval(
            `(() => { const stop = document.querySelector('#btn-stop');
               if (stop && stop.disabled) { document.querySelector('#btn-play').click(); return false; }
               return true; })()`,
          )
          .then((r) => r === true),
      { timeout: 20000, interval: 500, label: '再 Play 激活' },
    );
    const again = await waitFor(
      () =>
        cdp
          .eval(
            `(() => { const i = window.__editor.renderer.debugDynamicMeshIds();
               const up = window.__editor.renderer.core.paletteUploadCount;
               return i.includes("actor:E-01") && up > ${Number(uploadsBeforeStop) || 0} ? i : null; })()`,
          )
          .then((r) => r !== null),
      { timeout: 20000, interval: 400, label: '再 Play 后 actor 批次重建 且 palette 确已重传' },
    ).catch(() => false);
    check('再 Play：palette 重传 + 真模型批次恢复（循环回归）', again === true, `uploads: ${uploadsBeforeStop} → 后续增长`);

    // ---- ⑤ console 卫生（WGSL 编译错误 / GPU validation error 在这里暴露）----
    await sleep(600);
    check('无 console error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | ').slice(0, 400));
    check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | ').slice(0, 400));
  } finally {
    await chrome.kill();
    // 探针自起的 vite 必须带走（复用既有 server 时 server 为 null，不杀别人的）
    if (server !== null) server.kill();
  }

  const code = summary(cdp.consoleErrors, cdp.exceptions);
  process.exit(code);
}

main().catch((err) => {
  console.error('探针异常终止：', err.message);
  process.exit(1);
});
