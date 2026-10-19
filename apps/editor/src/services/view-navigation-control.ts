/** 用户同一自由视角入口：Edit 飞行，Play/Pause 使用既有观察导航。 */
import { PLAY_OBSERVATION_TITLE } from './play-observation-navigation';
export interface ViewNavigationPorts {
  playing(): boolean;
  observing(): boolean;
  freeCam(): boolean;
  setFreeCam(on: boolean): void;
  setObservation(on: boolean): void;
}
export class ViewNavigationControl {
  constructor(private button: HTMLButtonElement, private ports: ViewNavigationPorts) {
    button.onclick=()=>this.toggle();this.sync();
  }
  toggle(): void {
    if(this.ports.playing())this.ports.setObservation(!this.ports.observing());
    else this.ports.setFreeCam(!this.ports.freeCam());
    this.sync();
  }
  sync(): void {
    const playing=this.ports.playing(),active=playing?this.ports.observing():this.ports.freeCam();
    this.button.textContent=playing?(active?'回游戏相机 V':'观察视角 V'):'自由相机 V';
    this.button.title=playing?PLAY_OBSERVATION_TITLE:'编辑态自由飞行：WASD/QE 移动、拖动转向；V 切换、Esc 退出';
    this.button.classList.toggle('active',active);this.button.setAttribute('aria-pressed',String(active));
  }
}
