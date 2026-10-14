/** Pause观察下的持握槽事件owner；空白指针仍由观察导航接管。 */
import type { ActorHoldSlot,SocketTransform } from '@aether/scene';
import type { LabRenderer } from '../renderer';
import { ActorHoldSlotSession,slotFromWorld } from './actor-hold-slot';
import { GizmoTargetDrag } from './gizmo-target-drag';
import type { HoldContext } from './runtime-weapons';
export class ActorHoldSlotViewport {
  private pointer:number|null=null;
  private baseline:{slot:ActorHoldSlot;world:SocketTransform;frame:NonNullable<HoldContext['frame']>}|null=null;
  private drag:GizmoTargetDrag;
  constructor(private canvas:HTMLCanvasElement,private renderer:LabRenderer,private session:ActorHoldSlotSession,private hit:(x:number,y:number)=>{axis:number}|null){
    this.drag=new GizmoTargetDrag({ray:(x,y)=>renderer.pointerRay(x,y),eye:()=>renderer.getEye(),info:()=>renderer.getGizmoInfo(),read:()=>session.frame?.world??null,
      begin:()=>{const frame=session.frame,slot=session.slot;if(frame&&slot){this.baseline={slot,world:structuredClone(frame.world),frame};session.beginDrag();}},
      write:world=>{if(this.baseline)session.edit(slotFromWorld(this.baseline.slot,this.baseline.world,world,this.baseline.frame),false);},
      end:cancel=>{session.endDrag(cancel);this.baseline=null;renderer.setGizmoActiveAxis(null);}});
  }
  sync():void {
    const frame=this.session.frame;
    if(!frame||!this.session.shown){if(this.drag.active)this.release(true);this.renderer.helperGizmo=null;return;}
    this.renderer.helperGizmo=structuredClone(frame.world);
  }
  claim(e:PointerEvent):boolean {
    if(this.pointer!==null&&e.pointerId===this.pointer){
      if(e.type==='pointermove')this.drag.update(e.clientX,e.clientY);else if(e.type==='pointerup'||e.type==='pointercancel'||e.type==='lostpointercapture')this.release(e.type!=='pointerup');return true;
    }
    if(e.type!=='pointerdown'||e.button!==0||!this.session.frame||!this.session.shown)return false;
    const center=this.renderer.worldToScreen(this.session.frame.world.position);
    if(!this.session.selectedInView){if(center.behind||Math.hypot(center.x-e.clientX,center.y-e.clientY)>16)return false;this.session.selectedInView=true;return true;}
    const hit=this.hit(e.clientX,e.clientY);if(!hit||!this.drag.begin(hit.axis,e.clientX,e.clientY))return false;
    this.pointer=e.pointerId;this.canvas.setPointerCapture(e.pointerId);this.renderer.setGizmoActiveAxis(hit.axis);return true;
  }
  release(cancel=false):void {const pointer=this.pointer;this.pointer=null;this.drag.end(cancel);if(pointer!==null&&this.canvas.hasPointerCapture(pointer))this.canvas.releasePointerCapture(pointer);}
}
