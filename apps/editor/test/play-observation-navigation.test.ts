import {describe,it,expect,vi,afterEach} from 'vitest';
import {PlayObservationNavigation,panViewCamera,orbitViewCamera,zoomViewCamera,PLAY_OBSERVATION_TITLE} from '../src/services/play-observation-navigation';
import {ViewNavigationControl} from '../src/services/view-navigation-control';
import type {ViewCameraState} from '../src/services/play-camera';
class Surface {
  listeners:{name:string;fn:(e:any)=>void;capture:boolean}[]=[];captures=new Set<number>();clientHeight=800;hidden=false;disabled=false;textContent='';tagName='CANVAS';isContentEditable=false;onclick:(()=>void)|null=null;style={cursor:''};attributes=new Map();classList={toggle:vi.fn()};
  addEventListener(name:string,fn:any,opts?:any){this.listeners.push({name,fn,capture:opts===true||opts?.capture===true});}
  setPointerCapture(id:number){this.captures.add(id);}hasPointerCapture(id:number){return this.captures.has(id);}releasePointerCapture(id:number){this.captures.delete(id);}setAttribute(k:string,v:string){this.attributes.set(k,v);}
  emit(name:string,props:Record<string,unknown>={}){let stopped=false;const e={target:this,preventDefault:vi.fn(),stopImmediatePropagation:()=>{stopped=true;},...props};for(const l of this.listeners.filter(l=>l.name===name).sort((a,b)=>Number(b.capture)-Number(a.capture))){if(stopped)break;l.fn(e);}return e;}
}
afterEach(()=>vi.unstubAllGlobals());
describe('Play观察导航与输入边界',()=>{
  it('窄claim手柄不转相机；未命中空白保留真实观察导航',()=>{
    const win=new Surface(),doc=new Surface(),canvas=new Surface(),button=new Surface(),hint=new Surface();vi.stubGlobal('window',win);vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',Surface);
    let s:ViewCameraState={target:[0,1,0],distance:8,yaw:0,elevationDeg:55};const claim=vi.fn((e:PointerEvent)=>e.pointerId===7);
    new PlayObservationNavigation(canvas as never,button as never,hint as never,{get:()=>s,set:v=>{s=v;}},{playing:()=>true,observing:()=>true,setObservation:()=>true,releaseGameInput:vi.fn(),equip:vi.fn(),changed:vi.fn(),claimPointer:claim});
    canvas.emit('pointerdown',{pointerId:7,button:0,clientX:10,clientY:10});canvas.emit('pointermove',{pointerId:7,clientX:100,clientY:20});canvas.emit('pointerup',{pointerId:7});expect(s.yaw).toBe(0);expect(claim).toHaveBeenCalledTimes(3);
    canvas.emit('pointerdown',{pointerId:8,button:0,clientX:10,clientY:10});canvas.emit('pointermove',{pointerId:8,clientX:100,clientY:20});expect(s.yaw).toBeCloseTo(-.54);
  });
  it('正常Play/Pause都能导航；捕获输入不触发游戏，Digits和退出/失焦释放',()=>{
    const win=new Surface(),doc=new Surface(),canvas=new Surface(),button=new Surface(),hint=new Surface();vi.stubGlobal('window',win);vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',Surface);
    let on=false,playing=true,s:ViewCameraState={target:[0,1.2,0],distance:2,yaw:0,elevationDeg:0};const release=vi.fn(),equip=vi.fn(),gamePointer=vi.fn(),gameKey=vi.fn();canvas.addEventListener('pointerdown',gamePointer);canvas.addEventListener('pointermove',gamePointer);win.addEventListener('keydown',gameKey);
    const nav=new PlayObservationNavigation(canvas as never,button as never,hint as never,{get:()=>structuredClone(s),set:v=>{s=v;}},{playing:()=>playing,observing:()=>on,setObservation:v=>{on=v;return playing;},releaseGameInput:release,equip,changed:vi.fn()});
    nav.toggle(true);expect(button.textContent).toBe('回游戏相机');expect(hint.hidden).toBe(false);
    canvas.emit('pointerdown',{pointerId:1,clientX:100,clientY:100,button:0});canvas.emit('pointermove',{pointerId:1,clientX:150,clientY:120});expect(s.yaw).toBeCloseTo(-.3);expect(gamePointer).not.toHaveBeenCalled();
    win.emit('keydown',{key:'w'});expect(gameKey).not.toHaveBeenCalled();win.emit('keydown',{key:'7'});expect(equip).toHaveBeenCalledWith(6);
    win.emit('blur');expect(canvas.captures.size).toBe(0);expect(release).toHaveBeenCalled();
    const old=structuredClone(s);canvas.emit('pointerdown',{pointerId:2,clientX:100,clientY:100,button:2});canvas.emit('pointermove',{pointerId:2,clientX:110,clientY:130});expect(s.target).not.toEqual(old.target);canvas.emit('pointercancel',{pointerId:2});expect(canvas.captures.size).toBe(0);
    canvas.emit('wheel',{deltaY:-100});expect(s.distance).toBeLessThan(old.distance);
    win.emit('keydown',{key:'v',repeat:true});expect(on).toBe(true);win.emit('keydown',{key:'v'});expect(on).toBe(false);expect(button.textContent).toBe('观察视角');
    nav.toggle(true);win.emit('keydown',{key:'Escape'});expect(on).toBe(false);
    playing=false;nav.sync();expect(button.disabled).toBe(true);
  });
  it('可见自由视角按钮在Edit走飞行，在Play/Pause走同一观察端口并同步退出/Stop状态',()=>{
    const button=new Surface();let playing=false,free=false,observing=false;
    const setFreeCam=vi.fn(v=>{free=v;}),setObservation=vi.fn(v=>{observing=v;});
    const control=new ViewNavigationControl(button as never,{playing:()=>playing,observing:()=>observing,freeCam:()=>free,setFreeCam,setObservation});
    button.onclick!();expect(free).toBe(true);expect(setObservation).not.toHaveBeenCalled();expect(button.attributes.get('aria-pressed')).toBe('true');
    control.toggle();expect(free).toBe(false);playing=true;control.sync();expect(button.textContent).toBe('观察视角 V');expect((button as any).title).toBe(PLAY_OBSERVATION_TITLE);
    button.onclick!();expect(observing).toBe(true);expect(button.textContent).toBe('回游戏相机 V');expect(setFreeCam).toHaveBeenCalledTimes(2);
    observing=false;control.sync();expect(button.attributes.get('aria-pressed')).toBe('false');
    // Pause 仍属于 playing 会话；不触发编辑态飞行。
    control.toggle();expect(observing).toBe(true);playing=false;observing=false;control.sync();expect(button.textContent).toBe('自由相机 V');expect(button.attributes.get('aria-pressed')).toBe('false');
  });
  it('共用编辑态数学保留视高/朝向、距离与俯仰边界且不写原状态',()=>{
    const s:ViewCameraState={target:[0,1,0],distance:5,yaw:0,elevationDeg:0},old=structuredClone(s);
    expect(panViewCamera(s,10,0,1000).target[0]).toBeLessThan(0);expect(panViewCamera(s,0,10,1000).target[1]).toBeGreaterThan(1);expect(orbitViewCamera(s,0,1000).elevationDeg).toBe(89);expect(zoomViewCamera(s,.01).distance).toBe(1.2);expect(s).toEqual(old);
  });
});
