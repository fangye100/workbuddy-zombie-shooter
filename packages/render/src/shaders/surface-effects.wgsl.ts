/** Generic transient mesh feedback. Original lighting/material/outline remain the base. */
export const SURFACE_EFFECTS_WGSL=/* wgsl */ `
fn flowField(p:vec2f,time:f32)->vec2f {
  return vec2f(sin(p.y*8.0-time*3.1)+0.45*sin(p.y*17.0+time*2.3),
    cos(p.x*7.0+time*2.1)+0.4*sin(p.y*11.0-time*4.0))*0.5;
}
fn burnSurface(color:vec3f,normal:vec3f,view:vec3f,local:vec3f,clock:f32)->vec3f {
  if(clock<=0.0){return color;}
  let t=clock-1.0;
  let curl=flowField(local.xz*1.7+vec2f(0.0,local.y*0.8),t);
  let wave=sin(local.y*14.0-t*5.0+curl.x*3.0+local.x*8.0)*0.5+0.5;
  let pattern=sin(local.x*13.0+curl.y*2.0)*sin(local.z*11.0+local.y*7.0-t*1.1)*0.5+0.5;
  let scorch=smoothstep(0.3,0.65,pattern)*0.72;
  let filament=smoothstep(0.72,0.93,wave)*smoothstep(0.25,0.6,pattern);
  let rim=pow(1.0-clamp(abs(dot(normal,view)),0.0,1.0),2.0);
  return mix(color,color*0.18,scorch)+vec3f(2.6,0.48,0.025)*(filament*0.85+rim*(0.25+wave*0.5))
    +vec3f(1.5,1.15,0.3)*pow(filament,5.0)*0.55;
}
fn impactSurface(color:vec3f,normal:vec3f,view:vec3f,local:vec3f,pulse:f32)->vec3f {
  let p=clamp(pulse,0.0,1.0);
  let edge=pow(1.0-clamp(abs(dot(normal,view)),0.0,1.0),2.0);
  let band=smoothstep(0.45,0.6,fract(local.y*4.5+p*1.7));
  let hot=vec3f(2.4,1.3,0.38)*(0.3+edge*1.2+band*0.25);
  return mix(color,hot+color*0.2,p*p*0.8);
}
`;
