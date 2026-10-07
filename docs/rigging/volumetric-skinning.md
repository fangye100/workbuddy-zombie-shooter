# Volumetric skinning in Skeleton / Skin Process

Select **Volumetric** in the binding panel's weight algorithm dropdown. The solver
uses the saved source-pose joints and source mesh; it does not move joints or modify
the author mesh. Preview, heatmap, MCP and GLB export use the same BindingSession
pipeline: weight generation, optional mirror, optional surface smoothing, authored
rigid prop constraints.

## Method and ownership

`volumetric-volume.ts` builds a triangle BVH, classifies solid interiors with
hierarchical generalized winding numbers, and retains a conservative surface band
for thin or imperfectly closed parts. Boundary cells subdivide locally; interior
cells stay coarse. Coarse/fine neighbors exchange weights with symmetric
face-area / center-distance conductance.

`volumetric-skin.ts` seeds the saved bone segments, excludes tip bones, and solves
a screened finite-volume Laplacian with preconditioned conjugate gradients. It
samples cell-centered fields onto vertices, keeps four influences, and normalizes
them. This is volume diffusion, not inverse shortest-path weighting.

BindingSession owns parameters, history, input fingerprints and cached weights.
The browser delegates the CPU solve to a disposable Worker. A new input cancels
the old Worker; late results cannot overwrite a different model or newer edit.
MCP runs the same pure solver in Node. Runtime rendering and animation retarget
do not run voxelization or diffusion.

This implementation takes architectural inspiration from [Adaptive Auto Skinning's
published method](https://jessyleite.dev/posts/new-automatic-skinning-method-blender/).
It is independently implemented. It does **not** include that product's proprietary
compute core, GPU V-cycle solver, face-specific rules or performance claims.
Boundary refinement currently covers all near-surface cells rather than selecting
only close pairs of distinct surfaces. GPU acceleration is not implemented.

## Reproducible settings

The sidecar `bindingEditor` stores `weightMode: "volumetric"` and:

```json
{
  "volumetric": { "resolution": 48, "depth": 1, "tolerance": 0.001 }
}
```

- Resolution: 16–96 cells across the longest mesh axis, default 48.
- Depth: 0–2 local refinement levels, default 1.
- Tolerance: relative residual 0.0001–0.01; fast 0.01, balanced 0.001, high 0.0001.
- Maximum occupied leaves: 180,000; maximum CG iterations per bone: 240.

Invalid parameters fail before editing history/state. Old sidecars keep the
existing wrapper default. Save/reload and Undo/Redo preserve volumetric settings.
Algorithm revision `adaptive-volume-diffusion-v2` participates in the cache key
and is returned with diagnostics.

V2 can project an otherwise unseeded bone onto the nearest occupied cell only
within the minimum of 12cm, one quarter of its segment length and two coarse cells.
It reports `projectedBones` with distances. It preserves saved joint positions;
larger placement errors remain `outsideBones` and require author correction.

## Held props and exact source selections

The panel's **刚性部件约束** JSON and MCP `set_options.rigidRegions` share the same
validated, saved, undoable configuration. Capsules use `name`, a deforming `bone`,
`start`, `end`, `radius` and optional `feather`, in source binding coordinates (meters).
Their interior becomes 100% rigid; the feather blends into existing normalized
weights. Constraints apply after surface smoothing, and later entries win.

For a prop fused into another body part, capsule boundaries can cut triangles.
An exact region may also contain `vertices` (source vertex indices) and
`selectionHash` from `skinSelectionHash(sourceVertices)`. This overrides the capsule
selection and locks each selected vertex to one bone. Invalid indices or a changed
source mesh are rejected before editing state; no silent remapping occurs. The hash
is a geometry change guard, not a cryptographic provenance signature. The sidecar's
SHA-256 remains the asset provenance guard.

B-03's IV stand/bag/tubes use complete source UV islands selected through geometry
review, assigned to `LeftHand` (3,060 source vertices). The body's weight field still
uses volumetric diffusion. The selection is stored in the textured source sidecar;
generated rigs point back to that authoring session rather than hydrating source
vertex selections onto a normalized output mesh.

MCP example:

```json
{
  "weightMode": "volumetric",
  "volumetric": { "resolution": 48, "depth": 1, "tolerance": 0.001 }
}
```

Pass this to `set_options`, then call `compute_skin`, `render`, `save`, and
`export_glb`. `export_glb` recomputes from the captured configuration, and accepts
`bindPose: "source"` to preserve the original rest pose.

## Diagnostics and acceptance

The UI and MCP expose occupied/refined cells, cell size, connected components,
unseeded components, bones without a valid volume seed, fallback vertices,
relative residual, convergence and solve time. Unseeded disconnected parts are
anchored to their nearest bone explicitly and counted. Vertices with no usable
sample receive a nearest-bone rigid fallback and are counted. These are review
signals, not automatic asset acceptance.

Thin sheets, physically touching surfaces, fused weapons and incorrectly placed
bones still need author review. A successful or converged solve alone does not
establish animation readiness. Review idle/walk/attack/death in the headed editor
on hardware GPU, with identical clips and cameras for comparisons. Preserve
manual joint placement and perform headed visual review before publishing final rigs.

Run focused tests with:

```powershell
pnpm exec vitest run apps/editor/test/volumetric-skin.test.ts apps/editor/test/binding-session.test.ts apps/editor/test/binding.test.ts apps/editor/test/binding-persistence.test.ts
pnpm run mcp-binding:check
pnpm run typecheck
pnpm run editor:build
```
