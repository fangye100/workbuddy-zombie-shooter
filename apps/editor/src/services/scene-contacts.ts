import { DYNAMIC_INSTANCE_FLOATS, type CoreDynamicBatch } from '@aether/render';

interface ContactObject {
  visible:boolean; background:boolean; localMin:readonly number[]; localMax:readonly number[];
  modelMatrix:ArrayLike<number>;
}

/** Pure derived rendering data. Authored transforms and runtime instances remain the owners. */
export class SceneContacts {
  private readonly bounds=new WeakMap<Float32Array,number[]>();
  private data=new Float32Array(0);
  build(objects:readonly ContactObject[],batches:readonly CoreDynamicBatch[]|null):Float32Array<ArrayBuffer> {
    const max=objects.length+(batches??[]).reduce((n,b)=>n+b.count,0);
    if(this.data.length<max*8)this.data=new Float32Array(Math.max(512,max*8));
    let at=0;
    const put=(x:number,y:number,z:number,yaw:number,rx:number,rz:number)=>{
      if(![x,y,z,yaw,rx,rz].every(Number.isFinite))return;
      this.data.set([x,y+0.016,z,yaw,Math.max(0.12,rx),Math.max(0.12,rz),0,0],at);at+=8;
    };
    for(const o of objects){
      if(!o.visible||o.background)continue;
      const lo=o.localMin,hi=o.localMax,m=o.modelMatrix;
      const sx=Math.hypot(m[0]!,m[1]!,m[2]!),sy=Math.hypot(m[4]!,m[5]!,m[6]!),sz=Math.hypot(m[8]!,m[9]!,m[10]!);
      const h=(hi[1]!-lo[1]!)*sy,rx=(hi[0]!-lo[0]!)*sx*0.5,rz=(hi[2]!-lo[2]!)*sz*0.5;
      if(h<0.5||rx>7||rz>7)continue; // surfaces and large buildings need authored/map shadows, not blobs
      const x=(lo[0]!+hi[0]!)*0.5,z=(lo[2]!+hi[2]!)*0.5,y=lo[1]!;
      put(m[0]!*x+m[4]!*y+m[8]!*z+m[12]!,m[1]!*x+m[5]!*y+m[9]!*z+m[13]!,m[2]!*x+m[6]!*y+m[10]!*z+m[14]!,Math.atan2(m[8]!,m[10]!),rx,rz);
    }
    for(const b of batches??[]){
      let bounds=this.bounds.get(b.vertices);
      if(!bounds){
        let minY=Infinity,minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
        for(let i=0;i<b.vertices.length;i+=15){minY=Math.min(minY,b.vertices[i+1]!);minX=Math.min(minX,b.vertices[i]!);maxX=Math.max(maxX,b.vertices[i]!);minZ=Math.min(minZ,b.vertices[i+2]!);maxZ=Math.max(maxZ,b.vertices[i+2]!);}
        bounds=[minY,(maxX-minX)*0.5,(maxZ-minZ)*0.5];this.bounds.set(b.vertices,bounds);
      }
      for(let i=0;i<Math.min(b.count,Math.floor(b.instances.length/DYNAMIC_INSTANCE_FLOATS));i++){
        const a=i*DYNAMIC_INSTANCE_FLOATS,v=b.instances;
        put(v[a]!,v[a+1]!+bounds[0]!*v[a+5]!,v[a+2]!,v[a+3]!,bounds[1]!*v[a+4]!,bounds[2]!*v[a+6]!);
      }
    }
    return this.data.subarray(0,at);
  }
}
