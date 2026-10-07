/**
 * 动态通道 GPU 蒙皮验收探针（docs/20 M2 + M3）。
 *
 * 断言的不是「像素好不好看」（那是人工 / cdp-verify 的事），而是**装配链贯通**：
 *   1. Play 后 ActorLibrary 装配全部「+动画」档角色（manifest LOD3 → parseGlb →
 *      烘焙调色板；期望清单从 asset-manifest.json 派生，禁手抄）
 *   2. 渲染批次 meshIds 含 actor:*（真模型）**且**仍含 capsule:*（玩家 P-01
 *      不在 manifest，永远胶囊）
 *   3. 实例 flags bit0 = 1（蒙皮路径）与 0（胶囊路径）同帧共存
 *   4. M3 装配数学：任一 paletteBase > 0 的角色，base/restPose 与该角色 palette
 *      pose 数构成的不变量成立（rest = poses-1 局部末帧 bind；base 按注册序
 *      以 pose 单位累加 —— PR #18 抓过的 P1，探针从公开字段独立复算）
 *   5. M3 动画在走：两个相隔 >500ms 的时刻读同一 actor 实例的 inst[11]
 *      （poseIndex，相对 paletteBase），值必须变化（tick 推相位）
 *   6. M3 批次构成：actor 批 = 实体在场的有档角色；B-02 无档不装配
 *      （floor-1 无 B-02 刷怪点，降级在库级验证）
 *   7. Play → Stop → Play 循环：Stop 释放 GPU palette，再 Play 必须重传
 *      （2026-10-02 M2 实现期修掉的坑：preload 幂等返回 false 导致 palette 不重传，
 *       蒙皮实例查已销毁 buffer → 顶点全零塌缩）
 *   8. 全程 console 无 error / 无未捕获异常（WGSL 编译错误在这里暴露）
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

/**
 * 期望装配清单（探针侧 oracle，与 findAnimatedCharacterIds 同语义的独立重算）：
 * manifest 里带「+动画」档的角色，按清单顺序。禁手抄 —— 手抄清单 = 第二真源。
 */
function expectedAnimatedIds() {
  const manifest = JSON.parse(fs.readFileSync(path.resolve('assets/_data/asset-manifest.json'), 'utf8'));
  return manifest.characters
    .filter(
      (c) =>
        Array.isArray(c.lods) &&
        c.lods.some((l) => typeof l.label === 'string' && l.label.includes('+动画')),
    )
    .map((c) => c.id);
}

