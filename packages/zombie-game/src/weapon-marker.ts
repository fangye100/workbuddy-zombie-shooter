import type {RuntimeSession} from './session';
/** Shared with the existing visible weapon: same mount, marker and procedural recoil. */
export function weaponMarkerWorld(runtime:RuntimeSession,marker:'primaryGrip'|'muzzle'|'supportGrip'|'magazine'|'chamber',recoil=true):[number,number,number] {
  const player=runtime.player(),pose=runtime.weapons.poseIntent,p=pose.markers[marker].position;
  const x=p[0]+(recoil?pose.recoil.translation[0]:0),y=p[1]+(recoil?Math.sin(pose.recoil.pitchDeg*Math.PI/180)*p[0]:0),z=p[2];
  const yaw=player?.yaw??0,dx=Math.cos(yaw),dz=Math.sin(yaw);
  return [(player?.x??0)+dx*x-dz*z,runtime.weaponMount.position[1]+y,(player?.z??0)+dz*x+dx*z];
}
