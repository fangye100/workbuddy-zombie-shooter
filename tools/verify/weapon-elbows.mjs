/** 只读actor-local肘弯曲观测：相对肩→手轴的正交bend与作者pole同向。 */
export function elbowEvidence(joints,binding) {
 const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),sub=(a,b)=>a.map((v,i)=>v-b[i]),norm=a=>Math.hypot(...a),out=[];
 for(const side of ['Left','Right']){
  const control=binding?.controls?.find(c=>c.part===side.toLowerCase()+'Hand'),points=['Arm','ForeArm','Hand'].map(b=>joints?.find(j=>j.name.replace(/^mixamorig[:_]?/i,'')===side+b)?.position);
  if(!control||points.some(p=>!p?.every(Number.isFinite))){out.push({side,ok:false,reason:'missing chain/pole'});continue;}
  const axis=sub(points[2],points[0]),length=norm(axis);if(length<1e-8){out.push({side,ok:false,reason:'coincident shoulder/hand'});continue;}
  const e=axis.map(v=>v/length),upper=sub(points[1],points[0]),bend=upper.map((v,i)=>v-dot(upper,e)*e[i]),pole=control.pole.map((v,i)=>v-dot(control.pole,e)*e[i]),bendM=norm(bend),poleLength=norm(pole);
  const projectionM=poleLength>1e-8?dot(bend,pole)/poleLength:null;
  out.push({side,ok:projectionM!==null&&(bendM<1e-5||projectionM>0),straight:bendM<1e-5,bendM,projectionM,bend,pole:control.pole,shoulder:points[0],elbow:points[1],hand:points[2]});
 }
 return {ok:out.length===2&&out.every(e=>e.ok),chains:out};
}
