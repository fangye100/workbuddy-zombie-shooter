/**
 * WU-03!É©Ð† session!û…Ðˆõ‹ï—üšgeneration!î‰Í« + Stop"Ç‹Ô¾ô§Û®À‚
 *!îžÙ…Ê¢ý½ Rapier WASMÀ‚
 */
import { describe, it, expect } from 'vitest';
import { createFracturePhysicsSession } from '../src/fracture-physics-session';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
const h = (key: string): FractureBodyHandle => ({ key, chunkId: key, layer: 'rigid' });

describe('É©Ð† session û…Ð‹üˆî¿ø»ê„û…Ð‰Å¥Ï£ü‰', () => {
  it('start È›û»Ë¬ë‹Ðë¯ü›dispose!ÜŸîžÇ‹Ô¾ø–ô§Û®ý’Û¶', async () => {
    const s = createFracturePhysicsSession();
    const backend = await s.start({ fixedStepSec: STEP });
    expect(backend).not.toBeNull();
    expect(s.backend).toBe(backend);
    backend!.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    backend!.addBody(h('a'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    expect(backend!.ledger.dynamicBodies).toBe(1);
    s.dispose();
    expect(s.disposed).toBe(true);
    expect(s.backend).toBeNull();
    expect(backend!.ledger.destroyed).toBe(true);
    expect(backend!.ledger.dynamicBodies).toBe(0);
  });

  it('dispose!ÐŽÿŸÈ±Ú„ start!øäô» backengüˆüƒí¥Èç‹Ì–ÿŸÈ±Ï—öˆü‰', async () => {
    const s = createFracturePhysicsSession();
    const pending = s.start({ fixedStepSec: STEP });
    s.dispose(); // Èç‹Ì– resolve É Stop
    const result = await pending;
    expect(result).toBeNull();
    expect(s.backend).toBeNull();
  });

  it('ø¥øª session!Ú„ World"Ú”æ»ü›ø€øª dispose!øý±ÓÏ§ø€øª', async () => {
    const s1 = createFracturePhysicsSession();
    const s2 = createFracturePhysicsSession();
    const b1 = await s1.start({ fixedStepSec: STEP });
    const b2 = await s2.start({ fixedStepSec: STEP });
    b1!.addBody(h('x'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    b2!.addBody(h('y'), { position: [5, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    s1.dispose();
    expect(s1.backend).toBeNull();
    // s2 ûË­ë‹Ï¯Ô¨
    b2!.step(0);
    expect(b2!.snapshot(h('y'))).not.toBeNull();
    expect(b2!.ledger.destroyed).toBe(false);
    s2.dispose();
  });

  it('Çä dispose!î‰Å¨', async () => {
    const s = createFracturePhysicsSession();
    await s.start({ fixedStepSec: STEP });
    s.dispose();
    expect(() => s.dispose()).not.toThrow();
    expect(s.backend).toBeNull();
  });
});
