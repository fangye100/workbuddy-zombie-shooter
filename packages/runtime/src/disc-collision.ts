/** 地面圆盘的静态连续碰撞；不持有游戏状态，也不从 mesh 猜测碰撞内容。 */
export interface DiscPoint { x: number; z: number }
export interface DiscSolid {
  x: number; z: number; halfX: number; halfZ: number;
  /** 非 box 的水平投影为圆。 */
  radius: number; shape: 'box' | 'sphere' | 'capsule'; enabled: boolean;
}
export interface DiscBounds { minX: number; minZ: number; maxX: number; maxZ: number }

const EPS = 1e-5;

/** 连续移动圆盘对站定圆盘的首次接触比例；初始重叠只允许向外脱离。 */
export function discContactFraction(x:number,z:number,toX:number,toZ:number,radius:number,otherX:number,otherZ:number,otherRadius:number): number {
  const dx=toX-x,dz=toZ-z,rx=x-otherX,rz=z-otherZ;
  const a=dx*dx+dz*dz,b=rx*dx+rz*dz,r=radius+otherRadius,c=rx*rx+rz*rz-r*r;
  if(a<1e-16 || b>=0)return 1;
  if(c<=0)return 0;
  const discriminant=b*b-a*c;
  if(discriminant<0)return 1;
  const hit=(-b-Math.sqrt(discriminant))/a;
  return hit>=0 && hit<=1 ? Math.max(0,hit-2e-5/Math.sqrt(a)):1;
}

/** box 使用保守的半径扩展矩形；圆形障碍使用真实圆形投影。查询期不分配对象。 */
export class DiscCollisionWorld {
  private hitT = 1;
  private normalX = 0;
  private normalZ = 0;
  private hitGap = EPS * .1;

  constructor(readonly bounds: Readonly<DiscBounds>, private readonly solids: readonly DiscSolid[]) {
    if (![bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ].every(Number.isFinite)
      || bounds.maxX<=bounds.minX || bounds.maxZ<=bounds.minZ) throw new RangeError('Invalid collision bounds');
    for (const s of solids) if (![s.x,s.z,s.halfX,s.halfZ,s.radius].every(Number.isFinite)
      || s.halfX<0 || s.halfZ<0 || s.radius<0) throw new RangeError('Invalid collision solid');
  }

