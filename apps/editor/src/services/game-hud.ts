import type { RuntimeSession } from '@aether/runtime';
import { RunHud } from './run-hud';
import { CombatOverlay, type WorldProjection } from './combat-overlay';
import './game-hud.css';

/** Read-only projection of simulation state; interaction goes back through PlaySession. */
export function gameHudModel(runtime: RuntimeSession) {
  const player = runtime.player();
  const rooms = runtime.desc.rooms.filter(r => r.enabled);
  const current = player ? rooms.find(r => player.x >= r.minX && player.x <= r.maxX && player.z >= r.minZ && player.z <= r.maxZ) : undefined;
  const cleared = runtime.clearedRooms();
  const canInteract = !!current && runtime.interactionTarget() === current.nodeId;
  const wave = [...runtime.sessionEvents].reverse().find(e => e.type === 'wave-start' && e.roomNodeId === current?.nodeId)?.wave;
  return {
    title: runtime.desc.sceneName,
    hp: player?.hp ?? 0, maxHp: player?.maxHp ?? 1, hit: (player?.hitFlash ?? 0) > 0,
    time: Math.floor(runtime.tick * runtime.fixedStep), enemies: runtime.countNpc(),
    progress: `${cleared.length} / ${rooms.length}`,
    room: current?.name ?? '前往下一个房间',
    objective: canInteract ? '按 E 交互，完成事件房'
      : current && cleared.includes(current.nodeId) ? '房间已完成 · 沿道路继续前进'
      : current?.clearRule === 'elite-dead' ? '击败精英目标' : wave ? `第 ${wave} 波 · 消灭敌人` : '探索并清理房间',
    canInteract,
    outcome: runtime.outcome,
  };
}

