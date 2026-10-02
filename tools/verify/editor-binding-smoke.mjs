/**
 * 编辑器冒烟 · 绑定套件（2026-09-23 拆分，docs/21 报告落地）。
 *
 * 承载原 editor-smoke.mjs 的 K~L3 段（绑定管线：T-pose 铁律 / 正侧视 /
 * Skin Wrapper / 文件骨架导入 / BVH 重定向 / MCP 探针）——全项目最复杂的链路，
 * 回归价值极高，但与 UI 布局改动几乎无关。拆出后：
 *
 *   - 改 UI（不含 main.ts 绑定接线区）→ 只跑 `pnpm run editor:smoke`（核心套件）
 *   - 改 services/binding/** / retarget / import-skeleton / main.ts 绑定接线 → 跑本套件
 *   - merge / push 前最终门禁 → 两套件都要绿（`pnpm run editor:smoke:all`）
 *
 * 共享帮助器（断言记账 / waitFor / CDP 会话 / 真源推导）在 editor-smoke-lib.mjs。
 * L2c（像素健康度）按文件分工纪律迁往 cdp-verify.mjs（视觉域）。
 *
 * 用法：node tools/verify/editor-binding-smoke.mjs [--headed] [--cdp 9334] [--bind <glb>]
 * 退出码：0 = 全过；1 = 有断言失败或捕获 console error / 未捕获异常。
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

// ---------------------------------------------------------------- 参数

const { arg, has } = makeArgParser(process.argv);

const PORT = Number(arg('port', 5100));
// 默认与核心套件错开：串行跑时互不干扰，需要时也可共用
const CDP_PORT = Number(arg('cdp', 9334));
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME =
  arg('chrome', '') ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let APP_URL = '';

const { results, check, skip, summary } = createRecorder();

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, url } = await ensureServer(PORT, 'apps/editor/vite.config.ts');
  APP_URL = url;
  const HEADED = has('headed');

  const { chrome, cdp } = await launchEditorSession({
    chromePath: CHROME,
    cdpPort: CDP_PORT,
    headed: HEADED,
    appUrl: APP_URL,
  });
  await cdp.send('Page.navigate', { url: APP_URL });
  await waitFor(
    () => cdp.eval('(() => (window.__editor && document.getElementById("gpu")) ? document.getElementById("gpu").clientHeight : 0)()').then((h) => typeof h === 'number' && h > 100),
    { timeout: 20000, interval: 300, label: '首帧就绪' },
  );
  await normalizeEditorState(cdp);

  try {
    // （绑定段从此处开始——内容与原 editor-smoke.mjs 完全一致，未改断言）
    // L 段「应用动画到场景物体」用的已绑定 rigged GLB（原核心文件顶部参数，随段迁移）
    const RIGGED_GLB = arg(
      'rigged',
      'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged.glb',
    ).split(path.sep).join('/');

    // ---- K. 绑定面板 Binding（正/侧视图 · mirror · T-pose 反解导出）----
    // 这里守的是一条铁律：**初始 T-pose 只能采纳骨长，joint 之间的旋转差值全是
    // currentPose 与 T-pose 的 pose 差值**。一旦有人把 ΔR 写进骨架，bind pose 就
    // 不是干净 T-pose，接入 BVH / 动捕会整条带 offset。DOM 探针证明不了这条，
    // 必须用「A-pose 输入 → T-pose 手臂仍水平 → 世界矩阵旋转仍是单位阵」三连断言。
    console.log('\nK. 绑定面板 Binding（骨长采纳 / 姿态偏移不入骨架）');
    const bindDom = await cdp.eval(
      `(()=>{const d=document.getElementById('binding-dock');const m=document.getElementById('ctx-menu');
        return {dock:d!==null, menu:m!==null, hook:typeof window.__editor.binding}})()`,
    );
    check('绑定面板宿主 #binding-dock 存在', bindDom.dock === true);
    check('右键菜单宿主 #ctx-menu 存在', bindDom.menu === true);
    check('window.__editor.binding 调试钩子已挂载', bindDom.hook === 'object');

    const BIND_GLB = arg(
      'bind',
      'assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb',
    );
    if (!fs.existsSync(path.resolve(BIND_GLB))) {
      skip('绑定面板载入 GLB', `绑定 GLB 不存在: ${BIND_GLB}`);
    } else {
      const openRes = await cdp.eval(`(async () => {
        window.__editor.binding.open(${JSON.stringify(BIND_GLB)});
        await new Promise((r) => setTimeout(r, 3500));
        const fc = document.querySelector('#binding-dock .bd-canvas[data-bd="front"]');
        const sc = document.querySelector('#binding-dock .bd-canvas[data-bd="side"]');
        return {
          open: window.__editor.binding.isOpen(),
          state: window.__editor.binding.state(),
          front: fc ? { w: fc.width, h: fc.height } : null,
          side: sc ? { w: sc.width, h: sc.height } : null,
          btns: document.querySelectorAll('#binding-dock .bd-btn').length,
          grip: document.querySelector('#binding-dock .bd-grip') !== null,
        };
      })()`);
      const p0 = openRes.state?.positions ?? {};
      check('绑定面板已打开（#binding-dock.open）', openRes.open === true);
      check(
        '模型已载入绑定面板',
        openRes.state?.loaded === true,
        `model=${String(openRes.state?.modelName)}`,
      );
      check(
        '27 个 HumanIK joint 全部就位（22 骨干 + 5 tip）',
        Object.keys(p0).length === 27,
        `joints=${Object.keys(p0).length}`,
      );
      check(
        '正/侧两个视图 canvas 有有效尺寸',
        openRes.front !== null && openRes.front.w > 0 && openRes.front.h > 0 &&
          openRes.side !== null && openRes.side.w > 0 && openRes.side.h > 0,
        `front=${JSON.stringify(openRes.front)} side=${JSON.stringify(openRes.side)}`,
      );
      check('面板按钮齐全（镜像×2 / 重置 / 应用 / 关闭）', openRes.btns >= 5, `btns=${openRes.btns}`);
      check('顶边拖拽把手 .bd-grip 存在（面板可下压露出 3D 视图）', openRes.grip === true);

      // UI/UX 重分组（docs/15 §3.1–3.6）：头部按语义分组、破坏性操作降级、
      // 半径双输入、帮助折叠、产出状态常驻徽标。DOM 结构断言，防止以后又被摊平。
      const uxRes = await cdp.eval(`(() => {
        const dock = document.getElementById('binding-dock');
        const groups = [...dock.querySelectorAll('.bd-head-group')];
        const badge = dock.querySelector('[data-bd="export-badge"]');
        const tip = dock.querySelector('[data-bd="tip"]');
        return {
          groups: groups.map((e) => e.getAttribute('data-group')),
          labelled: groups.filter((e) => e.querySelector('.bd-glabel') !== null).length,
          headViewportToggle: dock.querySelector('.bd-head [data-bd="skin-view3d"]') !== null,
          subViewportToggle: dock.querySelector('.bd-skin [data-bd="skin-view3d"]') !== null,
          radiusNums: dock.querySelectorAll('[data-bd="r-top-n"],[data-bd="r-medium-n"],[data-bd="r-bottom-n"]').length,
          danger: [...dock.querySelectorAll('.bd-btn.danger')].map((e) => e.getAttribute('data-bd')),
          tipHidden: tip === null ? null : tip.hidden,
          badge: badge === null ? null : { hidden: badge.hidden, text: badge.textContent.trim(), cls: badge.className },
        };
      })()`);
      check(
        '头部按语义分 5 组（编辑/镜像/姿态/产出/保存）',
        JSON.stringify(uxRes.groups) === JSON.stringify(['编辑', '镜像', '姿态', '产出', '保存']),
        `groups=${JSON.stringify(uxRes.groups)}`,
      );
      check('每个分组都有文字标签', uxRes.labelled === uxRes.groups.length, `labelled=${uxRes.labelled}/${uxRes.groups.length}`);
      check(
        '破坏性操作降级为 danger 次要样式（重置 / Detach）',
        JSON.stringify(uxRes.danger) === JSON.stringify(['reset', 'detach']),
        `danger=${JSON.stringify(uxRes.danger)}`,
      );
      check('「在 3D 视图显示包裹器」已提到头部（不再埋在 Skin 子面板）',
        uxRes.headViewportToggle === true && uxRes.subViewportToggle === false,
        `head=${uxRes.headViewportToggle} sub=${uxRes.subViewportToggle}`);
      check('半径三段都有数字输入框（滑块 + 数字框双向同步）', uxRes.radiusNums === 3, `nums=${uxRes.radiusNums}`);
      check('操作说明默认收起（不再 10 行常驻）', uxRes.tipHidden === true, `hidden=${uxRes.tipHidden}`);
      check(
        '载入后产出状态徽标常驻显示「● 未导出」',
        uxRes.badge !== null && uxRes.badge.hidden === false && uxRes.badge.text === '● 未导出',
        `badge=${JSON.stringify(uxRes.badge)}`,
      );

      // 头部「?」能展开/收起说明
      const helpRes = await cdp.eval(`(() => {
        const dock = document.getElementById('binding-dock');
        const btn = dock.querySelector('[data-bd="help"]');
        const tip = dock.querySelector('[data-bd="tip"]');
        btn.click();
        const afterOpen = tip.hidden;
        btn.click();
        return { afterOpen, afterClose: tip.hidden, aria: btn.getAttribute('aria-expanded') };
      })()`);
      check('头部「?」可展开操作说明', helpRes.afterOpen === false, `hidden=${helpRes.afterOpen}`);
      check('头部「?」可再次收起', helpRes.afterClose === true, `hidden=${helpRes.afterClose}`);
      check(
        '默认摆放是 T-pose（左臂水平：LeftHand 与 LeftArm 同高）',
        Number.isFinite(p0.LeftHand?.[1]) && Math.abs(p0.LeftHand[1] - p0.LeftArm[1]) < 1e-9,
        `LeftArm.y=${p0.LeftArm?.[1]} LeftHand.y=${p0.LeftHand?.[1]}`,
      );

      // ── 把左前臂+手整体下垂 45° 造出 A-pose，验证「骨长采纳 / ΔR 不入骨架」 ──
      const aPose = await cdp.eval(`(() => {
        const b = window.__editor.binding;
        const f0 = b.fit();
        const arm = b.state().positions.LeftArm;
        const fore = b.state().positions.LeftForeArm;
        const hand = b.state().positions.LeftHand;
        // tip 必须跟着手一起转：它是 LeftHand 的子骨，不转就成了「手腕转了、指尖没转」
        const handTip = b.state().positions.LeftHandTip;
        const r = (-45 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        const rot = (p) => {
          const x = p[0] - arm[0], y = p[1] - arm[1];
          return [arm[0] + x * c - y * s, arm[1] + x * s + y * c, p[2]];
        };
        b.pose('LeftForeArm', rot(fore));
        b.pose('LeftHand', rot(hand));
        b.pose('LeftHandTip', rot(handTip));
        const f1 = b.fit();
        const deg = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
        const rotErr = (m) => {
          let d = 0;
          for (let col = 0; col < 3; col++)
            for (let row = 0; row < 3; row++) d += Math.abs(m[col * 4 + row] - (col === row ? 1 : 0));
          return d;
        };
        return {
          len0: f0.lengths.LeftForeArm,
          len1: f1.lengths.LeftForeArm,
          degFore: deg(f1.poseRotations.LeftForeArm),
          degHand: deg(f1.poseRotations.LeftHand),
          degArm: deg(f1.poseRotations.LeftArm),
          tyArm: f1.tposePositions.LeftArm[1],
          tyFore: f1.tposePositions.LeftForeArm[1],
          tyHand: f1.tposePositions.LeftHand[1],
          maxRotErr: Math.max(...['Hips', 'LeftArm', 'LeftForeArm', 'LeftHand']
            .map((n) => rotErr(f1.tposeWorld[n]))),
        };
      })()`);
      check(
        'A-pose 下骨长仍是刚体不变量（采纳的只是长度）',
        Math.abs(aPose.len1 - aPose.len0) < 1e-9,
        `${aPose.len0?.toFixed(9)} → ${aPose.len1?.toFixed(9)}`,
      );
      check(
        '姿态偏移被如实记录（前臂 / 手各约 45°）',
        Math.abs(aPose.degFore - 45) < 0.5 && Math.abs(aPose.degHand - 45) < 0.5,
        `ForeArm=${aPose.degFore?.toFixed(2)}° Hand=${aPose.degHand?.toFixed(2)}°`,
      );
      check(
        '没被摆动的骨不带姿态偏移（LeftArm ≈ 0°）',
        Math.abs(aPose.degArm) < 1e-6,
        `LeftArm=${aPose.degArm?.toFixed(6)}°`,
      );
      check(
        '★ 重建的 T-pose 里左臂重新水平（ΔR 没被写进骨架）',
        Math.abs(aPose.tyFore - aPose.tyArm) < 1e-9 &&
          Math.abs(aPose.tyHand - aPose.tyFore) < 1e-9,
        `Arm.y=${aPose.tyArm?.toFixed(6)} ForeArm.y=${aPose.tyFore?.toFixed(6)} Hand.y=${aPose.tyHand?.toFixed(6)}`,
      );
      check(
        '★ T-pose 世界矩阵旋转部分 = 单位阵（ΔR 不进骨架）',
        aPose.maxRotErr < 1e-9,
        `maxRotErr=${aPose.maxRotErr?.toExponential(2)}`,
      );

      // ── Mirror：正视图里左右对称（x 取反），y/z 不动 ──
      const mir = await cdp.eval(`(() => {
        const b = window.__editor.binding;
        b.pose('LeftHand', [0.77, 1.42, 0.05]);
        // 手尖保持标准骨向（+X 0.10）：末端不跟着走就会被报成「离轴骨」
        b.pose('LeftHandTip', [0.87, 1.42, 0.05]);
        document.querySelector('#binding-dock .bd-btn[data-bd="mirror-lr"]').click();
        const st = b.state();
        return {
          left: st.positions.LeftHand,
          right: st.positions.RightHand,
          leftTip: st.positions.LeftHandTip,
          rightTip: st.positions.RightHandTip,
        };
      })()`);
      check(
        '镜像 L→R：右侧 = 左侧 x 取反，y/z 原样（tip 也一起镜像）',
        Math.abs(mir.right[0] + mir.left[0]) < 1e-9 &&
          Math.abs(mir.right[1] - mir.left[1]) < 1e-9 &&
          Math.abs(mir.right[2] - mir.left[2]) < 1e-9 &&
          Math.abs(mir.rightTip[0] + mir.leftTip[0]) < 1e-9 &&
          Math.abs(mir.rightTip[1] - mir.leftTip[1]) < 1e-9,
        `L=${JSON.stringify(mir.left)} R=${JSON.stringify(mir.right)} ` +
          `LTip=${JSON.stringify(mir.leftTip)} RTip=${JSON.stringify(mir.rightTip)}`,
      );

      // ── 镜像必须连 Skin Wrapper 半径一起翻（之前「skin wrapper 没法镜像」的真因）──
      const mirCyl = await cdp.eval(`(() => {
        const c = window.__editor.binding.wrappers.cylinders();
        return { l: c.LeftHand.radii, r: c.RightHand.radii };
      })()`);
      const rEq = (a, b) =>
        Math.abs(a.top - b.top) < 1e-9 &&
        Math.abs(a.medium - b.medium) < 1e-9 &&
        Math.abs(a.bottom - b.bottom) < 1e-9;
      check(
        '镜像 L→R：Skin Wrapper 半径一并镜像（RightHand 半径 == LeftHand）',
        rEq(mirCyl.l, mirCyl.r),
        `L=${JSON.stringify(mirCyl.l)} R=${JSON.stringify(mirCyl.r)}`,
      );

      // ── 反解导出（dryRun：只算不下载）──
      const exp = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const stats = await b.dryRun();
        const statsHtml = document.querySelector('#binding-dock [data-bd="stats"]');
        return { stats, state: b.state(), statsHtml: statsHtml ? statsHtml.innerHTML : '' };
      })()`);
      const es = exp.stats;
      check('导出 GLB 非空', es !== null && es !== undefined && es.bytes > 0, `bytes=${es?.bytes}`);
      check('导出含 27 根骨', es?.bones === 27, `bones=${es?.bones}`);
      check('无零权重顶点（兜底生效）', es?.zeroWeightVerts === 0, `zero=${es?.zeroWeightVerts}`);
      // 末端可控的关键证据：Head / Hand / ToeBase 原本是叶子（胶囊退化成点），
      // 加了 tip 之后它们的胶囊才拿到长度 —— 断言这三个骨长 > 0。
      const tips = await cdp.eval(`(() => {
        const st = window.__editor.binding.state();
        const p = st && st.positions;
        if (!p) return null;
        const d = (a, b) => Math.hypot(p[b][0]-p[a][0], p[b][1]-p[a][1], p[b][2]-p[a][2]);
        return {
          hasTips: ['HeadTip','LeftHandTip','RightHandTip','LeftToeTip','RightToeTip']
            .every(n => !!p[n]),
          headLen: +d('Head','HeadTip').toFixed(4),
          handLen: +d('LeftHand','LeftHandTip').toFixed(4),
          toeLen: +d('LeftToeBase','LeftToeTip').toFixed(4),
          handTipIsLeafBeyondHand:
            Math.abs(p['LeftHandTip'][1] - p['LeftHand'][1]) < 0.35,
        };
      })()`);
      check('★ 5 个 tip 节点都在骨架里', tips?.hasTips === true, JSON.stringify(tips));
      check(
        '★ tip 让末端骨段拿到长度（Head→HeadTip / Hand→HandTip / ToeBase→ToeTip 均 > 0）',
        tips !== null && tips.headLen > 0 && tips.handLen > 0 && tips.toeLen > 0,
        `head=${tips?.headLen} hand=${tips?.handLen} toe=${tips?.toeLen}`,
      );
      // 「tip 不参与 skin 计算」的硬证据：导出的权重里 tip 总权重必须为 0
      check(
        '★ tip 权重恒为 0（不参与 skin 计算）',
        es?.tipWeightSum === 0 && es?.tipRefVerts === 0,
        `tipWeightSum=${es?.tipWeightSum} tipRefVerts=${es?.tipRefVerts}`,
      );
      // 「tip 权重恒 0」与「半径表无 tip」分别在 L2 / L2d 段断言
      // （那里已经切到蒙皮模式，半径表才初始化出来）。
      check(
        '反解是刚体变换，身高不跳变',
        es !== null && es !== undefined && Math.abs(es.heightAfter - es.heightBefore) < 0.35,
        `height ${es?.heightBefore?.toFixed(3)} → ${es?.heightAfter?.toFixed(3)} m`,
      );
      check(
        '统计如实报出「离轴骨」= 被摆动的那两根（tip 已随手走，不该再报）',
        Array.isArray(es?.offAxisBones) && es.offAxisBones.length === 2,
        `offAxis=${JSON.stringify(es?.offAxisBones)}`,
      );
      // 「绑定是动词」铁律：导出只回灌**网格**，骨架姿势原地不动，绝不跳回 T-pose。
      // ΔR 清零看的是导出出去的那份骨架（fit.tposePositions），
      // 上面「★ 重建的 T-pose 里左臂重新水平」已经断言过，这里守的是姿势不被改写。
      check(
        '★ 导出后摆放姿势原地不动（绑完骨架姿势即定，绝不跳回 T-pose）',
        Math.abs(exp.state.positions.LeftHand[1] - mir.left[1]) < 1e-9 &&
          Math.abs(exp.state.positions.LeftHandTip[1] - mir.left[1]) < 1e-9,
        `Hand.y=${exp.state.positions.LeftHand[1]?.toFixed(6)} ` +
          `Tip.y=${exp.state.positions.LeftHandTip[1]?.toFixed(6)}（应保持摆放值 ${mir.left[1]}）`,
      );
      check(
        '面板统计区仍是当前模型（导出流程没把它清空）',
        /顶点/.test(exp.statsHtml) && /面/.test(exp.statsHtml),
        exp.statsHtml,
      );

      // ---- L. 动画应用（BVH 重定向 → 烘焙进 GLB / 挂到场景里已绑定的模型）----
      //
      // 这一段守的是用户的定性要求：「通用、Generic 的绑定和动画应用系统」。
      // 夹具是入库的 A-pose 合成 BVH（armDeg=45），同源的 T-pose 版在单元测试里对照。
      // 浏览器端要证的就一件事：A-pose 源的 45° rest 偏移被消掉，且整条链路不炸。
      console.log('\nL. 动画应用（BVH 重定向）');
      const APOSE_BVH = 'assets/characters/_tools/sample_apose_arm45.bvh';
      const bvhText = fs.readFileSync(path.resolve(APOSE_BVH), 'utf8');

      const animHook = await cdp.eval(`(() => typeof window.__editor.anim)()`);
      check('window.__editor.anim 调试钩子已挂载', animHook === 'object', animHook);

      const rt = await cdp.eval(`(() => {
        const a = window.__editor.anim;
        const r = a.load(${JSON.stringify(bvhText)}, 'smoke_apose');
        const el = document.querySelector('#binding-dock [data-bd="anim"]');
        return { r, info: a.info(), html: el ? el.innerText : '' };
      })()`);
      check(
        '★ A-pose 源的重定向：最大对齐角 = 45°（rest 偏移被识别出来）',
        rt.r !== null && Math.abs(rt.r.maxAlignAngleDeg - 45) < 0.01,
        `maxAlign=${rt.r?.maxAlignAngleDeg?.toFixed(4)}°`,
      );
      check(
        '22 根骨全映射、无缺骨、无未匹配',
        rt.r?.mapped?.length === 22 &&
          rt.r?.missingBones?.length === 0 &&
          rt.r?.unmatchedBvh?.length === 0,
        `mapped=${rt.r?.mapped?.length} missing=${JSON.stringify(rt.r?.missingBones)}`,
      );
      check(
        '片段信息：5 帧 / 22 骨 / 带根位移',
        rt.info?.frames === 5 && rt.info?.bones === 22 && rt.info?.hasRoot === true,
        JSON.stringify(rt.info),
      );
      check(
        '面板 .bd-anim 诊断区写出片段名与对齐角',
        /smoke_apose/.test(rt.html) && /45\.00/.test(rt.html),
        rt.html.replace(/\n/g, ' | ').slice(0, 160),
      );

      const baked = await cdp.eval(`(async () => {
        const st = await window.__editor.anim.exportDryRun();
        return st;
      })()`);
      check(
        '★ 带动画导出：23 条轨道（22 rotation + 1 根位移）',
        baked?.animChannels === 23 && baked?.animClips?.[0] === 'smoke_apose',
        `channels=${baked?.animChannels} clips=${JSON.stringify(baked?.animClips)}`,
      );

      // ── 挂到场景里一个**已绑定的外部模型**上（不是绑定面板刚做出来的那个）──
      const absRigged = path.resolve(RIGGED_GLB);
      if (!fs.existsSync(absRigged)) {
        skip('动画挂到场景物体', `rigged GLB 不存在: ${RIGGED_GLB}`);
        skip('场景物体的片段数/播放状态', `同上`);
      } else {
        const applied = await cdp.eval(`(async () => {
          const a = window.__editor.anim;
          const renderer = window.__editor.renderer;
          window.__editor.spawnAsset(${JSON.stringify(RIGGED_GLB)}, [-1.5, 0, 0]);
          await new Promise((r) => setTimeout(r, 4000));
          const list = renderer.getObjectList();
          const idx = list.length - 1;
          // 诊断：直接扫 state.objects，看 E04 物体到底在不在、有没有骨架
          const objs = renderer.state.objects.map((o, i) => ({
            i,
            name: o.name,
            hasSkel: o.skeleton !== null,
            joints: o.skeleton ? o.skeleton.jointNames.filter((n) => n !== null).length : 0,
            isE04: /E04/.test(o.name),
          }));
          const e04 = objs.filter((o) => o.isE04);
          // getObjectList 的下标和 state.objects 不一定对齐（层级树可能不数某个槽位），
          // 所以按名字在 state.objects 里定位真实下标，避免挂错物体。
          const realIdx = e04.length > 0 ? e04[0].i : idx;
          const r = a.applyTo(realIdx, ${JSON.stringify(bvhText)}, 'smoke_apose');
          return {
            idx,
            realIdx,
            n: list.length,
            objs,
            e04,
            r,
            clips: a.objectClips(realIdx),
            info: (document.getElementById('model-info') || {}).innerText || '',
          };
        })()`);
        check(
          '★ 重定向后的动画挂到场景里已绑定的模型上',
          applied.r !== null && applied.r !== undefined,
          `obj#${applied.realIdx} report=${applied.r === null ? 'null' : 'ok'} info="${String(applied.info).slice(0, 120)}"`,
        );
        check(
          '★ 23 条轨道落到目标骨架上且自动开始播放',
          applied.clips?.tracks === 23 &&
            applied.clips?.playing === true &&
            applied.clips?.clip >= 0,
          JSON.stringify(applied.clips),
        );
      }

      // ---- L2. Skin Wrapper 包裹器圆柱体在主 3D 视口可见 ----
      //
      // 守的是用户的定性要求：「模型每个 joint 上应当显示一个圆柱形状的皮肤权重包裹器」。
      // 几何由 binding 模块按**实时关节矩阵**算，再交给引擎的半透明 X-ray 管线画。
      // 这里要证的是渲染链路真的通 —— WGSL 编译错误 / usage 错配只在运行时暴露，
      // tsc 与 vite build 全绿也查不出来。
      console.log('\nL2. Skin Wrapper 圆柱体（主 3D 视口）');
      // 帧等待辅助（本段及其后所有 L2x 共用）：等页面里真实的 RAF 帧，不是墙钟
      // sleep —— 窗口被遮挡时 RAF 会被节流，sleep(600) 可能一帧都没过去（叠加层
      // 顶点缓冲还没上传就被采样 → verts=0 的假 FAIL，2026-09-22 PR #8 复审期复现）。
      const nFrames = (n) =>
        `new Promise((r) => { let k = 0; const step = () => (++k >= ${n} ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); })`;

      // L 段的 applyTo 会同步打开重定向工作台：右侧 720px 覆盖式 dock（z-index 45），
      // 恰好压住主视口右半 + 底部绑定面板的 3D 画布。不关掉它，后面所有
      // 基于 Page.captureScreenshot 的采样（L2f 主视口像素 / L2c 面板 3D 健康度）
      // 采到的都是工作台内容 —— 决定性假 FAIL（2026-09-22 排查：三次复跑的
      // 「avg 27.416→27.416 / side mid=0.023」截图里全是工作台 UI）。
      // L 段对工作台的断言已全部走 hook 完成，这里显式退出，恢复采样视野。
      const rwClosed = await cdp.eval(`(() => {
        const dock = document.getElementById('retarget-dock');
        if (dock === null || !dock.classList.contains('open')) return 'not-open';
        const btn = [...dock.querySelectorAll('button')].find((b) => b.textContent === '退出');
        if (btn === undefined) return 'no-button';
        btn.click();
        return dock.classList.contains('open') ? 'still-open' : 'closed';
      })()`);
      check('重定向工作台已退出（不遮挡后续像素采样）', rwClosed !== 'still-open' && rwClosed !== 'no-button', rwClosed);

      // 主视口包裹器叠加层每帧从「当前选中物体」的实时关节矩阵重建（main.ts 帧循环）。
      // L 段 applyTo 后该物体正在自动播放 smoke_apose（0.167s 循环）—— 叠加层随动画
      // 持续漂移，L2e 的「对照组 vs 真改」Δsum 比较就会变成抛硬币（漂移 >> 半径变化的
      // 净效应，因为 Σ|coord| 对径向膨胀大面积抵消）。后续 L2e/L2f/L2c 都需要静止场景。
      const paused = await cdp.eval(`(() => {
        window.__editor.renderer.pauseAnimation();
        return true;
      })()`);
      check('已暂停叠加层取数源的动画播放（后续采样需要静止场景）', paused === true);

      // 先切到「蒙皮包裹」模式：每 joint 的默认 wrapper 半径表是**惰性**初始化的，
      // 未进 skin 模式时 getCylinders() 为 null，3D 视口退回「骨长×0.35」默认半径。
      // 这里显式切模式，才能验证「面板半径 → 3D 几何」这条链路而不仅是默认值。
      const skinMode = await cdp.eval(`(() => {
        const b = document.querySelector('[data-bd="mode-skin"]');
        if (b) b.click();
        return !!b;
      })()`);
      check('可切到「蒙皮包裹 skin」编辑模式', skinMode === true);

      const wrapOn = await cdp.eval(`(() => window.__editor.binding.wrappers.set(true))()`);
      check('3D 视口包裹器开关可打开', wrapOn === true, `set→${wrapOn}`);
      // 叠加层顶点缓冲是帧驱动上传的：轮询到 verts>0 再采样（上限 ~120 帧 ≈ 2s），
      // 把「上传还没发生」与「管线真坏了」区分开。
      const wrap = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        let tries = 0;
        while (b.wrappers.verts() === 0 && tries < 120) { await ${nFrames(1)}; tries++; }
        return {
          on: b.wrappers.get(),
          verts: b.wrappers.verts(),
          cyls: Object.keys(b.wrappers.cylinders() || {}).length,
          tries,
        };
      })()`);
      check(
        '★ 圆柱体几何已产出并送进管线（顶点数 > 0）',
        wrap.verts > 0,
        JSON.stringify(wrap),
      );
      check(
        '★ 顶点数是 stride 9 的整数倍（pos+nrm+col 交错，stride 36B）',
        wrap.verts > 0 && wrap.verts % 9 === 0,
        `verts=${wrap.verts}`,
      );
      // 几何静止门禁（2026-09-23 L2e 假 FAIL 根治）：verts>0 只证明「画上了」，
      // 不证明「settle 完了」——开启包裹层/skin 模式后的首几帧几何还在从过渡态
      // 收敛到半径表驱动的稳态（实测首样本 11324.57 → 稳态 11821.74），c0 落在
      // 收敛窗里就会把「同值写入对照组」污染成 Δ497。轮询到连续两次采样逐位相等
      // （静止场景下重建是确定性的）再进 L2d/L2e。
      const settle = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        let prev = -1;
        let stable = 0;
        let tries = 0;
        while (tries < 120) {
          const s = b.wrappers.stats()?.sum ?? -1;
          if (s === prev && s >= 0) { stable++; if (stable >= 2) break; } else { stable = 0; }
          prev = s;
          await ${nFrames(2)};
          tries++;
        }
        return { settled: stable >= 2, tries, sum: prev };
      })()`);
      check(
        '★ 包裹器几何已静止（连续采样逐位相等，排除 settle 窗口污染）',
        settle.settled === true,
        JSON.stringify(settle),
      );
      check('包裹器半径表非空（每 joint 一个 wrapper）', wrap.cyls > 0, `cyls=${wrap.cyls}`);

      // ---- L2d. tip（尖端）骨的三条硬约束 ----
      //
      // tip 存在的意义：Head / Hand / ToeBase 原本是叶子，影响胶囊退化成点 → 末端
      // 外形与旋转无法控制。补上 tip 后它们的胶囊才拿到长度。但 tip 自己必须满足：
      //   ① 不产生 wrapper mesh / skin wrapper；② 不参与 skin 计算。
      // 这里断言的正是「该有的有、不该有的没有」。
      console.log('\nL2d. tip（尖端）骨约束');
      const tipWrap = await cdp.eval(`(() => {
        const c = window.__editor.binding.wrappers.cylinders() || {};
        return {
          total: Object.keys(c).length,
          tipKeys: Object.keys(c).filter((k) => /Tip$/.test(k)),
        };
      })()`);
      check(
        '★ 半径表里没有 tip（不产生 skin wrapper）',
        tipWrap.tipKeys.length === 0,
        `total=${tipWrap.total} tipKeys=${JSON.stringify(tipWrap.tipKeys)}`,
      );
      check(
        '★ 22 骨干各有 wrapper（tip 只是让它们拿到长度，不是替换）',
        tipWrap.total === 22,
        `total=${tipWrap.total}`,
      );

      // ---- L2e. 改半径 → 几何必须真的变（「拖了滑块没反应」的回归闸门）----
      //
      // 顶点数看不出半径变化（改半径不增不减顶点），所以判据是几何指纹
      // `sum`（顶点坐标绝对值之和）：圆柱一粗一细它就得动。
      // 主 3D 视口与面板正/侧视两条路径都要验 —— 它们用不同的输入
      // （实时关节矩阵 vs boneSegments），一条通了不代表另一条通。
      console.log('\nL2e. 改半径 → 几何真的变');
      const rad = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const wait = () => ${nFrames(4)};
        const snap = () => ({ vp: b.wrappers.stats(), v3d: b.view3d() });
        const src = b.wrappers.cylinders().LeftArm;
        const orig = { ...src.radii };
        const set3 = (v) => ['top', 'medium', 'bottom'].forEach((s) => b.wrappers.setRadius('LeftArm', s, v));

        // 诊断预采样（2026-09-23 假 FAIL 定位）：c0 之前空采 3 组，区分
        // 「c0 采样太早（前置 settle 未完成）」与「同值写入真让几何漂移」
        const pre = [];
        for (let i = 0; i < 3; i++) { pre.push(b.wrappers.stats()?.sum ?? -1); await wait(); }

        // 对照组：写入**同一个值**（半径没变，但 refresh() 照样跑一遍）
        // → 量出「刷新副作用」本身带来的几何漂移，真变化必须显著大于它
        const c0 = snap();
        set3(orig.top);
        await wait();
        const c1 = snap();

        const before = snap();
        const ok = ['top', 'medium', 'bottom']
          .every((s) => b.wrappers.setRadius('LeftArm', s, 0.55));
        await wait();
        const after = snap();
        // 还原，再验一次「改回去也得变回去」
        set3(orig.top);
        await wait();
        const restored = snap();
        const playing = window.__editor.renderer.isAnimationPlaying?.() ?? null;
        return { ok, pre, c0, c1, before, after, restored, orig, playing };
      })()`);
      const sum = (s) => s?.vp?.sum ?? 0;
      console.log(`  诊断预采样: pre=[${(rad.pre ?? []).map((v) => v.toFixed(2)).join(', ')}] playing=${rad.playing}`);
      const dCtrlVp = Math.abs(sum(rad.c1) - sum(rad.c0));
      const dVp = Math.abs(sum(rad.after) - sum(rad.before));
      const dFront = Math.abs((rad.after?.v3d?.frontCylSum ?? 0) - (rad.before?.v3d?.frontCylSum ?? 0));
      const dSide = Math.abs((rad.after?.v3d?.sideCylSum ?? 0) - (rad.before?.v3d?.sideCylSum ?? 0));
      const backVp = Math.abs(sum(rad.restored) - sum(rad.before));
      check(
        '★ 改半径真的写进半径表（setRadius 返回 true）',
        rad.ok === true,
        `ok=${rad.ok} orig=${JSON.stringify(rad.orig)}`,
      );
      console.log(
        `  诊断：对照组（写入同值）Δsum=${dCtrlVp.toFixed(4)} · 真改半径 Δsum=${dVp.toFixed(4)}` +
          ` · 主视口 sum ${sum(rad.before).toFixed(2)} → ${sum(rad.after).toFixed(2)}` +
          ` · verts ${rad.before?.vp?.verts} → ${rad.after?.vp?.verts}` +
          ` · bboxMin ${JSON.stringify(rad.before?.vp?.min)} → ${JSON.stringify(rad.after?.vp?.min)}` +
          ` · bboxMax ${JSON.stringify(rad.before?.vp?.max)} → ${JSON.stringify(rad.after?.vp?.max)}` +
          ` · first ${JSON.stringify(rad.before?.vp?.first)} → ${JSON.stringify(rad.after?.vp?.first)}`,
      );
      check(
        '★ 主 3D 视口：改半径后圆柱体几何变了（且远大于刷新副作用）',
        dVp > 1e-3 && dVp > dCtrlVp * 10,
        `Δsum=${dVp.toFixed(4)} vs 对照组 ${dCtrlVp.toFixed(4)}`,
      );
      check(
        '★ 面板正视：改半径后圆柱体几何变了',
        dFront > 1e-3,
        `Δsum=${dFront.toFixed(4)}（${rad.before?.v3d?.frontCylSum?.toFixed(2)} → ${rad.after?.v3d?.frontCylSum?.toFixed(2)}）`,
      );
      check(
        '★ 面板侧视：改半径后圆柱体几何变了',
        dSide > 1e-3,
        `Δsum=${dSide.toFixed(4)}（${rad.before?.v3d?.sideCylSum?.toFixed(2)} → ${rad.after?.v3d?.sideCylSum?.toFixed(2)}）`,
      );
      check(
        '★ 改回原值后几何回到基线（不是单向漂移）',
        backVp < 1e-6,
        `Δsum=${backVp.toExponential(2)}`,
      );

      // ---- L2g. 在视图里直接拖圆柱体 = 改半径（拖了要有反应） ----
      //
      // 蒙皮模式下 pointerdown 只做点选、拖动没有任何行为 —— 用户「在视图里调整
      // 这些圆柱体」却看不到变化，根因就在这。现在语义是：
      //   半径 = 指针到骨轴的垂距（米）
      // 这里用合成 PointerEvent 走真实的事件链（不是绕过 UI 直接调 API），
      // 才能同时证明「点得到」和「拖得动」。
      console.log('\nL2g. 视图里拖圆柱体 = 改半径');
      const drag = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const c = document.querySelector('[data-bd="front"]');
        const w = c.clientWidth, h = c.clientHeight;
        // ① 扫格子找「包裹器**边缘**」的点（不硬编码坐标，换模型也不会失效）。
        //
        //    ⚠️ 不能取第一个命中点就收工：命中判定用的是到**子段**的距离，
        //    骨端帽上方、贴着骨轴延长线的点也会命中，但它到骨轴的垂距可能只有
        //    2~3px，小于 rPx×0.45 → 被判成「抓核心 = 沿轴移动偏移」，改不了半径。
        //    本断言验的是「拖边缘 = 改半径」，所以取**垂距最大**的命中点。
        const axisCache = {};
        const axisOf = (bn) => {
          if (axisCache[bn] === undefined) axisCache[bn] = b.wrappers.axis(bn, 'front');
          return axisCache[bn];
        };
        const perpDist = (px, py, sg) => (sg === null ? -1
          : Math.abs((px - sg.a[0]) * (sg.b[1] - sg.a[1]) - (py - sg.a[1]) * (sg.b[0] - sg.a[0]))
            / (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) || 1));
        let hit = null;
        let at = null;
        let bestDr = -1;
        for (let y = Math.round(h * 0.2); y < h * 0.8; y += 4) {
          for (let x = Math.round(w * 0.2); x < w * 0.8; x += 4) {
            const p = b.wrappers.pick('front', x, y);
            if (p === null) continue;
            const dr = perpDist(x, y, axisOf(p.bone));
            if (dr > bestDr) { bestDr = dr; hit = p; at = { x, y }; }
          }
        }
        if (hit === null) return { found: false };
        const before = { ...b.wrappers.cylinders()[hit.bone].radii };
        // ② 按下 → 沿**垂直于骨轴**的方向拖 60px → 松开。
        //    半径 = 指针到骨轴的垂距，沿轴方向拖垂距不变、半径**本就不该动**；
        //    Head 的骨轴在正视里恰好垂直，固定「向下 60px」会取到退化方向，
        //    于是看起来像「拖动没反应」，实际是断言拖错了方向。
        const seg = axisOf(hit.bone);
        let dx = 0;
        let dy = 60;
        if (seg !== null) {
          const ax = seg.b[0] - seg.a[0];
          const ay = seg.b[1] - seg.a[1];
          const L = Math.hypot(ax, ay) || 1;
          let nx = -ay / L;
          let ny = ax / L;
          // 朝**远离**骨轴的那一侧拖，保证垂距一定变大（半径 = 垂距）
          if ((at.x - seg.a[0]) * nx + (at.y - seg.a[1]) * ny < 0) { nx = -nx; ny = -ny; }
          dx = Math.round(nx * 60);
          dy = Math.round(ny * 60);
        }
        const cylOf = () => b.wrappers.cylinders()[hit.bone];
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
          clientX: c.getBoundingClientRect().left + x,
          clientY: c.getBoundingClientRect().top + y,
          bubbles: true, pointerId: 1, isPrimary: true,
        }));
        ev('pointerdown', at.x, at.y);
        ev('pointermove', at.x + dx, at.y + dy);
        await ${nFrames(2)};
        const after = { ...cylOf().radii };
        ev('pointerup', at.x + dx, at.y + dy);
        // ③ 还原，别把半径留在奇怪的值上
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(hit.bone, s, before[s]);
        return {
          found: true, hit, before, after, dir: { dx, dy },
          moved: Math.abs(after[hit.seg] - before[hit.seg]),
          hitDrPx: bestDr,
        };
      })()`);
      check(
        '★ 视图里能点中圆柱体子段（点选判定没坏）',
        drag.found === true,
        JSON.stringify(drag.hit ?? null),
      );
      check(
        '★ 在视图里拖圆柱体 = 改半径（拖动真的有反应）',
        drag.found === true && drag.moved > 0.01,
        `${drag.hit?.bone}.${drag.hit?.seg} ${drag.before?.[drag.hit?.seg]?.toFixed(3)} → ` +
          `${drag.after?.[drag.hit?.seg]?.toFixed(3)} · 拖动方向 ${JSON.stringify(drag.dir)} · ` +
          `off ${JSON.stringify(drag.offBefore)} → ${JSON.stringify(drag.offAfter)} · ` +
          `起点垂距 ${drag.hitDrPx?.toFixed(1)}px`,
      );
      check(
        '★ 只改点中的那一段，另两段不动',
        drag.found === true &&
          ['top', 'medium', 'bottom']
            .filter((s) => s !== drag.hit.seg)
            .every((s) => Math.abs(drag.after[s] - drag.before[s]) < 1e-9),
        JSON.stringify(drag.after ?? null),
      );

      // ---- L2h. 侧边栏滑块（真实 DOM 路径）→ 半径真的改，且不被自动算法覆盖 ----
      //
      // L2e / L2g 走的是自动化钩子与合成 pointer，**从没碰过那三个 range 滑块本身**。
      // 用户报的正是「在侧边栏拖 top / bottom 没反应」—— 只有走真实 DOM 事件链
      // （改 value + 派发 input）才能证明这条路径没断。
      //
      // 另一半是「自动算法 override 手动值」：拖 joint 会改骨长，而默认半径
      // r = clamp(骨长 × 0.35, 0.04, 0.22) 正是骨长的函数 —— 手动值一旦被它
      // 重算覆盖，表现就是「拖 joint 包裹器自己变大变小，手动调的却总是不见」。
      console.log('\nL2h. 侧边栏滑块 与「自动半径不覆盖手动值」');
      const sl = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const wait = () => ${nFrames(4)};
        b.setMode('skin');
        await wait();
        // ① 在视图里点中一段，让侧边栏出现可编辑的圆柱体
        const c = document.querySelector('[data-bd="front"]');
        const w = c.clientWidth, h = c.clientHeight;
        let hit = null, at = null;
        for (let y = Math.round(h * 0.2); y < h * 0.8 && hit === null; y += 6) {
          for (let x = Math.round(w * 0.2); x < w * 0.8; x += 6) {
            const p = b.wrappers.pick('front', x, y);
            if (p !== null) { hit = p; at = { x, y }; break; }
          }
        }
        if (hit === null) return { found: false };
        const rect = c.getBoundingClientRect();
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
          clientX: rect.left + x, clientY: rect.top + y,
          bubbles: true, pointerId: 1, isPrimary: true,
        }));
        ev('pointerdown', at.x, at.y);
        ev('pointerup', at.x, at.y);
        await wait();

        // ② 真实 DOM 滑块路径：改 value + 派发 input
        const el = document.querySelector('#binding-dock [data-bd="r-top"]');
        if (el === null) return { found: true, noSlider: true, hit };
        const domBefore = el.value;
        const rBefore = { ...b.wrappers.cylinders()[hit.bone].radii };
        const v3Before = b.view3d();
        el.value = '0.3';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait();
        const domAfter = document.querySelector('#binding-dock [data-bd="r-top"]').value;
        const rAfter = { ...b.wrappers.cylinders()[hit.bone].radii };
        const v3After = b.view3d();

        // ③ 自动半径会不会覆盖手动值？拖 joint 改骨长（默认半径 r = 骨长×0.35
        //    正是骨长的函数），再看手动值还在不在
        const p0 = b.state().positions[hit.bone];
        b.pose(hit.bone, [p0[0] + 0.06, p0[1] + 0.06, p0[2]]);
        await wait();
        const rAfterDrag = { ...b.wrappers.cylinders()[hit.bone].radii };

        // ④ 模式往返（skin → skeleton → skin）后手动值还在不在
        b.setMode('skeleton');
        await wait();
        b.setMode('skin');
        await wait();
        const rAfterRoundTrip = { ...b.wrappers.cylinders()[hit.bone].radii };

        // ⑤ 关节模式下 3D 层也必须吃半径表（之前传 null → 回退成骨长×0.35 自动半径，
        //    正是「拖 joint 包裹器自己变大变小、侧边栏调的看不到」的根因）
        b.setMode('skeleton');
        await wait();
        const skBefore = b.view3d().frontCylSum;
        b.wrappers.setRadius(hit.bone, 'top', 0.45);
        await wait();
        const skAfter = b.view3d().frontCylSum;
        b.setMode('skin');
        await wait();
        const sknSum = b.view3d().frontCylSum;

        // ⑥ 自动适配（显式按钮）只碰未手动改过的骨：
        //    手动骨在 ⑤ 已被设成 top=0.45 且 manual=true；另取一根**非手动**骨
        //    RightArm，把其子骨 RightForeArm 大幅挪开使骨长变化，autofit 后它的半径
        //    必须等于公式值 clamp(骨长×0.35, 0.04, 0.22)；手动骨绝不被动。
        const other = 'RightArm';
        const otherChild = 'RightForeArm';
        const headTopBefore = b.wrappers.cylinders()[hit.bone].radii.top;
        const otherOrig = { ...b.wrappers.cylinders()[other].radii };
        const op = b.state().positions[otherChild];
        b.pose(otherChild, [op[0] + 0.3, op[1] + 0.3, op[2]]);
        await wait();
        const autoBtn = document.querySelector('#binding-dock [data-bd="cyl-autofit"]');
        const autoBtnFound = autoBtn !== null;
        const lfBefore = b.state().positions[otherChild];
        if (autoBtn !== null) autoBtn.click();
        // autofit 是同步写入：click() 返回前 this.cylinders 已原地改好（引用不变），
        // 立即读就是 autofit 的真实产出。去掉原本夹在 click 与读取之间的 await wait()，
        // 避免 4 帧等待引入的非确定性（渲染/帧回调不会写半径，无需等帧）。
        const oRadiiImmediate = b.wrappers.cylinders()[other].radii.top;
        const posImmediate = b.state().positions[otherChild];
        // ⚠️ 必须快照副本，不能存引用：下面「还原」段的 setRadius 是原地改写，
        //    存引用会在 return 序列化时读到还原后的旧值（假红，2026-09-22 踩过）
        const oRadii = { ...b.wrappers.cylinders()[other].radii };
        // 持久性：再等几帧，确认没有任何渲染/帧回调把半径写回默认值
        await wait();
        const oRadiiPersist = b.wrappers.cylinders()[other].radii.top;
        const oManual = b.wrappers.cylinders()[other].manual === true;
        const pa = b.state().positions[other];
        const pb = b.state().positions[otherChild];
        const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        const expR = Math.min(0.22, Math.max(0.04, len * 0.35));
        const headTopAfter = b.wrappers.cylinders()[hit.bone].radii.top;

        // 还原（关节 + 手动骨 + 自动骨都回到测试前）
        b.pose(otherChild, op);
        b.pose(hit.bone, p0);
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(hit.bone, s, rBefore[s]);
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(other, s, otherOrig[s]);
        await wait();
        return {
          found: true, hit, domBefore, domAfter,
          rBefore, rAfter, rAfterDrag, rAfterRoundTrip,
          v3Before, v3After,
          spanText: document.querySelector('#binding-dock [data-bd="r-top-v"]').textContent,
          skBefore, skAfter, sknSum,
          oRadii, expR, headTopBefore, headTopAfter,
          autoBtnFound, oManual, lfBefore,
          oRadiiImmediate: (typeof oRadiiImmediate !== 'undefined') ? oRadiiImmediate : undefined,
          oRadiiPersist: (typeof oRadiiPersist !== 'undefined') ? oRadiiPersist : undefined,
          posImmediate: (typeof posImmediate !== 'undefined') ? posImmediate : undefined,
        };
      })()`);
      check(
        '★ 点中圆柱体后侧边栏滑块就位（可编辑）',
        sl.found === true && sl.noSlider !== true,
        JSON.stringify({ hit: sl.hit ?? null, noSlider: sl.noSlider ?? false }),
      );
      check(
        '★ 拖侧边栏滑块 → 半径表真的改了（真实 DOM input 事件路径）',
        sl.found === true && Math.abs((sl.rAfter?.top ?? 0) - 0.3) < 1e-6,
        `r-top ${sl.domBefore} → ${sl.domAfter} · radii.top ${sl.rBefore?.top} → ${sl.rAfter?.top}`,
      );
      check(
        '★ 拖侧边栏滑块 → 面板 3D 视图几何跟着变（不是只改了数字）',
        sl.found === true &&
          Math.abs((sl.v3After?.frontCylSum ?? 0) - (sl.v3Before?.frontCylSum ?? 0)) > 1e-3,
        `ΔfrontSum=${Math.abs((sl.v3After?.frontCylSum ?? 0) - (sl.v3Before?.frontCylSum ?? 0)).toFixed(4)}`,
      );
      check(
        '★ 滑块位置不被回弹覆盖（改完 value 仍是新值，没被自动刷新写回旧值）',
        sl.found === true && Math.abs(Number(sl.domAfter) - 0.3) < 1e-6,
        `domAfter=${sl.domAfter} span=${sl.spanText}`,
      );
      check(
        '★ 拖 joint 改骨长后，手动半径不被自动算法覆盖（r 仍是 0.3）',
        sl.found === true && Math.abs((sl.rAfterDrag?.top ?? 0) - 0.3) < 1e-9,
        `radii=${JSON.stringify(sl.rAfterDrag ?? null)}`,
      );
      check(
        '★ skin → skeleton → skin 往返后手动半径仍在',
        sl.found === true && Math.abs((sl.rAfterRoundTrip?.top ?? 0) - 0.3) < 1e-9,
        `radii=${JSON.stringify(sl.rAfterRoundTrip ?? null)}`,
      );
      check(
        '★ 关节模式也吃半径表（不在该模式用 null 回退成自动半径）',
        sl.found === true && Math.abs(sl.skAfter - sl.skBefore) > 1e-3,
        `ΔfrontSum(skeleton 模式)=${Math.abs((sl.skAfter ?? 0) - (sl.skBefore ?? 0)).toFixed(4)}`,
      );
      check(
        '★ 关节模式与蒙皮模式的几何一致（同一个半径表，不再两套真源）',
        sl.found === true && Math.abs((sl.sknSum ?? 0) - (sl.skAfter ?? 0)) < 1e-6,
        `skn=${sl.sknSum?.toFixed(3)} sk=${sl.skAfter?.toFixed(3)}`,
      );
      check(
        '★ 自动适配只重算非手动骨：手动骨（⑤ 置的 top）一点没动',
        sl.found === true && Math.abs((sl.headTopAfter ?? 0) - (sl.headTopBefore ?? 0)) < 1e-9,
        `headTop ${sl.headTopBefore} → ${sl.headTopAfter}`,
      );
      check(
        '★ 自动适配把非手动骨重算成公式值 clamp(骨长×0.35, 0.04, 0.22)',
        sl.found === true &&
          Math.abs((sl.oRadii?.top ?? 0) - sl.expR) < 1e-9 &&
          Math.abs((sl.oRadii?.medium ?? 0) - sl.expR) < 1e-9 &&
          Math.abs((sl.oRadii?.bottom ?? 0) - sl.expR) < 1e-9,
        `LeftArm=${JSON.stringify(sl.oRadii)} 预期=${sl.expR?.toFixed(4)} · oRadiiImmediate=${sl.oRadiiImmediate} · oRadiiPersist=${sl.oRadiiPersist}`,
      );
      check(
        '★ 自动适配结果在若干帧后仍保持（无帧回调覆盖半径）',
        sl.found === true && Math.abs((sl.oRadiiPersist ?? 0) - (sl.oRadiiImmediate ?? 0)) < 1e-9,
        `oRadiiImmediate=${sl.oRadiiImmediate} · oRadiiPersist=${sl.oRadiiPersist}`,
      );

      // ---- L2i. 中键平移后 骨轴/点选 与视图一致（pan 是视图变换，不是数据变换）----
      //
      // 两条回归锁（2026-09-22 复审 N1 / N13）：
      //   N1:  点选 / 骨轴投影必须吃实时 originY —— 写死 0.92h 时，竖直 pan 之后
      //        「画出来的」和「点得到的」分叉，用户在平移后的视图里点什么都不准。
      //   N13: panning 标志必须在 pointerup 复位 —— 漏复位时松键后每一次普通
      //        移动鼠标都会继续平移视图（视图「粘」在鼠标上）。
      console.log('\nL2i. 中键平移（pan）与点选一致性');
      const pan = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        b.setMode('skin');
        await ${nFrames(2)};
        const c = document.querySelector('[data-bd="front"]');
        const rect = c.getBoundingClientRect();
        const w = c.clientWidth, h = c.clientHeight;
        const axisOf = () => b.wrappers.axis('Head', 'front');
        const before = axisOf();
        const ev = (type, x, y, button) => c.dispatchEvent(new PointerEvent(type, {
          clientX: rect.left + x, clientY: rect.top + y,
          bubbles: true, pointerId: 1, isPrimary: true, button: button ?? 0,
        }));
        // ① 中键按下 → 竖直拖 +60px（originY += 60 → 骨轴两端点应整体下移 60px）
        ev('pointerdown', w / 2, h / 2, 1);
        ev('pointermove', w / 2, h / 2 + 60, 1);
        await ${nFrames(2)};
        const panned = axisOf();
        ev('pointerup', w / 2, h / 2 + 60, 1);
        // ② N13：松开后再普通移动鼠标，视图绝不能再跟着走
        ev('pointermove', w / 2, h / 2 + 110, 0);
        await ${nFrames(2)};
        const afterUp = axisOf();
        // ③ N1：在 pan 后的新位置点选，必须点得到 Head（点选与绘制同源 originY）
        const hit = panned === null ? null : b.wrappers.pick(
          'front', (panned.a[0] + panned.b[0]) / 2, (panned.a[1] + panned.b[1]) / 2,
        );
        // ④ redraw（= resize → 重新 fit）把视图还原，别污染后面的像素断言段
        b.redraw();
        // 除抖：重适配后的骨轴读数要等画布尺寸/相机完全落定（预览段载过 44MB 高模的
        // 负载尖峰下 2 帧不够，实测残留 ~2.5px 漂移把 0.5px 容差断言打假失败）
        await ${nFrames(4)};
        const restored = axisOf();
        return { before, panned, afterUp, hit, restored };
      })()`);
      check(
        '★ 中键拖拽 = 平移视图（Head 骨轴两端点竖直移动 +60px，水平不动）',
        pan.before !== null && pan.panned !== null &&
          Math.abs(pan.panned.a[1] - pan.before.a[1] - 60) < 0.5 &&
          Math.abs(pan.panned.b[1] - pan.before.b[1] - 60) < 0.5 &&
          Math.abs(pan.panned.a[0] - pan.before.a[0]) < 0.01,
        `a ${JSON.stringify(pan.before?.a)} → ${JSON.stringify(pan.panned?.a)}`,
      );
      check(
        '★ 松开中键后视图不再跟随鼠标（N13：panning 标志已复位）',
        pan.panned !== null && pan.afterUp !== null &&
          Math.abs(pan.afterUp.a[1] - pan.panned.a[1]) < 1e-6 &&
          Math.abs(pan.afterUp.b[1] - pan.panned.b[1]) < 1e-6,
        `afterUp ${JSON.stringify(pan.afterUp?.a)} vs panned ${JSON.stringify(pan.panned?.a)}`,
      );
      check(
        '★ pan 后的新位置能点中 Head（点选与绘制同吃实时 originY，N1）',
        pan.hit?.bone === 'Head',
        `pick=${JSON.stringify(pan.hit ?? null)}`,
      );
      check(
        '★ redraw 后视图回到 fit 基线（pan 不污染后续断言段）',
        pan.before !== null && pan.restored !== null &&
          Math.abs(pan.restored.a[1] - pan.before.a[1]) < 0.5 &&
          Math.abs(pan.restored.b[1] - pan.before.b[1]) < 0.5,
        `restored ${JSON.stringify(pan.restored?.a)} vs before ${JSON.stringify(pan.before?.a)}`,
      );

      // ---- L2j. T/A 预览随权重输入失效重建 + 导出选项跨模型复位（PR #7 复审）----
      //
      //   A: T/A 预览的网格由权重重姿态而来；smooth/算法/半径/偏移变化只 refresh()
      //      时预览停在旧权重上 —— 几何指纹（meshSum）必须跟着变。
      //   C: smoothWeights 若在 setModel 不重置，老 .meta.json（无此键）会把上一个
      //      模型的开关值带进来 —— 取消勾选后重开资产，必须复位为默认勾选。
      //      （本资产的 .meta.json 没有 bindingEditor 键，hydrate 不会碰该值，
      //       所以复不复位完全由 setModel 决定。）
      console.log('\nL2j. T/A 预览失效重建 与 导出选项复位');
      const prevInv = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        document.querySelector('[data-bd="pov-t"]').click();
        await ${nFrames(3)};
        const s1 = b.meshSum();
        const sm = document.querySelector('[data-bd="smooth"]');
        const orig = sm.checked;
        sm.checked = !orig;
        sm.dispatchEvent(new Event('change', { bubbles: true }));
        await ${nFrames(3)};
        const s2 = b.meshSum();
        // 还原：开关回位 + 回当前姿态预览
        sm.checked = orig;
        sm.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-bd="pov-current"]').click();
        await ${nFrames(2)};
        return { s1, s2, orig };
      })()`);
      check(
        '★ T 预览下切平滑开关，预览网格几何指纹跟着变（预览不停在旧权重）',
        Number.isFinite(prevInv.s1) && Number.isFinite(prevInv.s2) &&
          Math.abs(prevInv.s2 - prevInv.s1) > 1e-6,
        `meshSum ${prevInv.s1?.toFixed(4)} → ${prevInv.s2?.toFixed(4)}（开关原值=${prevInv.orig}）`,
      );
      const reopenRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const sm = document.querySelector('[data-bd="smooth"]');
        sm.checked = false;
        sm.dispatchEvent(new Event('change', { bubbles: true }));
        await ${nFrames(2)};
        b.open(${JSON.stringify(BIND_GLB)});
        await new Promise((r) => setTimeout(r, 3500));
        return {
          loaded: b.state()?.loaded === true,
          checked: document.querySelector('[data-bd="smooth"]').checked,
        };
      })()`);
      check(
        '★ 取消勾选平滑后重开资产，开关复位为默认勾选（不串上一模型的值）',
        reopenRes.loaded === true && reopenRes.checked === true,
        `loaded=${reopenRes.loaded} checked=${reopenRes.checked}`,
      );

      // ---- L2k. 旧评审遗留收口：诊断条 / 平滑参数 / 热力图 / 姿势预览 / Undo ----
      //
      //   §2.7 诊断条：数字必须与导出权重同源且常驻可见（影响骨数/零权重/未包裹）。
      //   §2.4 平滑参数：迭代数默认 4、改它 T 预览几何指纹必须变（真的进了权重链）。
      //   P0-3 热力图：选中骨 → 该骨高权重区画暖色；取消选中 → 暖色消失。
      //   §1.3 姿势预览：拖测试骨架网格变形，但编辑骨架坐标一个数都不许动。
      //   §2.6 Undo/Redo：键盘 Ctrl+Z 撤销半径修改，hook redo 重做回来。
      console.log('\nL2k. 旧评审遗留收口（诊断条/平滑参数/热力图/姿势预览/Undo）');

      const diagRes = await cdp.eval(`(() => {
        const t = window.__editor.binding.diag();
        return {
          t,
          ok: t.includes('影响骨数') && t.includes('零权重') && t.includes('未包裹'),
        };
      })()`);
      check(
        '★ 诊断条常驻且与导出同源（影响骨数 / 零权重 / 未包裹顶点数）',
        diagRes.ok === true,
        diagRes.t.replace(/\s+/g, ' ').slice(0, 110),
      );

      const smoothRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const si = document.querySelector('[data-bd="smooth-iters"]');
        const def = si.value;
        document.querySelector('[data-bd="pov-t"]').click();
        await ${nFrames(3)};
        const s1 = b.meshSum();
        si.value = '1';
        si.dispatchEvent(new Event('change', { bubbles: true }));
        await ${nFrames(3)};
        const s2 = b.meshSum();
        // 还原：参数回位 + 回当前姿态预览
        si.value = def;
        si.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-bd="pov-current"]').click();
        await ${nFrames(2)};
        return { def, s1, s2 };
      })()`);
      check(
        '★ 平滑迭代数默认 4 且真实进权重链（改成 1 后 T 预览几何指纹跟着变）',
        smoothRes.def === '4' &&
          Number.isFinite(smoothRes.s1) && Number.isFinite(smoothRes.s2) &&
          Math.abs(smoothRes.s2 - smoothRes.s1) > 1e-6,
        `默认=${smoothRes.def} meshSum ${smoothRes.s1?.toFixed(4)} → ${smoothRes.s2?.toFixed(4)}`,
      );

      const heatRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const info0 = b.heat();
        b.select('LeftUpLeg');
        await ${nFrames(4)};
        const seg = b.wrappers.axis('LeftUpLeg', 'front');
        const cx = document.querySelector('[data-bd="front"]');
        const ctx2 = cx.getContext('2d');
        // 3×3 采样规避三角面抗锯齿发丝缝；+8px 避开骨线与 joint 圆点
        const px = Math.round((seg.a[0] + seg.b[0]) / 2 + 8);
        const py = Math.round((seg.a[1] + seg.b[1]) / 2);
        const probe = () => {
          const d = ctx2.getImageData(px - 1, py - 1, 3, 3).data;
          let r = 0, g = 0, bl = 0, a = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; bl += d[i+2]; a += d[i+3]; }
          return { r: r / 9, g: g / 9, b: bl / 9, a: a / 9 };
        };
        const warm = probe();
        b.select(null);
        await ${nFrames(4)};
        const cool = probe();
        return { info0, warm, cool };
      })()`);
      check(
        '★ 热力图：选中 LeftUpLeg 大腿区画暖色（R≫B），取消选中回暖色消失',
        heatRes.info0?.enabled === true && heatRes.info0?.bone === null &&
          heatRes.warm.r > heatRes.warm.b + 30 &&
          !(heatRes.cool.r > heatRes.cool.b + 30),
        `选中时 rgb(${heatRes.warm.r.toFixed(0)},${heatRes.warm.g.toFixed(0)},${heatRes.warm.b.toFixed(0)})` +
          ` → 取消后 rgb(${heatRes.cool.r.toFixed(0)},${heatRes.cool.g.toFixed(0)},${heatRes.cool.b.toFixed(0)})`,
      );

      const poseRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        document.querySelector('[data-bd="pov-pose"]').click();
        await ${nFrames(4)};
        const s0 = b.meshSum();
        const before = b.state().positions.LeftForeArm.slice();
        const p = before.slice();
        p[1] -= 0.15; // 测试骨架：左小臂下移 15cm
        b.pose('LeftForeArm', p);
        await ${nFrames(4)};
        const s1 = b.meshSum();
        const after = b.state().positions.LeftForeArm.slice();
        document.querySelector('[data-bd="pov-current"]').click();
        await ${nFrames(2)};
        return { s0, s1, before, after };
      })()`);
      check(
        '★ 姿势预览：拖测试骨架网格蒙皮变形，但编辑骨架坐标纹丝不动',
        Number.isFinite(poseRes.s0) && Number.isFinite(poseRes.s1) &&
          Math.abs(poseRes.s1 - poseRes.s0) > 1e-6 &&
          JSON.stringify(poseRes.before) === JSON.stringify(poseRes.after),
        `meshSum ${poseRes.s0?.toFixed(4)} → ${poseRes.s1?.toFixed(4)}，` +
          `编辑骨架 ${JSON.stringify(poseRes.before)} → ${JSON.stringify(poseRes.after)}`,
      );

      const undoRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const orig = b.wrappers.cylinders().LeftArm.radii.medium;
        b.wrappers.setRadius('LeftArm', 'medium', 0.2);
        await ${nFrames(2)};
        const h1 = b.history();
        // 键盘路径：Ctrl+Z 必须真的绑定在面板快捷键上
        document.querySelector('[data-bd="front"]').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
        );
        await ${nFrames(2)};
        const r1 = b.wrappers.cylinders().LeftArm.radii.medium;
        b.redo();
        await ${nFrames(2)};
        const r2 = b.wrappers.cylinders().LeftArm.radii.medium;
        const h2 = b.history();
        // 必须还原成原值：后面 L2f/L2c 的像素断言依赖原始半径
        b.wrappers.setRadius('LeftArm', 'medium', orig);
        await ${nFrames(2)};
        return { orig, r1, r2, h1, h2 };
      })()`);
      check(
        '★ Undo/Redo：Ctrl+Z 撤销半径修改，redo 重做回来（栈深同步）',
        undoRes.h1?.undo >= 1 &&
          Math.abs(undoRes.r1 - undoRes.orig) < 1e-9 &&
          Math.abs(undoRes.r2 - 0.2) < 1e-9 &&
          undoRes.h2?.redo === 0,
        `原值 ${undoRes.orig} → 改 0.2 → Ctrl+Z 后 ${undoRes.r1} → redo 后 ${undoRes.r2}` +
          `（栈 ${JSON.stringify(undoRes.h1)}→${JSON.stringify(undoRes.h2)}）`,
      );

      // PR #8 复审收口一：快照是全量持久化态 → 设置变更也进历史，
      // 撤销必须同时回滚内部状态与控件显示（否则控件与状态背离）。
      const setUndoRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const sm = document.querySelector('[data-bd="smooth"]');
        const orig = sm.checked;
        const h0 = b.history().undo;
        sm.checked = !orig;
        sm.dispatchEvent(new Event('change', { bubbles: true }));
        await ${nFrames(2)};
        const h1 = b.history().undo;
        b.undo();
        await ${nFrames(2)};
        const back = sm.checked;
        b.redo();
        await ${nFrames(2)};
        const fwd = sm.checked;
        // 还原到原状，不给后面的段落留脏状态
        if (sm.checked !== orig) {
          sm.checked = orig;
          sm.dispatchEvent(new Event('change', { bubbles: true }));
          await ${nFrames(2)};
        }
        return { orig, h0, h1, back, fwd };
      })()`);
      check(
        '★ 设置变更进历史：平滑开关撤销/重做时状态与控件同步还原（全量快照）',
        setUndoRes.h1 === setUndoRes.h0 + 1 &&
          setUndoRes.back === setUndoRes.orig &&
          setUndoRes.fwd === !setUndoRes.orig,
        `栈深 ${setUndoRes.h0}→${setUndoRes.h1}，勾选 ${setUndoRes.orig} → 改 ${!setUndoRes.orig}` +
          ` → undo 后 ${setUndoRes.back} → redo 后 ${setUndoRes.fwd}`,
      );

      // PR #8 复审收口二：合并窗口在手势边界封口 —— 流内（800ms 同 kind）并步，
      // 但滑块松手补发的 change 之后，即使仍在 800ms 内也必须新起一步。
      const coalesceRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const orig = b.wrappers.cylinders().LeftForeArm.radii.top;
        const h0 = b.history().undo;
        b.wrappers.setRadius('LeftForeArm', 'top', 0.31);
        b.wrappers.setRadius('LeftForeArm', 'top', 0.32);
        await ${nFrames(1)};
        const h1 = b.history().undo;
        // 手势封口信号：滑块松手时浏览器补发 change（rootEl 统一监听）
        document.querySelector('[data-bd="r-top"]')
          .dispatchEvent(new Event('change', { bubbles: true }));
        b.wrappers.setRadius('LeftForeArm', 'top', 0.33);
        await ${nFrames(1)};
        const h2 = b.history().undo;
        // 还原：不给后面 L2f/L2c 的像素断言留脏半径
        b.wrappers.setRadius('LeftForeArm', 'top', orig);
        await ${nFrames(1)};
        return { orig, h0, h1, h2 };
      })()`);
      check(
        '★ 合并窗口手势封口：流内并一步，change 封口后 800ms 内也新起一步',
        coalesceRes.h1 === coalesceRes.h0 + 1 && coalesceRes.h2 === coalesceRes.h1 + 1,
        `undo 深度 ${coalesceRes.h0} →（流内连改两次）${coalesceRes.h1} →（封口后再改）${coalesceRes.h2}`,
      );

      // PR #8 复审收口三：姿势档镜像只许动测试骨架 —— 编辑骨架坐标零变化、
      // 不进历史；但姿势预览网格必须跟着镜像后的测试姿势变。
      const poseMirrorRes = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        document.querySelector('[data-bd="pov-pose"]').click();
        await ${nFrames(3)};
        // 先把左小臂掰弯，让左右不对称（对称姿势镜像前后几何相同，断言没有判别力）
        const arm = b.state().positions.LeftForeArm.slice();
        arm[1] -= 0.12;
        b.pose('LeftForeArm', arm);
        await ${nFrames(3)};
        const h0 = b.history().undo;
        const s0 = b.meshSum();
        const before = JSON.stringify(b.state().positions);
        document.querySelector('[data-bd="mirror-lr"]').click();
        await ${nFrames(3)};
        const s1 = b.meshSum();
        const after = JSON.stringify(b.state().positions);
        const h1 = b.history().undo;
        document.querySelector('[data-bd="pov-current"]').click();
        await ${nFrames(2)};
        return { h0, h1, s0, s1, same: before === after };
      })()`);
      check(
        '★ 姿势档镜像：编辑骨架零污染 + 不进历史，但预览网格跟着测试姿势变',
        poseMirrorRes.same === true && poseMirrorRes.h1 === poseMirrorRes.h0 &&
          Number.isFinite(poseMirrorRes.s0) && Number.isFinite(poseMirrorRes.s1) &&
          Math.abs(poseMirrorRes.s1 - poseMirrorRes.s0) > 1e-6,
        `编辑骨架不变=${poseMirrorRes.same}，栈深 ${poseMirrorRes.h0}→${poseMirrorRes.h1}，` +
          `meshSum ${poseMirrorRes.s0?.toFixed(4)} → ${poseMirrorRes.s1?.toFixed(4)}`,
      );

      // ---- L2f. 主 3D 视口：改半径 → 画面像素必须跟着变 ----
      //
      // L2e 证的是「几何数据变了」，这里证的是「用户眼睛看到的变了」。
      // 中间还隔着一次 GPU 上传 + 一次 draw，任何一环被条件跳过（比如按顶点数
      // 判断要不要重建缓冲）都会让几何变了但画面没变 —— 那正是用户报的现象。
      console.log('\nL2f. 主 3D 视口像素：改半径前后画面必须不同');
      const vpRect = await cdp.eval(`(() => {
        const e = document.querySelector('canvas#gpu');
        if (e === null) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      const grabAvg = async () => {
        const snap = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: vpRect.x, y: vpRect.y, width: vpRect.w, height: vpRect.h, scale: 1 },
        });
        return await cdp.eval(`(async (b64) => {
          const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
          return +(sum / n).toFixed(3);
        })('${snap.data}')`);
      };
      if (vpRect === null || vpRect.w < 2) {
        check('★ 主 3D 视口有可采样区域', false, JSON.stringify(vpRect));
      } else {
        // 先等几帧真实呈现：上一段（L2k）刚改还原过半径，若呈现滞后会抓到
        // 与 p1 字节相同的旧帧（avg 完全相等的假 FAIL，2026-09-22 复现）
        await cdp.eval(`(async () => { await ${nFrames(3)}; return 1; })()`);
        const p0 = await grabAvg();
        // 把所有 wrapper 撑到最大：任何一个包裹器生效，画面都得动。
        // 撑完必须还原 —— 后面 L2c 的像素健康度断言依赖原始半径。
        await cdp.eval(`(() => {
          const c = window.__editor.binding.wrappers.cylinders();
          window.__radOrig = {};
          for (const k of Object.keys(c)) window.__radOrig[k] = { ...c[k].radii };
          return Object.keys(window.__radOrig).length;
        })()`);
        await cdp.eval(`(async () => {
          const b = window.__editor.binding;
          for (const k of Object.keys(window.__radOrig)) {
            for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(k, s, 0.55);
          }
          await ${nFrames(4)};
          return true;
        })()`);
        const p1 = await grabAvg();
        // 必须还原成原值：后面 L2c 的像素健康度断言依赖原始半径
        await cdp.eval(`(async () => {
          const b = window.__editor.binding;
          for (const k of Object.keys(window.__radOrig)) {
            for (const s of ['top', 'medium', 'bottom']) {
              b.wrappers.setRadius(k, s, window.__radOrig[k][s]);
            }
          }
          await ${nFrames(4)};
          return true;
        })()`);
        check(
          '★ 主 3D 视口：撑大所有包裹器后画面亮度变了（半径真的画出来了）',
          Math.abs(p1 - p0) > 0.05,
          `avg ${p0} → ${p1}`,
        );
      }

      // ---- L2b. 绑定面板正/侧视 = 3D 正交视图 ----
      //
      // 守的是「正/侧视要能真正看出包裹器体积和穿插」：2D 粗描边看不出体积，
      // 必须换成带深度的正交 3D（网格实体 + 半透明 X-ray 圆柱体）。
      // 与 L2 同理：WGSL / usage 错配只有运行时才暴露，必须实测顶点数。
      console.log('\nL2b. 绑定面板正/侧视（3D 正交视图）');
      await cdp.eval(`(() => window.__editor.binding.redraw())()`);
      await sleep(600);
      const v3 = await cdp.eval(`(() => window.__editor.binding.view3d())()`);
      check('★ 正/侧视 3D 层已建立（非 null = WebGPU 可用）', v3 !== null, JSON.stringify(v3));
      if (v3 !== null) {
        check('★ 正视 3D 层已上传网格缓冲', v3.frontMesh === true, JSON.stringify(v3));
        check('★ 侧视 3D 层已上传网格缓冲', v3.sideMesh === true, JSON.stringify(v3));
        // 顶点数 = 骨数 × 每骨 240（3 段侧壁 3×10×6 + 两端盖 2×10×3）—— 结构自证
        check(
          '★ 正视 3D 层已画出包裹器圆柱体（顶点数 = 骨数 × 240）',
          v3.frontCylVerts > 0 && v3.frontCylVerts % 240 === 0,
          `frontCylVerts=${v3.frontCylVerts}（${v3.frontCylVerts / 240} 骨）`,
        );
        check(
          '★ 侧视 3D 层已画出包裹器圆柱体（顶点数 = 骨数 × 240）',
          v3.sideCylVerts > 0 && v3.sideCylVerts % 240 === 0,
          `sideCylVerts=${v3.sideCylVerts}（${v3.sideCylVerts / 240} 骨）`,
        );
        check(
          '正/侧视两个 3D 视图画出的圆柱体一致（同一批骨段）',
          v3.frontCylVerts === v3.sideCylVerts,
          `front=${v3.frontCylVerts} side=${v3.sideCylVerts}`,
        );
      }

      // ---- L3. 导入文件骨架（rigged GLB 桥）----
      // 数学正确性（TRS 累乘 / normalization / 名称映射）由
      // apps/editor/test/import-skeleton.test.ts 锁定；这里只守**接线**：
      // 导入模式真的打开了面板、诊断四元组正确、摆位随文件走（不是模板兜底）、
      // autoFit 真的跑了、纯网格给明确报错而不静默退化。
      console.log('\nL3. 导入文件骨架（rigged GLB 桥）');
      const MCP_GLB = 'assets/characters/models/E-01/rigged/E01_Shambler_900_mcpbound.glb';
      const OLD_RIG_GLB = 'assets/characters/models/E-01/rigged/E01_Shambler_900_rigged.glb';
      const BAKED_GLB = 'assets/characters/models/E-01/textured/E01_Shambler_900_baked.glb';
      const lfsOk = (p) =>
        fs.existsSync(path.resolve(p)) && fs.statSync(path.resolve(p)).size > 10000;
      if (!lfsOk(MCP_GLB) || !lfsOk(OLD_RIG_GLB) || !lfsOk(BAKED_GLB)) {
        skip('导入文件骨架', `GLB 缺失或 LFS 未 smudge: ${MCP_GLB} / ${OLD_RIG_GLB} / ${BAKED_GLB}`);
      } else {
        // ① MCP 导出（27 骨全命名）→ 全量映射
        const imp27 = await cdp.eval(`(async () => {
          window.__editor.binding.open(${JSON.stringify(MCP_GLB)}, { importSkeleton: true });
          await new Promise((r) => setTimeout(r, 3500));
          return {
            open: window.__editor.binding.isOpen(),
            diag: window.__editor.binding.importDiag(),
            st: window.__editor.binding.state(),
            cyls: window.__editor.binding.wrappers.cylinders(),
          };
        })()`);
        check('L3 导入模式打开绑定面板（27 骨 GLB）', imp27.open === true);
        check('L3 诊断已挂载（importDiag 非空）', imp27.diag !== null);
        check(
          'L3 27 骨全部从文件骨架映射（imported=27）',
          imp27.diag !== null && imp27.diag.imported.length === 27,
          `imported=${imp27.diag?.imported?.length}`,
        );
        check(
          'L3 无缺骨保持模板位 / 无未识别骨名 / 无重复',
          imp27.diag !== null && imp27.diag.keptTemplate.length === 0 &&
            imp27.diag.unknown.length === 0 && imp27.diag.duplicates.length === 0,
          `kept=${JSON.stringify(imp27.diag?.keptTemplate)} unknown=${JSON.stringify(imp27.diag?.unknown)} dup=${JSON.stringify(imp27.diag?.duplicates)}`,
        );
        const hips27 = imp27.st?.positions?.Hips;
        check(
          'L3 导入摆位已进会话（Hips 为有限三元组）',
          Array.isArray(hips27) && hips27.length === 3 && hips27.every(Number.isFinite),
          JSON.stringify(hips27),
        );
        // autoFit 强断言：半径必须等于**按导入骨长**算的公式值 clamp(骨长×0.35)
        // （圆柱表在 setModel 时就建，只看「存在」证明不了 autoFit 真跑过）
        const fa27 = imp27.st?.positions?.LeftForeArm;
        const lh27 = imp27.st?.positions?.LeftHand;
        const boneLen27 =
          Array.isArray(fa27) && Array.isArray(lh27)
            ? Math.hypot(lh27[0] - fa27[0], lh27[1] - fa27[1], lh27[2] - fa27[2])
            : NaN;
        const expectR = Math.min(0.22, Math.max(0.04, boneLen27 * 0.35));
        const actualR = imp27.cyls?.LeftForeArm?.radii?.top;
        check(
          'L3 autoFit 已按导入骨长真跑（LeftForeArm 半径=clamp(骨长×0.35)）',
          Number.isFinite(actualR) && Math.abs(actualR - expectR) < 1e-9,
          `骨长=${boneLen27.toFixed(4)} 期望R=${expectR.toFixed(4)} 实际R=${actualR}`,
        );

        // ② 旧 22 骨 rig（缺 5 根 tip）→ 缺骨诊断精确
        const imp22 = await cdp.eval(`(async () => {
          window.__editor.binding.open(${JSON.stringify(OLD_RIG_GLB)}, { importSkeleton: true });
          await new Promise((r) => setTimeout(r, 3500));
          return {
            open: window.__editor.binding.isOpen(),
            diag: window.__editor.binding.importDiag(),
            st: window.__editor.binding.state(),
          };
        })()`);
        const TIPS = ['HeadTip', 'LeftHandTip', 'RightHandTip', 'LeftToeTip', 'RightToeTip'];
        check('L3 导入模式打开绑定面板（22 骨 GLB）', imp22.open === true);
        check(
          'L3 旧 22 骨 rig：imported=22',
          imp22.diag !== null && imp22.diag.imported.length === 22,
          `imported=${imp22.diag?.imported?.length}`,
        );
        check(
          'L3 旧 22 骨 rig：保持模板位的恰是 5 根 tip 骨',
          imp22.diag !== null && JSON.stringify(imp22.diag.keptTemplate) === JSON.stringify(TIPS),
          `kept=${JSON.stringify(imp22.diag?.keptTemplate)}`,
        );
        check(
          'L3 旧 22 骨 rig：无未识别骨名',
          imp22.diag !== null && imp22.diag.unknown.length === 0,
          `unknown=${JSON.stringify(imp22.diag?.unknown)}`,
        );

        // ③ 摆位随文件走：两个文件的 LeftForeArm 静止位必须明显不同
        // （mcpbound 长臂 0.409m vs 旧 rig 0.26m 上臂链——若相同说明是模板兜底）
        const faA = imp27.st?.positions?.LeftForeArm;
        const faB = imp22.st?.positions?.LeftForeArm;
        const faDiff =
          Array.isArray(faA) && Array.isArray(faB)
            ? Math.hypot(faA[0] - faB[0], faA[1] - faB[1], faA[2] - faB[2])
            : 0;
        check(
          'L3 摆位随文件走（两次导入的 LeftForeArm 差 > 0.05m）',
          faDiff > 0.05,
          `A=${JSON.stringify(faA)} B=${JSON.stringify(faB)} Δ=${faDiff.toFixed(3)}`,
        );

        // ④ 纯网格（baked.glb 无 skin）：明确报错，不静默退化成模板模式。
        // 面板保持 ② 的旧会话打开着点——early return 必须发生在 openBinding 之前：
        // 旧会话不被顶掉（模型名不变）、不产生导入诊断。
        // （保存落盘点的切换时序同理：校验通过前不切换，见 main.ts bindAssetAt 注释）
        const noSkin = await cdp.eval(`(async () => {
          const before = window.__editor.binding.state()?.modelName ?? null;
          window.__editor.binding.open(${JSON.stringify(BAKED_GLB)}, { importSkeleton: true });
          await new Promise((r) => setTimeout(r, 2500));
          return {
            before,
            after: window.__editor.binding.state()?.modelName ?? null,
            diag: window.__editor.binding.importDiag(),
            open: window.__editor.binding.isOpen(),
          };
        })()`);
        check(
          'L3 纯网格走导入模式：不产生导入诊断（importDiag=null）',
          noSkin.diag === null,
        );
        check(
          'L3 纯网格走导入模式：旧会话不被顶掉（面板开、模型名不变）',
          noSkin.open === true && noSkin.after === noSkin.before && noSkin.after !== null,
          `before=${noSkin.before} after=${noSkin.after} open=${noSkin.open}`,
        );

        // 收尾：关面板，不污染最终截图
        await cdp.eval(`(() => { window.__editor.binding.close(); return 1; })()`);
      }
    }


    // 收尾截图（绑定面板状态存证）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'editor-binding-smoke.png'), Buffer.from(shot.data, 'base64'));

    return summary(cdp.consoleErrors, cdp.exceptions);
  } finally {
    try {
      chrome.kill();
    } catch {
      /* 已退出 */
    }
    if (server !== null) {
      try {
        server.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('绑定套件冒烟异常终止：', err);
    process.exit(1);
  });
