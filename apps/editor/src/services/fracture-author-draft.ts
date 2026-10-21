import { migrateFractureAsset, type FractureAsset } from '@aether/scene';
import { changedJsonPaths } from '@aether/runtime';

/** 作者参数不重新制作离线几何；只读身份/坐标/代理形状不能被高级JSON悄悄重写。 */
export function fractureAuthorDraft(value: unknown, baseline: FractureAsset): FractureAsset {
  const next=migrateFractureAsset(value);
  const allowed=/^(name|playback\.(priority|lifetimeSec|fadeSec)|chunks\[\d+\]\.(class|proxy\.(mass|friction|restitution|collisionGroup|maxLinearSpeed|maxAngularSpeed)))$/;
  const rejected=changedJsonPaths(baseline,next).find(change=>!allowed.test(change.path));
  if(rejected)throw new Error('离线配方的身份/来源/坐标/代理形状及未支持字段为只读：'+rejected.path+'；当前草稿已保留');
  return next;
}
