/** Generic transient mesh feedback. Original lighting/material/outline remain the base. */
export const SURFACE_EFFECTS_WGSL=/* wgsl */ `
fn impactSurface(color:vec3f,normal:vec3f,view:vec3f,local:vec3f,pulse:f32)->vec3f {
  let p=clamp(pulse,0.0,1.0);
  let edge=pow(1.0-clamp(abs(dot(normal,view)),0.0,1.0),2.0);
  let band=smoothstep(0.45,0.6,fract(local.y*4.5+p*1.7));
  let hot=vec3f(2.4,1.3,0.38)*(0.3+edge*1.2+band*0.25);
  return mix(color,hot+color*0.2,p*p*0.8);
}
`;
