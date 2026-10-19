/** 非场景对象的gizmo拖拽适配器；复用既有轴/圆环数学，不拥有内容或历史。 */
import * as m4 from '@aether/core';
import type { SocketTransform } from '@aether/scene';
import { axisPlaneNormal,rotatePlaneBasis,angleInPlane,wrapAngle } from '../gizmo';
type V3=m4.Vec3;
export interface GizmoTargetPorts {
  ray(x:number,y:number):{o:V3;d:V3}|null; eye():V3;
  info():{origin:V3;axes:V3[];mode:'translate'|'rotate'|'scale'}|null;
  read():SocketTransform|null; write(value:SocketTransform):void;
  begin():void; end(cancel:boolean):void;
}
const plane=(o:V3,d:V3,n:V3,p:V3):V3|null=>{const den=m4.v3dot(d,n);if(Math.abs(den)<1e-7)return null;const t=m4.v3dot(m4.v3sub(p,o),n)/den;return t<0?null:m4.v3add(o,m4.v3scale(d,t));};
export class GizmoTargetDrag {
  private state:{value:SocketTransform;axis:number;mode:'translate'|'rotate';dir:V3;n:V3;grab:V3;view:V3;angle:number;total:number}|null=null;
  constructor(private ports:GizmoTargetPorts){}
  get active():boolean{return !!this.state;}
  begin(axis:number,x:number,y:number):boolean {
    const info=this.ports.info(),value=this.ports.read(),ray=this.ports.ray(x,y);if(!info||!value||!ray||info.mode==='scale')return false;
    const view=m4.v3norm(m4.v3sub(this.ports.eye(),value.position)),dir=axis<0?[0,0,0] as V3:info.axes[axis]!;
    const n=info.mode==='rotate'?dir:axis<0?view:axisPlaneNormal(view,dir),grab=plane(ray.o,ray.d,n,value.position);if(!grab)return false;
    const basis=rotatePlaneBasis(dir,view);
    this.state={value:structuredClone(value),axis,mode:info.mode,dir,n,grab,view,angle:info.mode==='rotate'?angleInPlane(grab,value.position,basis.u,basis.w):0,total:0};this.ports.begin();return true;
  }
  update(x:number,y:number):void {
    const s=this.state,ray=this.ports.ray(x,y);if(!s||!ray)return;
    const p=plane(ray.o,ray.d,s.n,s.value.position);if(!p)return;const value=structuredClone(s.value);
    if(s.mode==='rotate'){
      const b=rotatePlaneBasis(s.dir,s.view),a=angleInPlane(p,s.value.position,b.u,b.w);s.total+=wrapAngle(a-s.angle);s.angle=a;
      value.rotation=[...m4.quatMul(m4.quatAxisAngle(s.dir,s.total),s.value.rotation)];
    }else {
      const delta=m4.v3sub(p,s.grab),d=s.axis<0?delta:m4.v3scale(s.dir,m4.v3dot(delta,s.dir));
      value.position=[...m4.v3add(s.value.position,d)];
    }
    this.ports.write(value);
  }
  end(cancel=false):void {if(!this.state)return;this.state=null;this.ports.end(cancel);}
}
