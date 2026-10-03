/**
 * P5 战斗内核浏览器验收探针（docs/23 §4 的浏览器侧验收）。
 *
 * 断言（与 docs/23 §4 逐条对应）：
 *   ③ Play 后 floor-1 第一间房 wave1（E-01×5+E-02×3=8）在场；玩家开火（真键盘
 *      J 键链路）打死第一只僵尸（combatEvents kill ≥1、批次数减员）
 *   ④ 清空 wave1 → 波次推进可见（60 tick 后 wave2 的 E-01×4 出现，aliveCount
 *      有减有增）；死亡冻结：玩家 hp 归零 → outcome=game-over、tick 定格、
 *      Play 不自动 Stop
 *   ⑤ 全程 console 无 error（WGSL/装载错误在这里暴露）
 *
 * 数值注入走 session 公开 API（applyDamage 是产品单入口，探针复用同一入口
 * 加速清场——键盘只验证「开火链路」这一条真实 UI 路径）。
 *
 * 用法：node tools/verify/combat-probe.mjs --headed
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
const CDP_PORT = Number(arg('cdp', 9343));
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
    await cdp.send('Page.navigate', { url });
    await normalizeEditorState(cdp);

    // ---- Play 激活（场景 boot 竞态下轮询重试，M3 探针同款）----
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
    await sleep(900);

    // ---- ① wave1 编成在场（docs/23 §4-3）----
    const st1 = await cdp.eval(`(() => {
      const s = window.__editor.playCtl.session.runtime;
      const npcs = s.view().filter(e => e.kind === 'npc');
      return { npc: npcs.length, e01: npcs.filter(e => e.characterId === 'E-01').length,
               e02: npcs.filter(e => e.characterId === 'E-02').length,
               tick: s.tick, outcome: s.outcome };
    })()`);
    check('wave1 编成 = E-01×5 + E-02×3（8 只）',
      st1.npc === 8 && st1.e01 === 5 && st1.e02 === 3, JSON.stringify(st1));

    // ---- ② 真键盘 J 键开火 → 打死第一只（docs/23 §4-3）----
    // 把最近的一只僵尸挪到玩家枪口（+x 朝向）——探针摆位让射线可命中
    await cdp.eval(`(() => {
      const s = window.__editor.playCtl.session.runtime;
      const p = s.playerEntityId;
      let best = -1, bd = 1e9;
      for (const e of s.view()) { if (e.kind !== 'npc') continue;
        const d = Math.hypot(e.x - s.table.posX[p], e.z - s.table.posZ[p]);
        if (d < bd) { bd = d; best = e.id; } }
      if (best >= 0) { s.table.posX[best] = s.table.posX[p] + 3; s.table.posZ[best] = s.table.posZ[p]; }
      return best;
    })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    const firstKill = await waitFor(
      () => cdp.eval(`(() => {
        const s = window.__editor.playCtl.session.runtime;
        return { kills: s.combatEvents.filter(e => e.type === 'kill').length, npc: s.countNpc() };
      })()`).then((r) => (r.kills >= 1 ? r : null)),
      { timeout: 20000, interval: 400, label: 'J 键开火打死第一只' },
    ).catch(() => null);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    check('真键盘 J 开火 → 击杀事件 + 实体减员（aliveCount 有减）',
      firstKill !== null && firstKill.npc === 7, JSON.stringify(firstKill));

    // ---- ③ 清空 wave1 → wave2 推进（docs/23 §4-3 波次可见 + aliveCount 有增）----
    await cdp.eval(`(() => {
      const s = window.__editor.playCtl.session.runtime;
      for (const e of s.view()) if (e.kind === 'npc') s.applyDamage(e.id, s.table.health[e.id]);
      return true;
    })()`);
    const wave2 = await waitFor(
      () => cdp.eval(`(() => {
        const s = window.__editor.playCtl.session.runtime;
        const ev = s.sessionEvents.find(e => e.type === 'wave-start' && e.wave === 2);
        return ev ? { tick: ev.tick, npc: s.countNpc() } : null;
      })()`).then((r) => (r !== null && r.npc === 4 ? r : null)),
      { timeout: 20000, interval: 400, label: 'wave2 投放（E-01×4）' },
    ).catch(() => null);
    check('wave1 清空 → 60 tick 后 wave2（E-01×4）投放（aliveCount 有增）',
      wave2 !== null, JSON.stringify(wave2));

    // ---- ④ 死亡冻结（docs/23 §4-4）----
    const frozen = await cdp.eval(`(() => {
      const s = window.__editor.playCtl.session.runtime;
      s.applyDamage(s.playerEntityId, 99999);
      const tickAtDeath = s.tick;
      const ev = [];
      for (let i = 0; i < 30; i++) { const r = s.step(); ev.push(r.tick); }
      return { outcome: s.outcome, tickAtDeath, after: s.tick,
               stillPlaying: !document.querySelector('#btn-stop').disabled,
               gameOverEv: s.sessionEvents.some(e => e.type === 'game-over') };
    })()`);
    check('玩家死亡 → game-over 事件 + 世界冻结（tick 定格）',
      frozen.outcome === 'game-over' && frozen.after === frozen.tickAtDeath && frozen.gameOverEv,
      JSON.stringify(frozen));
    check('失败不自动 Stop（Play 状态保持，玩家看清死状）', frozen.stillPlaying === true, JSON.stringify(frozen));

    // ---- ⑤ console 卫生 + 截图留档 ----
    await sleep(600);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'combat-p5.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    check('截图留档（战斗验收视觉复核）', true, shotPath);
    check('无 console error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | ').slice(0, 300));
    check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | ').slice(0, 300));
  } finally {
    await chrome.kill();
    if (server !== null) server.kill();
  }

  const code = summary(cdp.consoleErrors, cdp.exceptions);
  process.exit(code);
}

main().catch((err) => {
  console.error('探针异常终止：', err.message);
  process.exit(1);
});
