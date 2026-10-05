import type { EnvironmentData } from '@aether/scene';
import { createEmptySceneDocument, validateSceneDocument } from '@aether/scene';
export const ENVIRONMENT_EDIT_PATHS = ['ambient.color', 'ambient.intensity', 'hemisphere.sky', 'hemisphere.skyIntensity',
  'hemisphere.ground', 'hemisphere.groundIntensity', 'fog.color', 'fog.density', 'rim.color', 'rim.intensity',
  'rim.power', 'rim.topBias', 'exposure'] as const;
export const ATMOSPHERE_EDIT_PATHS = ['sky', 'comic',
  ...['zenith', 'horizon', 'ground', 'cloud', 'cloudCoverage', 'cloudScale', 'cloudSpeed', 'sunColor', 'sunSize',
    'sunDirection[0]', 'sunDirection[1]', 'sunDirection[2]'].map(key => `sky.${key}`),
  ...['tonemapMode', 'contactShadowOpacity', 'outlineWidth', 'inkColor', 'shadowMult', 'shadowMix', 'shadowTint',
    'litSat', 'halftoneStrength', 'halftoneSize', 'vignette'].map(key => `comic.${key}`),
] as const;
export function environmentValue(env: EnvironmentData, path: string): unknown {
  let value: unknown = env;
  for (const key of path.split('.')) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
export function validEnvironmentValues(env: EnvironmentData): boolean {
  // The scene schema owns optional atmosphere validation too. Never allow an edit
  // that only fails later at Save after it has already polluted undo history.
  const document = createEmptySceneDocument('environment-validation'); document.environment = env;
  if (validateSceneDocument(document).some(d => d.severity === 'error')) return false;
  return ENVIRONMENT_EDIT_PATHS.every(path => {
    const v = environmentValue(env, path);
    if (path.endsWith('color') || path === 'hemisphere.sky' || path === 'hemisphere.ground') return typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= (path === 'rim.topBias' ? 1 : 20);
  });
}
