/** Read-only guidance for clients; settings below are delivery recommendations,
 * not mutations or a second owner of BindingSession defaults.
 */
export const BINDING_WORKFLOW = {
  version: 1,
  authoringOwner: '<source>.glb.meta.json.bindingEditor',
  coordinates: 'normalized source-model local metres; never runtime actor coordinates',
  pipeline: ['weight generation', 'optional mirror', 'surface smoothing', 'rigid prop constraints'],
  stages: [
    { name: 'restore-and-review', tools: ['load_model', 'get_state', 'get_joints', 'render'],
      guidance: 'Load the source GLB, preserve saved joints, inspect front/side with grid; do not infer T-pose joints from a posed mesh.' },
    { name: 'author-and-save', tools: ['set_joint', 'cylinders', 'set_options', 'save', 'hydrate'],
      guidance: 'Change only authorized data; save must return ok:true. Conflicts preserve edits; reload and reconcile instead of overwriting a peer.' },
    { name: 'compute-and-inspect', tools: ['compute_skin', 'render'],
      guidance: 'Check final weightQuality plus volume convergence/outsideBones/projectedBones/fallbackVertices. Heatmaps and counts do not prove motion quality.' },
    { name: 'rig-export', tools: ['export_glb'],
      guidance: 'Use bindPose:source for saved non-T source poses. Export is rig-only, at the binding ruler scale; preserve source geometry and existing authoring sidecar.' },
  ],
  npcDeliveryPreset: { weightMode: 'volumetric', volumetric: { resolution: 48, depth: 1, tolerance: 0.001 },
    smoothWeights: true, smoothIters: 6, smoothLambda: 0.5, mirrorWeights: false },
  rigidProps: {
    owner: 'set_options.rigidRegions / GUI 刚性部件约束',
    exactSelection: 'Use current model.selectionHash with source vertex indices. Complete UV islands avoid cutting fused prop/body boundaries. Recompute selection after geometry changes.',
    clearing: 'rigidRegions:[] explicitly clears constraints; omitted keys retain the current configuration.',
    precedence: 'Applied after smoothing; later regions win. Selected vertices become weight 1 on the deforming bone.',
  },
  publication: {
    commands: ['node tools/rigging/export-character-rigs.mjs', 'node tools/rigging/integrate-character-rigs.mjs',
      'pnpm run scene:gen', 'pnpm run scene:check', 'pnpm run motion:check'],
    guidance: 'These scripts target the current nine-character manifest. Whole-rig physical scaling includes POSITION, local offsets and inverse bind translations. Output sidecars point back to source sessions; path+guid and sharedMotion own runtime integration.',
    runtime: 'Shared source clips are solved and cached per target rest pose, then sampled to GPU palettes. Runtime does not voxelize or reskin; no per-character copy of the Mixamo source is required.',
  },
  acceptance: { headedHardwareRequired: true, visualReviewRequired: true,
    checks: ['textured rest pose', 'idle/walk/attack/death/scream', 'held props', 'eight facing directions', 'Play/Stop resource cleanup'],
    limitations: 'Generated cloth/armor, LBS volume loss, foot-contact calibration and dedicated boss attacks need separate acceptance. Anchored actors may animate without translating.' },
  docs: ['docs/rigging/character-rigging-workflow.md', 'docs/rigging/volumetric-skinning.md',
    'docs/35-SharedMotionRuntimeRetarget.md', 'docs/rigging/character-rig-delivery-2026-10-07.md',
    'docs/rigging/character-control-2026-10-07.md'],
} as const;