export class GameHud {
  private readonly runHud = new RunHud();
  private readonly feedback: CombatOverlay | null;
  private readonly root = document.createElement('section');
  private readonly title = document.createElement('strong');
  private readonly health = document.createElement('progress');
  private readonly healthText = document.createElement('b');
  private readonly radar = document.createElement('canvas');
  private readonly stats = document.createElement('span');
  private readonly objective = document.createElement('p');
  private readonly result = document.createElement('div');
  private readonly interact = document.createElement('button');
  private readonly next = document.createElement('button');
  private readonly retry = document.createElement('button');
  private readonly resume = document.createElement('button');
  private stamp = '';
  private nextBusy = false;
  private campaignComplete = false;
  private currentRun = -1;
  constructor(actions: { interact(): void; retry(): void | Promise<void>; next(): Promise<'navigating' | 'complete' | 'blocked'>; stop(): void; resume(): void }, project?: WorldProjection) {
    this.feedback = project ? new CombatOverlay(project) : null;
    this.root.className = 'game-hud'; this.root.hidden = true; this.root.setAttribute('aria-label', '游戏状态');
    this.health.max = 100; this.health.setAttribute('aria-label', '生命值');
    this.objective.setAttribute('aria-live', 'polite');
    this.interact.textContent = '交互 E'; this.interact.onclick = actions.interact;
    this.retry.textContent = '再来一局'; this.retry.onclick = () => { this.retry.disabled = true; void Promise.resolve(actions.retry()).finally(() => { this.retry.disabled = false; }); };
    this.resume.textContent = '准备好了 · 继续战斗'; this.resume.onclick = actions.resume;
    this.next.textContent = '继续下一层'; this.next.onclick = () => {
      this.nextBusy = true; this.next.disabled = true;
      void actions.next().then(result => {
        if (result === 'complete') { this.campaignComplete = true; this.next.textContent = '全部楼层已完成'; }
      }).finally(() => { this.nextBusy = false; this.next.disabled = this.campaignComplete; });
    };
    const stop = document.createElement('button'); stop.textContent = '返回编辑'; stop.onclick = actions.stop;
    const help = document.createElement('small'); help.textContent = 'WASD / 方向键移动 · J 射击 · E 交互 · 空格暂停';
    this.result.append(this.retry, this.next, stop);
    const life = document.createElement('div'); life.className = 'hud-life';
    this.healthText.className = 'hud-health-value'; life.append(this.title, this.health, this.healthText);
    this.stats.className = 'hud-wave';
    const prompt = document.createElement('div'); prompt.className = 'hud-objective'; prompt.append(this.objective, this.interact, this.resume, this.result);
    help.className = 'hud-help';
    this.radar.className = 'hud-radar'; this.radar.width = 180; this.radar.height = 180; this.radar.setAttribute('aria-label','附近敌人雷达 · 范围 20 米');
    this.root.append(life, this.stats, prompt, help, this.radar);
    document.getElementById('center')!.append(this.root);
  }
  update(runtime: RuntimeSession | null, paused: boolean): void {
    this.runHud.update(runtime);
    this.root.hidden = runtime === null;
    if (!runtime) { this.stamp = ''; return; }
    this.drawRadar(runtime);
    if (this.currentRun !== runtime.runId) { this.currentRun = runtime.runId; this.campaignComplete = false; this.next.textContent = '继续下一层'; }
    this.next.disabled = this.nextBusy || this.campaignComplete || !!runtime.progress?.choosing;
    const m = gameHudModel(runtime); const stamp = JSON.stringify([m, paused]);
    if (stamp === this.stamp) return; this.stamp = stamp;
    this.root.classList.toggle('hit', m.hit);
    this.title.textContent = m.title;
    this.health.max = m.maxHp; this.health.value = Math.max(0, m.hp);
    this.health.setAttribute('aria-valuetext', `${Math.ceil(m.hp)} / ${m.maxHp}`);
    this.healthText.textContent = `${Math.ceil(m.hp)} / ${m.maxHp}`;
    this.stats.textContent = `敌人 ${m.enemies}　·　房间 ${m.progress}\n${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}`;
    this.objective.textContent = m.outcome === 'game-over' ? '本局结束 · 再试一次'
      : m.outcome === 'floor-clear' ? '本层通关！' : paused ? '已暂停' : `${m.room} · ${m.objective}`;
    this.result.hidden = m.outcome === 'running';
    this.resume.hidden = !paused || m.outcome !== 'running';
    this.interact.hidden = !m.canInteract || m.outcome !== 'running'; this.interact.disabled = paused;
    this.next.hidden = m.outcome !== 'floor-clear';
    this.next.disabled = this.nextBusy || this.campaignComplete || !!runtime.progress?.choosing;
  }
  updateFeedback(runtime: RuntimeSession | null): void { this.feedback?.update(runtime); }
  private drawRadar(runtime: RuntimeSession): void {
    const c=this.radar.getContext('2d'); if(!c)return;
    c.clearRect(0,0,180,180);c.fillStyle='#171327';c.beginPath();c.arc(90,90,85,0,Math.PI*2);c.fill();
    c.strokeStyle='#2bc4d650';c.lineWidth=1;
    for(const r of [30,60,83]){c.beginPath();c.arc(90,90,r,0,Math.PI*2);c.stroke();}
    c.beginPath();c.moveTo(7,90);c.lineTo(173,90);c.moveTo(90,7);c.lineTo(90,173);c.stroke();
    const player=runtime.player();if(!player)return;
    const table=runtime.table;c.fillStyle='#e8402a';
    for(let i=0;i<table.capacity;i++){
      if(!table.isAlive(i)||i===runtime.playerEntityId)continue;
      const x=(table.posX[i]!-player.x)*4,z=(table.posZ[i]!-player.z)*4;
      if(x*x+z*z>80*80)continue;c.beginPath();c.arc(90+x,90+z,3.5,0,Math.PI*2);c.fill();
    }
    c.save();c.translate(90,90);c.rotate(player.yaw);c.fillStyle='#ffc531';c.beginPath();c.moveTo(8,0);c.lineTo(-5,-5);c.lineTo(-3,0);c.lineTo(-5,5);c.closePath();c.fill();c.restore();
  }
}
