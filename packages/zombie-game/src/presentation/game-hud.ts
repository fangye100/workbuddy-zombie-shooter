import { gameText as g, gameLanguage, setGameLanguage } from './game-language';
import type { RuntimeSession } from '@aether/zombie-game';
import { RunHud } from './run-hud';
import { CombatOverlay, type WorldProjection } from './combat-overlay';
import './game-hud.css';

/** Read-only projection of simulation state; interaction goes back through PlaySession. */
export function gameHudModel(runtime: RuntimeSession) {
  const player = runtime.player();
  const rooms = runtime.desc.rooms.filter(r => r.enabled);
  const current = player ? rooms.find(r => runtime.insideRoom(r,player)) : undefined;
  const cleared = runtime.clearedRooms();
  const canInteract = !!current && runtime.interactionTarget() === current.nodeId;
  const wave = [...runtime.sessionEvents].reverse().find(e => e.type === 'wave-start' && e.roomNodeId === current?.nodeId)?.wave;
  return {
    title: g(runtime.desc.sceneName),
    hp: player?.hp ?? 0, maxHp: player?.maxHp ?? 1, hit: (player?.hitFlash ?? 0) > 0,
    time: Math.floor(runtime.tick * runtime.fixedStep), enemies: runtime.countNpc(),
    progress: `${cleared.length} / ${rooms.length}`,
    room: g(current?.name ?? '前往下一个房间'),
    objective: g(canInteract ? '按 E 交互，完成事件房'
      : current && cleared.includes(current.nodeId) ? '房间已完成 · 沿道路继续前进'
      : current?.clearRule === 'elite-dead' ? '击败精英目标' : wave ? `第 ${wave} 波 · 消灭敌人` : '探索并清理房间'),
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
  private readonly help = document.createElement('small');
  private readonly toolbar = document.createElement('nav');
  private readonly pause = document.createElement('button');
  private readonly language = document.createElement('button');
  private readonly debug = document.createElement('button');
  private readonly view = document.createElement('button');
  private readonly touch = document.createElement('button');
  private gameView = new URLSearchParams(location.search).has('game') || matchMedia('(pointer: coarse)').matches;
  private stopButton: HTMLButtonElement;
  private stamp = '';
  private nextBusy = false;
  private campaignComplete = false;
  private currentRun = -1;
  constructor(actions: { interact(): void; retry(): void | Promise<void>; next(): Promise<'navigating' | 'complete' | 'blocked'>; stop(): void; resume(): void; pause(): void; toggleTouch(): boolean; audioControl?:HTMLElement }, project?: WorldProjection) {
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
    this.stopButton = document.createElement('button'); const stop = this.stopButton; stop.textContent = '返回编辑'; stop.onclick = actions.stop;
    const help = this.help;
    this.toolbar.className='game-toolbar';
    this.language.onclick=()=>{setGameLanguage(gameLanguage()==='zh'?'en':'zh');this.stamp='';};
    this.pause.onclick=actions.pause;
    this.debug.onclick=()=>{if(this.feedback)this.feedback.debugRanges=!this.feedback.debugRanges;};
    this.view.onclick=()=>{this.gameView=!this.gameView;};
    this.touch.onclick=()=>{this.touch.dataset.touch=String(actions.toggleTouch());};
    this.toolbar.append(this.language,this.pause,this.touch,this.view,this.debug);
    if(actions.audioControl)this.toolbar.append(actions.audioControl);
    this.result.append(this.retry, this.next, stop);
    const life = document.createElement('div'); life.className = 'hud-life';
    this.healthText.className = 'hud-health-value'; life.append(this.title, this.health, this.healthText);
    this.stats.className = 'hud-wave';
    const prompt = document.createElement('div'); prompt.className = 'hud-objective'; prompt.append(this.objective, this.interact, this.resume, this.result);
    help.className = 'hud-help';
    this.radar.className = 'hud-radar'; this.radar.width = 180; this.radar.height = 180; this.radar.setAttribute('aria-label','附近敌人雷达 · 范围 20 米');
    this.root.append(life, this.stats, prompt, help, this.radar,this.toolbar);
    document.getElementById('center')!.append(this.root);
  }
  update(runtime: RuntimeSession | null, paused: boolean): void {
    this.runHud.update(runtime, paused);
    document.body.classList.toggle('game-view',!!runtime && this.gameView);
    this.language.textContent=gameLanguage()==='zh'?'EN':'中文';this.language.setAttribute('aria-label',gameLanguage()==='zh'?'Switch game to English':'切换游戏为中文');
    this.pause.disabled=!!runtime && runtime.outcome!=='running';
    this.pause.textContent=g(paused?'继续':'暂停');this.view.textContent=g(this.gameView?'编辑器视图':'游戏视图');
    this.touch.textContent=g(this.touch.dataset.touch==='true'?'键鼠':'触控');
    this.debug.textContent=g('调试范围');this.debug.setAttribute('aria-pressed',String(this.feedback?.debugRanges ?? false));
    this.retry.textContent=g('再来一局');this.resume.textContent=g('准备好了 · 继续战斗');this.stopButton.textContent=g('返回编辑');this.interact.textContent=g('交互 E');
    this.next.textContent=g(this.campaignComplete?'全部楼层已完成':'继续下一层');
    this.help.textContent=g(this.touch.dataset.touch==='true' || matchMedia('(pointer: coarse)').matches?'左摇杆移动 · 右摇杆瞄准射击 · 点击按钮换弹与交互':'WASD / 方向键移动 · 鼠标瞄准 · 左键射击 · R 换弹 · 1–7 换武器 · E 交互 · 空格暂停');
    this.root.setAttribute('aria-label',g('游戏状态'));this.health.setAttribute('aria-label',g('生命值'));this.radar.setAttribute('aria-label',g('附近敌人雷达 · 范围 20 米'));
    this.root.hidden = runtime === null;
    if (!runtime) { this.stamp = ''; return; }
    this.drawRadar(runtime);
    if (this.currentRun !== runtime.runId) { this.currentRun = runtime.runId; this.campaignComplete = false; this.next.textContent = '继续下一层'; }
    this.next.disabled = this.nextBusy || this.campaignComplete || !!runtime.progress?.choosing;
    const m = gameHudModel(runtime); const stamp = JSON.stringify([m, paused,gameLanguage()]);
    if (stamp === this.stamp) return; this.stamp = stamp;
    this.root.classList.toggle('hit', m.hit);
    this.title.textContent = m.title;
    this.health.max = m.maxHp; this.health.value = Math.max(0, m.hp);
    this.health.setAttribute('aria-valuetext', `${Math.ceil(m.hp)} / ${m.maxHp}`);
    this.healthText.textContent = `${Math.ceil(m.hp)} / ${m.maxHp}`;
    this.stats.textContent = g(`敌人 ${m.enemies}　·　房间 ${m.progress}\n${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}`);
    this.objective.textContent = g(m.outcome === 'game-over' ? '本局结束 · 再试一次'
      : m.outcome === 'floor-clear' ? '本层通关！' : paused ? '已暂停' : `${m.room} · ${m.objective}`);
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
