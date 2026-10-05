import type { EnvironmentData } from '@aether/scene';
export const ENVIRONMENT_EDIT_PATHS = ['ambient.color', 'ambient.intensity', 'hemisphere.sky', 'hemisphere.skyIntensity',
  'hemisphere.ground', 'hemisphere.groundIntensity', 'fog.color', 'fog.density', 'rim.color', 'rim.intensity',
  'rim.power', 'rim.topBias', 'exposure'] as const;
export function environmentValue(env: EnvironmentData, path: string): unknown {
  let value: unknown = env;
  for (const key of path.split('.')) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
export function validEnvironmentValues(env: EnvironmentData): boolean {
  return ENVIRONMENT_EDIT_PATHS.every(path => {
    const v = environmentValue(env, path);
    if (path.endsWith('color') || path === 'hemisphere.sky' || path === 'hemisphere.ground') return typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= (path === 'rim.topBias' ? 1 : 20);
  });
}
