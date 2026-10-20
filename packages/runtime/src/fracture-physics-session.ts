/**
 * WU-03!É©Ğ‡Ğë¯üšïû„Ğ‹ü›ÊŠ RapierFractureBackend!Ì‚ÿ› Preview/Play!üÔŸÑ½Ñ©ÜŸÀ‚
 *
 * WASM!è¡İ—û£àû ensureRapier()!Å±ú«ü›World/body/collider Ì‰ session"Ú•æ»À‚
 * generation!î‰Í«ÿŸï Stop/Í¢Ü»Ù¯ĞÿŸÈ±Ú„üƒí¥Èç‹Ì—øäô»×§ Worldü›
 * dispose()!ÜŸîÇ‹Ô¾ù·û£ö³ÀŒStop!Ğô§Û® pending=0ÀÚ„È¥Í®À‚ÿ™Ø¯ş›î¿ø»
 *#ü‰æ‚ PlayController!Ú„ registerResourcgü‰ı¿Ô©Ú…ê„û…Ğ‰Å¥Ï£üøäÈ·ì¬úå—è¡ËŸÀ‚
 */

import { createRapierBackend, type RapierFractureBackend, type RapierBackendOptions } from './fracture-rapier';

export interface FracturePhysicsSession {
  /** ı“ÉĞë¯ü›ü‚í¥Èç‹Ì—Ü«îŒÈ‘È—÷²â« generation!Ï—öˆ×·øº nullÀ‚ */
  readonly backend: RapierFractureBackend | null;
  readonly generation: number;
  /** ÜŸîÇŠÔ¿Ğë¯ù·ı¿Ü¬ session Ú„ generation!ä±ÕˆüŠÚĞ init øÆÆ™Å§ü‰À‚ */
  dispose(): void;
  readonly disposed: boolean;
}

/**
 * È›û»ø€ø«É©Ğ† sessionÀ‚ğƒÔ©Ö¹Ü¨ Play/Preview!Ğ¯Ê¨×¶ newüÜ¨ Stop!×¶ dispose()
 *#üŠÀšø¹û PlaySession.registerResource!Ù»î³ü‰À‚Ï¯ÚĞğƒÔ¨ start()!ü‚í¥Èç‹Ì—ü›
 *"Ë¥Ü¨Èç‹Ì– resolve É dispose()üŒbackend!ÿÌ nuloüˆÿŸÈ±Ï–ö‹ü‰À‚
 */
export function createFracturePhysicsSession(): FracturePhysicsSession & {
  start(opts: RapierBackendOptions): Promise<RapierFractureBackend | null>;
} {
  let generation = 0;
  let backend: RapierFractureBackend | null = null;
  let disposed = false;
  return {
    get backend() { return backend; },
    get generation() { return generation; },
    get disposed() { return disposed; },
    async start(opts: RapierBackendOptions): Promise<RapierFractureBackend | null> {
      const myGen = generation;
      const created = await createRapierBackend(opts, () => !disposed && generation === myGen);
      if (created === null) return null;
      // úì¡îˆÍ«üšawait!ÜŸ×¶Ë§â« disposgüŒcreated øº nuloüˆøü›È°ÿ›Çü‰ü›
      // Ë¥ generation!÷³Ï˜ü‰Ö° starwü‰üøæ†Û—Ö° backendÀ‚
      if (disposed || generation !== myGen) { created.destroy(); return null; }
      backend = created;
      return created;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation++;
      if (backend) { backend.destroy(); backend = null; }
    },
  };
}