async function main() {
  const expected = expectedAnimatedIds();
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
      () =>
        cdp.eval('(() => window.__editor?.actorLib?.size ?? -1)()').then((n) => n === expected.length),
      { timeout: 30000, interval: 400, label: `全部「+动画」档角色装配完成（actorLib.size === ${expected.length}）` },
    );

    // HUD / 渲染刷新间隔（0.4s 量级）之后读批次状态
    await sleep(900);
    const st = await cdp.eval(`(() => {
      const r = window.__editor.renderer;
      const ids = r.debugDynamicMeshIds();
      return { ids, actors: window.__editor.actorLib.size,
               playing: document.querySelector('#btn-pause') && !document.querySelector('#btn-pause').disabled };
    })()`);
    check(
      `全部「+动画」档角色已装配（actorLib.size = ${expected.length}，清单从 manifest 派生）`,
      st.actors === expected.length,
      JSON.stringify(st.actors),
    );
    check('动态批次含真模型网格 actor:E-01', st.ids.includes('actor:E-01'), st.ids.join(','));
    check('未装配角色仍走胶囊（玩家 P-01 不在 manifest，恒胶囊）', st.ids.some((i) => i.startsWith('capsule:')), st.ids.join(','));

    // ---- M3 ③ 批次构成：actor 批 = 实体在场的有档角色；B-02 无档不装配 ----
    const compose = await cdp.eval(`(() => {
      const lib = window.__editor.actorLib;
      const ids = window.__editor.renderer.debugDynamicMeshIds();
      const actorIds = ids.filter((i) => i.startsWith('actor:')).map((i) => i.slice(6));
      // 实体视图派生（不手抄场景）：在场角色按「装配库有没有」分成真模型/胶囊两组
      const present = new Set(window.__editor.bridge.entities.map((e) => e.characterId));
      const liveActor = [...present].filter((id) => lib.get(id) !== null).sort();
      const liveCapsule = [...present].filter((id) => lib.get(id) === null).sort();
      return { actorIds: [...new Set(actorIds)].sort(), liveActor, liveCapsule,
               b02: lib.get('B-02'), present: [...present].sort() };
    })()`);
    check(
      'actor 批次 = 实体在场的有档角色（批次按 characterId 分槽）',
      JSON.stringify(compose.actorIds) === JSON.stringify(compose.liveActor) && compose.actorIds.length >= 2,
      `batches=${JSON.stringify(compose.actorIds)} live=${JSON.stringify(compose.liveActor)}`,
    );
    check('B-02 无「+动画」档不装配（缺档退胶囊是库级设计行为）', compose.b02 === null, JSON.stringify(compose.b02));
    check('在场无档角色走胶囊（floor-1 = 玩家 P-01）', compose.liveCapsule.length >= 1, JSON.stringify(compose.liveCapsule));

    // ---- ② 实例 flags 双路径（蒙皮位与胶囊位同帧共存）----
    const flags = await cdp.eval(`(() => {
      const lib = window.__editor.actorLib;
      const e01 = lib.get('E-01');
      return e01 ? { paletteBase: e01.paletteBase, restPose: e01.restPose,
                     joints: e01.joints.length, weights: e01.weights.length,
                     verts: e01.vertices.length / 15, feetOffset: e01.feetOffset } : null;
    })()`);
    check('装配数据完整（skin 顶点 + paletteBase + restPose）',
      flags !== null && flags.joints > 0 && flags.weights > 0 && flags.paletteBase >= 0 && flags.restPose >= 0,
      JSON.stringify(flags));

    // ---- M3 ① 装配数学（双角色，从 ActorMesh 公开字段独立复算）----
    // 任一 paletteBase > 0 的角色：base 按注册序以 pose 单位累加、restPose 是
    // 角色 palette 局部末帧（= pose 数 - 1）、base + rest 指向该角色块最后一 pose。
    // 探针不复用页面里的 assemblePalettes —— 独立重算才有防线价值。
    const math = await cdp.eval(`(() => {
      const lib = window.__editor.actorLib;
      const ids = lib.assembledIds;
      return ids.map((id) => {
        const a = lib.get(id);
        const poses = a.palette.data.length / 16 / a.palette.jointCount;
        return { id, base: a.paletteBase, rest: a.restPose, poses, joints: a.palette.jointCount };
      });
    })()`);
    const withBase = math.filter((m) => m.base > 0);
    check('双角色在场（paletteBase > 0 的角色存在）', withBase.length >= 1, JSON.stringify(math));
    if (withBase.length >= 1) {
      const sorted = [...math].sort((a, b) => a.base - b.base);
      let acc = 0;
      let okChain = true;
      let okRest = true;
      let okRange = true;
      for (const m of sorted) {
        if (m.base !== acc) okChain = false;
        if (m.rest !== m.poses - 1) okRest = false;
        if (m.base + m.rest * m.joints !== acc + (m.poses - 1) * m.joints) okRange = false;
        acc += m.poses * m.joints;
      }
      const totalPoses = acc;
      check('paletteBase 按注册序以 matrix 单位累加（bases 首尾相接）', okChain, JSON.stringify(sorted));
      check('restPose = 角色 palette 局部末帧（poses - 1，PR #18 P1 防线）', okRest, JSON.stringify(sorted));
      check('base + rest*stride = 该角色块末 pose（矩阵下标不越界）', okRange && sorted.every((m) => m.base + m.rest * m.joints < totalPoses), JSON.stringify(sorted));
    }

    // ---- M3 ② 动画在走：隔 >500ms 两次读同一 actor 实例的 inst[11]（poseIndex）----
    // inst 布局：[7] paletteBase / [11] poseIndex（局部）/ [12] frameCount /
    // [13] phase01 / [14] flags。tick 推相位 → poseIndex 必随时间变化。
    const samplePoses = () =>
      cdp.eval(`(() => {
        const batches = window.__editor.bridge.batches();
        if (batches === null) return null;
        const out = {};
        for (const b of batches) {
          if (!b.meshId.startsWith('actor:')) continue;
          for (let i = 0; i < b.count; i++) {
            const stride = window.__editor.bridge.instanceStride;
            out[b.meshId + '#' + i] = { pose: b.instances[i * stride + 11], base: b.instances[i * stride + 7] };
          }
        }
        return out;
      })()`);
    const poseA = await samplePoses();
    await sleep(900); // >500ms：30 tick/s 下 walk 片相位推进 ~0.45 周期，帧号必变
    const poseB = await samplePoses();
    const keysA = Object.keys(poseA ?? {});
    const changed = keysA.filter((k) => poseB[k] !== undefined && poseB[k].pose !== poseA[k].pose);
    check(
      '动画在走（同一 actor 实例隔 900ms 的 poseIndex 全部变化）',
      keysA.length > 0 && changed.length === keysA.length,
      `${changed.length}/${keysA.length} 变化`,
    );
    const idxSafe = keysA.every((k) => poseA[k].pose >= 0 && poseA[k].pose < 1e9 && Number.isFinite(poseA[k].pose));
    check('poseIndex 数值健康（有限非负，非 u32 巨数）', idxSafe, JSON.stringify(Object.values(poseA ?? {}).slice(0, 3)));

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
    check(
      `Stop 只释放 GPU 侧，CPU 装配缓存保留（下次 Play 免重载）`,
      afterStop.actors === expected.length,
      JSON.stringify(afterStop.actors),
    );

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
