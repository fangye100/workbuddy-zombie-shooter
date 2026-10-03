import type { EnvironmentData } from '@aether/scene';
import type { LabParams } from '../params';
/** Preserve unexposed environment fields and only author the controls with a scene contract. */
export function environmentFromParams(base: EnvironmentData, p: LabParams): EnvironmentData {
  return { ...structuredClone(base),
    ambient: { ...base.ambient, color: p.ambientColor, intensity: p.ambientIntensity },
    hemisphere: { ...base.hemisphere, sky: p.fillSkyColor, skyIntensity: p.fillSkyIntensity,
      ground: p.fillGroundColor, groundIntensity: p.fillGroundIntensity },
    fog: { ...base.fog, color: p.fogColor, density: p.fogDensity },
    rim: { ...base.rim, color: p.rimColor, intensity: p.rimIntensity, power: p.rimPower, topBias: p.rimTopBias },
    exposure: p.exposure,
  };
}
