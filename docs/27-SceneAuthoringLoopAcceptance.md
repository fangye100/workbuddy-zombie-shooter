# Scene authoring loop acceptance

## Delivered behavior

The Scene/Lighting pane now exposes the full RunRules component (economy, ammunition, talents, unlock costs and optional Boss attack), as well as scene node naming, visibility, picking, parenting, local transforms and light parameters. Draft forms require Apply or Discard; invalid values stay in the form with a diagnostic. A stale form cannot overwrite a node changed by another editing route.

New empty nodes, boxes, asset-library placement, hierarchy visibility and deletion now change the author document. Asset placement writes a stable NodeId and the existing sidecar guid/path reference. Deletion includes descendants and rejects broken surviving references. Static object capacity is checked before mutation.

`SpawnEditStore` remains the document/history owner. Validated node transactions join the existing transform, spawn and environment undo stack. The saver accepts node changes only when they match the command-authorized snapshot. Direct mutations through the public document reference do not grant save authority. Existing compare-and-swap checks and in-flight-save behavior are retained.

Material edits become scene-local serialized overrides; the editor reapplies them after real GLB primitives are available. Light controls write the selected priority light and convert world positions/directions through its parent transform. Structural undo/redo rebuilds the GPU projection from the document. Play is blocked while projection is loading or a form is unapplied. Stop restores temporary rendering parameters as well as the existing author object snapshot.

No new scene schema or migration was introduced. Character asset production files were not changed.

## Validation on 2026-10-04

- 271 related tests across 18 suites passed, including all runtime tests, mixed author save/reopen/Play, subtree undo, capacity, invalid references, concurrent saving, material binding isolation and parented light conversion.
- Type checking and editor production build passed. Existing Vite CJS and large-chunk warnings remain.
- `scene:check`: 106 asset metadata files synchronized; all eight production scenes at v7; 12 scene-file tests passed.
- Headed Chrome using the user's existing profile; actual WebGPU adapter reported vendor `nvidia`, architecture `lovelace`.
- A copy of floor 1 was created and registered through the UI as `assets/scenes/custom/author-loop-qa.scene.json`. Production scene content was not modified.
- UI edits changed magazine size from 18 to 23 and heal cost from 18 to 27. Save and reload retained them; Play visibly displayed 23/120 ammunition. A zero magazine size was rejected without changing the working document.
- UI creation, rename and material editing produced a box with stable ID `nd_15acf720-a6c7-4236-9f30-7c2b5b97c732`, color `#ff4400`. Deleting it removed it from the document; one undo restored its ID and material. Reload restored the actual renderer material.
- Point-light intensity was edited to 3.5, saved and verified after reload in renderer parameters.
- A targeted integration probe invoked the same asset-placement command used by the asset browser with P-04. The resulting node retained `guid: as_y1xpmedt`, its source path and position, and finished GLB loading. This probe was not a mouse drag test. At 64 objects, the UI rejected a 65th box.
- A controlled external edit to the disposable scene caused an explicit disk conflict. The unsaved heal-cost value 31 remained in memory. Restoring the test baseline allowed the preserved change to save.
- A separate Play-only parameter probe set key-light intensity from 1.4 to 9; the real Stop button restored 1.4, retaining the authored point intensity 3.5. This was a deliberate debug mutation, not ordinary UI editing.
- No browser errors were reported in the final validation page. The temporary scene and its project entry were removed afterward. An initial workspace-list assertion saw nine scenes while the fixture was registered; after cleanup the original eight-scene assertion and the full related set passed.

Local evidence remains under `.workbuddy/tmp/author-loop-acceptance.png` and `.workbuddy/tmp/author-loop-accepted.scene.json` in this worktree.

## Scope boundaries

Scene-local material appearance is persisted here. Cross-scene material-library instance creation/rename/deletion is not implemented by this change; those legacy actions are hidden for scene-authored objects instead of promising persistence. Submesh eye toggles are explicitly labelled temporary preview; whole-node visibility is persisted. Script parameters and unexposed component types retain their existing read-only behavior. This task does not claim to finish the separate game-design/art-refinement work.