  canOccupy(x: number, z: number, radius: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius<0) return false;
    const b=this.bounds;
    if (x<b.minX+radius-EPS || x>b.maxX-radius+EPS || z<b.minZ+radius-EPS || z>b.maxZ-radius+EPS) return false;
    for (const s of this.solids) {
      if (!s.enabled) continue;
      if (s.shape==='box') {
        if (Math.abs(x-s.x)<s.halfX+radius-EPS && Math.abs(z-s.z)<s.halfZ+radius-EPS) return false;
      } else if (Math.hypot(x-s.x,z-s.z)<s.radius+radius-EPS) return false;
    }
    return true;
  }

  /** 移动、击退和突扑经过同一 sweep；false 表示起点也无法找到合法位置。 */
  move(x: number, z: number, toX: number, toZ: number, radius: number, out: DiscPoint): boolean {
    if (![x,z,toX,toZ,radius].every(Number.isFinite) || radius<0) throw new RangeError('Invalid disc movement');
    const b=this.bounds;
    if (2*radius>b.maxX-b.minX || 2*radius>b.maxZ-b.minZ) {out.x=x;out.z=z;return false;}
    // 初始重叠显式去穿透；不是跨墙 teleport 到目标。
    let px=Math.min(b.maxX-radius,Math.max(b.minX+radius,x)),pz=Math.min(b.maxZ-radius,Math.max(b.minZ+radius,z));
    for (let pass=0;pass<4;pass++) for (const s of this.solids) {
      if (!s.enabled) continue;
      const dx=px-s.x,dz=pz-s.z;
      if (s.shape==='box') {
        const ex=s.halfX+radius,ez=s.halfZ+radius;
        if (Math.abs(dx)>=ex || Math.abs(dz)>=ez) continue;
        if (ex-Math.abs(dx)<ez-Math.abs(dz)) px=s.x+(dx<0?-1:1)*(ex+EPS);
        else pz=s.z+(dz<0?-1:1)*(ez+EPS);
      } else {
        const length=Math.hypot(dx,dz),r=s.radius+radius;
        if (length<r) {px=s.x+(length>EPS?dx/length:1)*(r+EPS);pz=s.z+(length>EPS?dz/length:0)*(r+EPS);}
      }
      px=Math.min(b.maxX-radius,Math.max(b.minX+radius,px));pz=Math.min(b.maxZ-radius,Math.max(b.minZ+radius,pz));
    }
    if (!this.canOccupy(px,pz,radius)) {out.x=x;out.z=z;return false;}
    let dx=toX-x,dz=toZ-z;
    for (let slide=0;slide<3 && Math.hypot(dx,dz)>EPS;slide++) {
      this.hitT=1;this.normalX=0;this.normalZ=0;this.hitGap=EPS*.1;
      if (dx<0) this.hit((b.minX+radius-px)/dx,1,0);
      if (dx>0) this.hit((b.maxX-radius-px)/dx,-1,0);
      if (dz<0) this.hit((b.minZ+radius-pz)/dz,0,1);
      if (dz>0) this.hit((b.maxZ-radius-pz)/dz,0,-1);
      for (const s of this.solids) {
        if (!s.enabled) continue;
        if (s.shape==='box') this.boxHit(px,pz,dx,dz,s.x-s.halfX-radius,s.z-s.halfZ-radius,s.x+s.halfX+radius,s.z+s.halfZ+radius);
        else {
          const rx=px-s.x,rz=pz-s.z,a=dx*dx+dz*dz,halfB=rx*dx+rz*dz,c=rx*rx+rz*rz-(radius+s.radius)**2;
          if (halfB>=0) continue;
          const discriminant=halfB*halfB-a*c;
          if (discriminant<0) continue;
          const t=(-halfB-Math.sqrt(discriminant))/a;
          const nx=rx+dx*t,nz=rz+dz*t,l=Math.hypot(nx,nz);
          if (l>EPS) this.hit(t,nx/l,nz/l,EPS*2);
        }
      }
      const t=Math.max(0,this.hitT-this.hitGap/Math.max(EPS,Math.hypot(dx,dz)));
      if (this.hitT===1 && this.normalX===0 && this.normalZ===0) {px+=dx;pz+=dz;break;}
      px+=dx*t;pz+=dz*t;dx*=1-t;dz*=1-t;
      const normal=dx*this.normalX+dz*this.normalZ;
      if (normal<0) {dx-=normal*this.normalX;dz-=normal*this.normalZ;}
    }
    out.x=px;out.z=pz;
    return this.canOccupy(px,pz,radius);
  }

  private hit(t: number, nx: number, nz: number, gap=EPS*.1): void {
    if (t>=-EPS && t<=this.hitT && t<=1) {this.hitT=Math.max(0,t);this.normalX=nx;this.normalZ=nz;this.hitGap=gap;}
  }

  private boxHit(x: number,z: number,dx: number,dz: number,minX: number,minZ: number,maxX: number,maxZ: number): void {
    let entry=-Infinity,exit=Infinity,nx=0,nz=0;
    if (Math.abs(dx)<1e-12) {if (x<=minX || x>=maxX) return;}
    else {
      const a=(minX-x)/dx,c=(maxX-x)/dx,lo=Math.min(a,c),hi=Math.max(a,c);
      if (lo>entry) {entry=lo;nx=dx>0?-1:1;nz=0;}exit=Math.min(exit,hi);
    }
    if (Math.abs(dz)<1e-12) {if (z<=minZ || z>=maxZ) return;}
    else {
      const a=(minZ-z)/dz,c=(maxZ-z)/dz,lo=Math.min(a,c),hi=Math.max(a,c);
      if (lo>entry) {entry=lo;nx=0;nz=dz>0?-1:1;}exit=Math.min(exit,hi);
    }
    if (entry<=exit && exit>=0 && entry>=-EPS) this.hit(entry,nx,nz,EPS*2);
  }
}
