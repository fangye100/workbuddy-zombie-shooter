import { writeTypedAssetWithMeta } from './project-write.mjs';

/** Caller holds the shared project lock. Preserve all sidecar fields except the source digest. */
export async function writeVfxWithMeta(abs, text) {
  await writeTypedAssetWithMeta(abs, text, 'vfx');
}
