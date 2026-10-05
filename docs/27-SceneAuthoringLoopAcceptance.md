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

## Integration with the environment asset delivery

Integrated main `6206c4a` (PR #23). Asset insertion remains an `AssetNodeEdit` in `SpawnEditStore`; general node edits and asset commands now share the same validated save-authority snapshot. `AuthorAssetController` continues to own the derived asset view and temporary CPU texture history. Its undo/redo failures retain the document/history rollback behavior. External uncommanded mutations cannot acquire authority by importing another asset.

The headed acceptance used the actual branch worktree (verified through `/__fs/info`) and NVIDIA Lovelace. A new disposable floor-1 copy was created and registered through File > Save as. This time P-01 LOD2 was added by a real asset-library double click, rather than a debug invocation. The imported asset retained GUID `as_cax4jr7q`, a stable node ID, metre scale and 15,000 triangles.

The visible route exercised material color `#ff4400`, naming, deletion, menu undo, transform input, saving and reopening. The reopened document and renderer retained the material override and position X=4.001. A stale untouched form after material edits was reproduced and repaired; uncommitted user drafts still keep their conflict guard. RunRules magazine 23 and heal cost 27 survived disk reload; Play displayed 23/120 ammunition. This was a parameter-propagation check, not a gameplay balance run (the idle player died). Stop restored the 63 authored objects and a clean author document; no browser errors were recorded.

Evidence: `.workbuddy/tmp/author-loop-merged-acceptance.png`, `author-loop-merged-play.png` and `author-loop-merged-accepted.scene.json`. The disposable scene and its project entry were removed after validation. Production floor layouts and character production assets were not edited.

Final integration gates: 266 related tests in 18 suites, typecheck and editor production build passed. `scene:check` verified 145 synchronized asset sidecars, nine v7 scenes, 12 scene-file tests and the 38-asset LOD audit. Existing Vite CJS and chunk-size warnings remain.
