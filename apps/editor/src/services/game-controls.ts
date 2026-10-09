import type { RuntimeSession } from '@aether/runtime';
import { gameText as g } from './game-language';

export function screenMovement(x: number, z: number, yaw: number): [number, number] {
  return [x*Math.cos(yaw)+z*Math.sin(yaw),-x*Math.sin(yaw)+z*Math.cos(yaw)];
}
export function groundAim(ray: { o: readonly number[]; d: readonly number[] } | null, height: number): [number, number] | null {
  if (!ray || Math.abs(ray.d[1]!) < 1e-6) return null;
  const t=(height-ray.o[1]!)/ray.d[1]!;
  return t>0 && Number.isFinite(t) ? [ray.o[0]!+ray.d[0]!*t,ray.o[2]!+ray.d[2]!*t] : null;
}
/** Pointer capture is per stick: simultaneous thumbs do not share gesture state. */
export class GameControls {
  private readonly root = document.createElement('div');
  private readonly moveStick = document.createElement('button');
  private readonly aimStick = document.createElement('button');
  private readonly reload = document.createElement('button');
  private readonly interact = document.createElement('button');
  private move: [number,number] = [0,0];
  private aim: [number,number] = [0,0];
  private mouse: [number,number] | null = null;
  private aimWorld: [number, number] | null = null;
  private pointerFire=false;
  private keyboardFire=false;
  private runtime: RuntimeSession | null = null;
  private enabled=false;
  private readonly pointers = new Map<HTMLElement,number>();
  touch = matchMedia('(pointer: coarse)').matches;
  constructor(private canvas: HTMLCanvasElement, private ray: (x:number,y:number) => {o:readonly number[];d:readonly number[]} | null, private yaw: () => number) {
    this.root.className='game-touch-controls'; this.root.hidden=true;
    this.moveStick.className='game-stick move-stick'; this.aimStick.className='game-stick aim-stick';
    this.reload.className='touch-reload'; this.interact.className='touch-interact';
    this.root.append(this.moveStick,this.aimStick,this.reload,this.interact);document.getElementById('center')!.append(this.root);
    this.stick(this.moveStick,false);this.stick(this.aimStick,true);
    this.reload.onclick=()=>this.enabled && this.runtime?.reload();
    this.interact.onclick=()=>this.enabled && this.runtime?.interact();
    canvas.addEventListener('pointermove', e=> { if(this.enabled && e.pointerType==='mouse') {this.mouse=[e.clientX,e.clientY];this.touch=false;} });
    canvas.addEventListener('pointerdown', e=> {
      if(!this.enabled || e.pointerType!=='mouse' || e.button!==0)return;
      e.preventDefault();this.mouse=[e.clientX,e.clientY];this.pointerFire=true;canvas.setPointerCapture(e.pointerId);
    });
    const end=()=>{this.pointerFire=false;this.runtime?.setFire(this.keyboardFire);};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',end);
    canvas.addEventListener('pointerleave',()=>{if(!this.pointerFire)this.mouse=null;});
    window.addEventListener('blur',()=>this.clear());
    window.addEventListener('keydown',e=>{
      if(!this.enabled || e.repeat || e.ctrlKey || e.altKey || e.metaKey || (e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))))return;
      const index=Number(e.key)-1;
      if(Number.isInteger(index) && index>=0 && index<(this.runtime?.weapons.definitions.length??0)){e.preventDefault();this.runtime!.equipWeapon(this.runtime!.weapons.definitions[index]!.id);}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.clear();});
  }
  private stick(button: HTMLButtonElement, firing: boolean): void {
    const move=(e:PointerEvent)=> {
      if(this.pointers.get(button)!==e.pointerId)return;
      const r=button.getBoundingClientRect(),dx=(e.clientX-r.left-r.width/2)/(r.width*.34),dz=(e.clientY-r.top-r.height/2)/(r.height*.34);
      const length=Math.hypot(dx,dz),scale=1/Math.max(1,length);
      const value:[number,number]=length<.14?[0,0]:[dx*scale,dz*scale];
      button.style.setProperty('--stick-x',`${value[0]*24}px`);button.style.setProperty('--stick-y',`${value[1]*24}px`);
      if(firing){this.aim=value;this.pointerFire=length>=.14;}else this.move=value;
    };
    button.addEventListener('pointerdown',e=>{if(!this.enabled || this.pointers.has(button))return;e.preventDefault();this.touch=true;this.mouse=null;button.setPointerCapture(e.pointerId);this.pointers.set(button,e.pointerId);move(e);});
    button.addEventListener('pointermove',move);
    const end=(e:PointerEvent)=>{if(this.pointers.get(button)!==e.pointerId)return;this.pointers.delete(button);button.style.setProperty('--stick-x','0px');button.style.setProperty('--stick-y','0px');if(firing){this.aim=[0,0];this.pointerFire=false;this.runtime?.setFire(false);}else {this.move=[0,0];this.runtime?.setInput(0,0);}};
    button.addEventListener('pointerup',end);button.addEventListener('pointercancel',end);button.addEventListener('lostpointercapture',end);
  }
  setKeyboardFire(down:boolean): void { this.keyboardFire=down; if(this.enabled)this.runtime?.setFire(down || this.pointerFire); }
  clear(): void {
    this.aimWorld = null;
    this.move=[0,0];this.aim=[0,0];this.mouse=null;this.pointerFire=false;this.keyboardFire=false;
    for(const [element,id] of this.pointers)if(element.hasPointerCapture(id))element.releasePointerCapture(id);
    this.pointers.clear();
    for(const b of [this.moveStick,this.aimStick]){b.style.setProperty('--stick-x','0px');b.style.setProperty('--stick-y','0px');}
    this.runtime?.setInput(0,0);this.runtime?.setFire(false);this.runtime?.setAim(null,null);
  }
  update(runtime:RuntimeSession|null, paused:boolean, keyboardX:number,keyboardZ:number):void {
    const enabled=!!runtime && !paused && runtime.outcome==='running' && !runtime.progress?.choosing;
    if(runtime!==this.runtime || !enabled && this.enabled)this.clear();
    this.runtime=runtime;this.enabled=enabled;
    this.root.hidden=!runtime || !this.touch;
    this.moveStick.textContent=g('移动');this.aimStick.textContent=g('射击');this.reload.textContent=g('换弹');this.interact.textContent=g('交互');
    for(const b of [this.moveStick,this.aimStick,this.reload,this.interact])b.disabled=!enabled;
    this.interact.hidden=!runtime?.interactionTarget();
    this.canvas.classList.toggle('game-aim-cursor',enabled && !this.touch);
    if(!enabled || !runtime)return;
    const input=screenMovement(keyboardX+this.move[0],keyboardZ+this.move[1],this.yaw());runtime.setInput(...input);
    const p=runtime.player();if(!p)return;
    this.aimWorld = null;
    if(this.mouse){const point=groundAim(this.ray(...this.mouse),.9);if(point){runtime.setAim(...point);this.aimWorld=point;}}
    else if(Math.hypot(...this.aim)>.1){const [x,z]=screenMovement(...this.aim,this.yaw());this.aimWorld=[p.x+x*20,p.z+z*20];runtime.setAim(...this.aimWorld);}
    else runtime.setAim(null,null);
    runtime.setFire(this.pointerFire || this.keyboardFire);
  }
  /** Same visible pointer/stick used by gameplay, lifted to the authored aim height. */
  targetWorld(height: number): [number, number, number] | null {
    if (this.mouse) {
      const point = groundAim(this.ray(...this.mouse), height);
      return point ? [point[0], height, point[1]] : null;
    }
    return this.aimWorld ? [this.aimWorld[0], height, this.aimWorld[1]] : null;
  }
}
