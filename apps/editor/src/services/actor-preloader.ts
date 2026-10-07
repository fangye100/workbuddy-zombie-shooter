import type { SceneDocument } from '@aether/scene';

interface Library {
  preload(id: string): Promise<boolean>;
  resetFailure(id: string): void;
}

/** Runtime demand, not the asset catalog, owns the Play preload set. Future waves
 * are included; debug/script-created entities can request an additional actor.
 */
export function sceneActorIds(doc: SceneDocument): string[] {
  return [...new Set(doc.nodes.flatMap(node => node.components.flatMap(c =>
    c.kind === 'SpawnPoint' && c.enabled && c.count > 0 ? [c.characterId] : [])))];
}

export class ActorPreloader {
  private generation = 0;
  private active = false;
  private pending = new Set<string>();
  private requested = new Set<string>();
  private running: number | null = null;
  constructor(private readonly library: Library, private readonly ready: Promise<unknown>,
    private readonly changed: () => void, private readonly failed: (error: unknown) => void) {}
  start(doc: SceneDocument): void {
    this.stop(); this.active = true;
    for (const id of sceneActorIds(doc)) this.request(id);
  }
  stop(): void {
    this.generation++; this.active = false; this.pending.clear(); this.requested.clear(); this.running = null;
  }
  request(id: string): void {
    if (!this.active || this.requested.has(id)) return;
    this.requested.add(id); this.pending.add(id);
    if (this.running === null) void this.drain(this.generation);
  }
  private async drain(generation: number): Promise<void> {
    this.running = generation;
    try {
      await this.ready;
      while (this.active && generation === this.generation && this.pending.size) {
        const id = this.pending.values().next().value!; this.pending.delete(id);
        const changed = await this.library.preload(id);
        if (generation !== this.generation || !this.active) { this.library.resetFailure(id); return; }
        if (changed) this.changed();
      }
    } catch (error) { if (this.active && generation === this.generation) this.failed(error); }
    finally { if (this.running === generation) this.running = null; }
  }
}
