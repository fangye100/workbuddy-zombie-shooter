/** Editor 临时 Play 观察输入；相机生命周期仍归 PlayCameraController。 */
import type { ViewCameraControl,ViewCameraState } from './play-camera';
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export function orbitViewCamera(s:ViewCameraState,dx:number,dy:number):ViewCameraState {
  return {...s,target:[...s.target],yaw:s.yaw-dx*.006,elevationDeg:clamp(s.elevationDeg+dy*.25,-89,89)};
}
export function panViewCamera(s:ViewCameraState,dx:number,dy:number,height:number):ViewCameraState {
  const el=s.elevationDeg*Math.PI/180,se=Math.sin(el),ce=Math.cos(el),sy=Math.sin(s.yaw),cy=Math.cos(s.yaw),scale=2*s.distance*Math.tan(Math.PI/8)/Math.max(1,height);
  return {...s,target:[clamp(s.target[0]+(-cy*dx-sy*se*dy)*scale,-120,120),clamp(s.target[1]+ce*dy*scale,.05,8),clamp(s.target[2]+(sy*dx-cy*se*dy)*scale,-120,120)]};
}
export function zoomViewCamera(s:ViewCameraState,factor:number):ViewCameraState {return {...s,target:[...s.target],distance:clamp(s.distance*factor,1.2,120)};}

export interface ObservationPorts {
  playing():boolean; observing():boolean; setObservation(on:boolean):boolean;
  releaseGameInput():void; equip(index:number):void; changed():void;
}
/** 捕获阶段独占导航事件，阻止既有游戏/编辑输入接收它们。Digits仍走原equip端口。 */
export class PlayObservationNavigation {
  private drag:{id:number;x:number;y:number;pan:boolean}|null=null;
  constructor(private canvas:HTMLCanvasElement,private button:HTMLButtonElement,private hint:HTMLElement,view:ViewCameraControl,private ports:ObservationPorts){
    button.onclick=()=>this.toggle(!ports.observing());
    const consume=(e:Event)=>{e.preventDefault();e.stopImmediatePropagation();};
    canvas.addEventListener('pointerdown',e=>{if(!ports.observing())return;consume(e);if(this.drag)return;this.drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:e.button!==0||e.shiftKey};canvas.setPointerCapture(e.pointerId);},true);
    canvas.addEventListener('pointermove',e=>{if(!ports.observing())return;consume(e);const d=this.drag;if(!d||d.id!==e.pointerId)return;const s=view.get(),dx=e.clientX-d.x,dy=e.clientY-d.y;view.set(d.pan?panViewCamera(s,dx,dy,canvas.clientHeight):orbitViewCamera(s,dx,dy));d.x=e.clientX;d.y=e.clientY;ports.changed();},true);
    for(const name of ['pointerup','pointercancel','lostpointercapture'] as const)canvas.addEventListener(name,e=>{if(!ports.observing())return;consume(e);if(this.drag?.id===e.pointerId)this.release();},true);
    canvas.addEventListener('wheel',e=>{if(!ports.observing())return;consume(e);view.set(zoomViewCamera(view.get(),Math.exp(e.deltaY*.0012)));ports.changed();},{capture:true,passive:false});
    for(const name of ['dblclick','contextmenu'] as const)canvas.addEventListener(name,e=>{if(ports.observing())consume(e);},true);
    window.addEventListener('keydown',e=>{if(!ports.observing()||e.ctrlKey||e.metaKey||e.altKey||e.target instanceof HTMLElement&&(e.target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)))return;
      if(e.key==='Escape'){consume(e);this.toggle(false);return;}
      if(/^[1-7]$/.test(e.key)){consume(e);if(!e.repeat)ports.equip(Number(e.key)-1);return;}
      if(['w','a','s','d','q','e','r','j','v','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)||['w','a','s','d','q','e','r','j','v'].includes(e.key.toLowerCase()))consume(e);
    },true);
    window.addEventListener('blur',()=>{this.release();ports.releaseGameInput();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.release();ports.releaseGameInput();}});
    this.sync();
  }
  toggle(on:boolean):void {this.release();this.ports.releaseGameInput();if(this.ports.setObservation(on)){this.sync();this.ports.changed();}}
  release():void {const d=this.drag;this.drag=null;if(d&&this.canvas.hasPointerCapture(d.id))this.canvas.releasePointerCapture(d.id);}
  sync():void {if(!this.ports.playing())this.release();const on=this.ports.observing();this.button.disabled=!this.ports.playing();this.button.textContent=on?'回游戏相机':'观察视角';this.button.classList.toggle('active',on);this.button.setAttribute('aria-pressed',String(on));this.hint.hidden=!on;this.canvas.style.cursor=on?'grab':'';}
}
