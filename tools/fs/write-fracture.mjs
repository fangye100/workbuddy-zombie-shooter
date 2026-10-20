import { writeTypedAssetWithMeta } from './project-write.mjs';

/** Fracture profile save: same transactional contract as VFX (CAS + sidecar digest). */
export async function writeFractureWithMeta(abs, text) {
  await writeTypedAssetWithMeta(abs, text, 'fracture');
}
