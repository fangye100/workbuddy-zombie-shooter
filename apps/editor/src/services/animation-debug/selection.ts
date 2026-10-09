import type { DebugDecision, DebugRule } from './contracts';
export interface WeaponMotion { action: string; clip: string; fallback: string; weaponId: string; startTick: number; phase: number }
export interface SceneChoiceInput {
  states: Record<string, unknown>; defaultState: string; speed: number; keepGait: boolean;
  firing: boolean; weapon: WeaponMotion | null | undefined; runId: number;
}
/** Shared by execution and observation. Ordering intentionally preserves the presentation owner. */
export function sceneChoice(i: SceneChoiceInput, trace = false) {
  const has = (name: string): boolean => !!i.states[name];
  const w = i.weapon;
  const locomotion = i.speed > 2.5 && has('run') ? 'run' : i.speed > .05 ? 'walk' : 'idle';
  const candidates = w && w.action !== 'idle' && !(w.action === 'fire' && i.keepGait)
    ? [w.clip, w.action === 'fire' ? 'shoot' : w.action, w.fallback] : [];
  const requested = candidates.find(has);
  const legacyShoot = !w && i.firing && !i.keepGait && has('shoot');
  const state = requested ?? (legacyShoot ? 'shoot' : locomotion);
  const resolved = has(state) ? state : i.defaultState;
  const stamp = w && w.action !== 'idle' ? `${i.runId}:${w.weaponId}:${w.action}:${w.startTick}` : '';
  const rules: DebugRule[] = trace ? [
    { id: 'weapon', label: '武器动作（最高自动优先级）', matched: candidates.length > 0, selected: requested !== undefined,
      reason: w ? `action=${w.action}; ${candidates.map(s => `${s}:${has(s) ? '有片' : '缺片'}`).join(' → ') || (i.keepGait && w.action === 'fire' ? '有效瞄准 IK 保留步态' : '动作 idle')}` : '无武器动作系统' },
    { id: 'legacy-fire', label: '旧开火输入', matched: !!i.firing, selected: requested === undefined && legacyShoot,
      reason: w ? '武器系统已接管，输入本身不触发动画' : i.keepGait ? '有效瞄准 IK 保留步态' : `shoot=${has('shoot')}` },
    { id: 'run', label: '跑步 speed > 2.5', matched: i.speed > 2.5 && has('run'), selected: !requested && !legacyShoot && locomotion === 'run', reason: `${i.speed.toFixed(3)} m/s; run=${has('run')}` },
    { id: 'walk', label: '行走 speed > 0.05', matched: i.speed > .05, selected: !requested && !legacyShoot && locomotion === 'walk', reason: `${i.speed.toFixed(3)} m/s; walk=${has('walk')}` },
    { id: 'idle', label: '静止', matched: i.speed <= .05, selected: !requested && !legacyShoot && locomotion === 'idle', reason: `${i.speed.toFixed(3)} m/s` },
  ] : [];
  const decision: DebugDecision | null = trace ? { requested: candidates[0] ?? state, actual: resolved,
    source: requested ? 'weapon' : legacyShoot ? 'legacy-fire' : 'locomotion',
    fallback: resolved !== (candidates[0] ?? state) ? `${candidates[0] ?? state} → ${resolved}` : null, actionStamp: stamp, rules } : null;
  return { requested, state: resolved, stamp, decision };
}
export function behaviorClipName(behavior: number): string {
  return ({ 0: 'idle', 1: 'walk', 2: 'attack', 4: 'idle' } as Record<number, string>)[behavior] ?? 'idle';
}
export function behaviorClipIndex(clips: readonly { name: string }[], behavior: number): number {
  if (!clips.length) return -1;
  const index = clips.findIndex(c => c.name === behaviorClipName(behavior));
  return index < 0 ? 0 : index;
}
export function paletteChoice(clips: readonly { name: string }[], behavior: number, weapon: WeaponMotion | null, trace = false) {
  const active = weapon && weapon.action !== 'idle';
  const weaponIndex = active ? clips.findIndex(c => c.name === weapon.clip) : -1;
  const actionName = active ? weapon.action === 'fire' ? 'shoot' : weapon.action : '';
  const actionIndex = active ? clips.findIndex(c => c.name === actionName) : -1;
  const fallbackBehavior = active && weapon.action === 'fire' ? 2 : behavior;
  const index = weaponIndex >= 0 ? weaponIndex : actionIndex >= 0 ? actionIndex : behaviorClipIndex(clips, fallbackBehavior);
  const requested = active ? weapon.clip : behaviorClipName(behavior), actual = index < 0 ? 'bind pose' : clips[index]!.name;
  const decision: DebugDecision | null = trace ? { requested, actual, source: active ? 'weapon' : 'behavior',
    fallback: actual !== requested ? `${requested} → ${actual}${index === 0 ? ' (clip 0)' : ''}` : null,
    actionStamp: active ? `${weapon.weaponId}:${weapon.action}:${weapon.startTick}` : '', rules: trace ? [
      { id: 'weapon', label: '武器 clip → action 别名', matched: !!active, selected: weaponIndex >= 0 || actionIndex >= 0,
        reason: active ? `${weapon.clip} index=${weaponIndex}; ${actionName} index=${actionIndex}; fire 继续回退 attack，其余回退行为` : 'NPC / 无活动武器动作' },
      { id: 'behavior', label: '行为映射', matched: true, selected: weaponIndex < 0 && actionIndex < 0,
        reason: `behavior=${behavior}; requested=${behaviorClipName(fallbackBehavior)}; 缺片回 clip 0，空库回 bind pose` },
    ] : [] } : null;
  return { index, decision };
}
