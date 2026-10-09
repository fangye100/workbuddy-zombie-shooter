/** Read-only navigation contract. Scene_get and tools/list remain the live data/schema owners. */
export const EDITOR_INSTRUCTIONS = 'Read editor_workflow, then editor_instances and explicitly select the intended instance. Read scene_get before writing; use its state.revision as expectedRevision. Validate, save, reopen and compare authored fields. Inspect editor_runtime for weapons/audio and Play cleanup. GPU canvas capture excludes DOM UI; rendering acceptance requires headed hardware GPU evidence. Never blindly retry a timed-out write.';

export function editorWorkflow() {
  return {
    contractVersion: 2,
    knowledge: {
      entry:'docs/README.md', catalog:'docs/knowledge/catalog.json',
      architecture:'docs/architecture/layers.md', codeGraph:'docs/knowledge/codegraph.md',
      rule:'Source contracts govern behavior; design intent and historical acceptance are separately classified. Query CodeGraph before architecture/dependency changes.',
    },
    guide: 'docs/43-GameplayDevelopmentWorkflow.md',
    transport: 'tools/mcp-editor/README.md',
    instructions: EDITOR_INSTRUCTIONS,
    sources: {
      project: 'aether.project.json', sceneSchema: 'packages/scene/src/document.ts',
      weapons: 'packages/scene/src/weapons.ts', audio: 'packages/scene/src/audio.ts',
      assetMetadata: 'packages/scene/src/asset-meta.ts',
    },
    stages: [
      { id:'discover', tools:['editor_workflow','editor_instances','scene_list','scene_get'], rule:'Workflow discovery needs no browser instance. Business calls target an exact live instance UUID.' },
      { id:'author', tools:['scene_create','scene_open','scene_edit_nodes','scene_set_environment','scene_history'], rule:'Use stable NodeId and AssetRef path/GUID. Node/environment replacement takes the full current value. Preserve unrelated fields, human drafts and Play locks.' },
      { id:'persist', tools:['scene_validate','scene_save','scene_open','scene_get'], rule:'Validate, save, reopen the registered scene and compare the fields you changed. Creation registers a scene but does not switch to it.' },
      { id:'verify', tools:['editor_play','editor_runtime','editor_capture'], rule:'Start enters paused Play; step is deterministic simulation coverage. Audio requires a trusted Ready/Resume gesture. Stop restores author data. Canvas capture excludes DOM HUD and does not establish listening or phone acceptance.' },
    ],
    topics: [
      { id:'visuals-and-lod', guide:'docs/36-StreetQualityAndArchitecturalLOD.md', reusable:'docs/art/visual-quality-playbook.md' },
      { id:'npc-and-input', guide:'docs/37-CombatInputAndPopulationQuality.md' },
      { id:'weapons-and-ik-ports', guide:'docs/39-Unified-weapons-and-animation-hooks.md' },
      { id:'audio', guide:'docs/42-GameplayAudioIntegration.md', resourceBrief:'docs/40-GameplayAudioAssetBrief.md' },
    ],
    recovery: {
      REVISION_CONFLICT:'Read scene_get again and rebase only the intended changes.',
      UI_DRAFT:'Coordinate with the human to apply or discard the active form draft.',
      PLAY_LOCKED:'Stop Play before authoring.',
      NOT_READY:'Wait for scene projection/assets to settle and inspect state.',
      CONFLICT:'Disk save conflict: preserve local changes and compare disk contents before retrying.',
      COMMAND_FAILED:'Inspect returned state/revision; projection failure can leave an applied author edit.',
      TIMEOUT:'The write may have executed. Inspect state and disk before any retry.',
      EDITOR_DISCONNECTED:'Rediscover instances; never substitute another tab automatically.',
    },
    checks: { transport:'node --test tools/mcp-editor/*.test.mjs', types:'pnpm run typecheck', build:'pnpm run editor:build', assets:'pnpm run scene:check', architecture:'pnpm run architecture:check', knowledge:'pnpm run knowledge:check' },
    limits: [
      'Opt-in broker and selected tab; client registration is a separate setup action.',
      'Generic component editing exists; semantic asset/component discovery and dedicated weapon/audio authoring commands are not implemented.',
      'No rig/IK authoring, animation resource generation, runtime equipment command or browser autoplay bypass in this server.',
      'Read-only weapons/audio diagnostics expose current facts, not a second simulation or durable scene state.',
      'Existing live material roundtrip evidence is scoped; reconnect and all asynchronous human-edit races are not certified.',
    ],
  };
}
