# Retargeting core: independent review and refinement

Review baseline: `749dd66` (2026-09-15); refinement completed 2026-09-16. Runtime algorithm revision: `mr-foot-2`.

This is an implementation review of the currently delivered foot-retargeting core. It supplements [the development contract](./16-MotionMatch动画匹配设计.md) and [the research archive](./16A-Retargeting运动空间补偿算法研究.md). It does not certify the pending editor/session integration, real mocap playback, hand support, body contact, or rolling stages.

## Ownership and review queue

| Owner | Production responsibility | Independent acceptance |
|---|---|---|
| Source sampling | `source-motion.ts`: units, axes, trajectory semantics and source identity | Source sampling tests |
| Business flow | `contracts.ts`, `contact-segments.ts`, `pipeline.ts`: admissible inputs, executable annotations, capability-aware outcomes | Contracts/contact/pipeline tests; mathematical reviewer cross-check |
| Mathematics | `two-bone-solver.ts`, `pose-solver.ts`, existing rig/space owners: reference frames, fixed bone lengths, shared pelvis | Analytic and pose tests; independent delivery reviewer |
| Temporal and quality | `temporal-solve.ts`, `quality-report.ts`: final correction signal and independent constraint measurements | Temporal/quality tests; business reviewer cross-check |
| Delivery | `bake-adapter.ts`: actual-parent local tracks, rigid expressibility and finite output | Adapter tests and `bake-acceptance.test.ts`, with independent matrix playback |

Three subagents independently reviewed and refined business flow, mathematics, and delivery. The primary agent integrated the changes and owned source/temporal/quality corrections. Each new scenario belongs to its existing test owner; historical `review-regression.test.ts` receives only input corrections needed to exercise its original scenarios under explicit current semantics.

## Executable data flow

1. Sample source motion into meters and normalized world coordinates. Root-motion semantics are an input, not a conclusion that every stationary character is an in-place walk. `buildSourceMotion` accepts `rootMotion: 'world-trajectory'` for a declared stationary/vertical world trajectory, or `'in-place-with-trajectory'` to override incidental horizontal drift. Default `'auto'` retains conservative inference. Declared trajectories require position channels. The resulting semantic mode participates in source identity. The pending importer/session must retain and reapply that declaration; this core review does not claim a completed importer UI or persistence round trip.
2. Validate the sampled tracks, target graph, source calibration and environment together. A sampled centimeter source cannot simultaneously claim a meter-to-meter source calibration. The current space mapper supports normalized horizontal planes; mismatched or unsupported support planes must be rejected instead of having anchors and quality use different ground surfaces.
3. Detect contact only from explicitly calibrated source markers. Match heel and ball identities independently. A detected phase is not permission to create a world anchor: world support additionally requires a trustworthy source world trajectory.
4. Check requested annotation intervals against actual samples. A request wholly outside a clip or containing no sample is unfulfilled. The current strict interval policy rejects intervals crossing the clip boundary rather than silently clipping their meaning. Unsupported slide/roll requests yield usable free motion with partial status.
5. Construct all world support anchors with the shared space mapping. Retain the mapped reference/animation orientation when converting marker anchors to ankle targets.
6. Solve a shared pelvis translation and the active two-bone chains, preserving fixed segment lengths. Reconstruct rotations consistently with positions and preserve source baseline axial twist and downstream local animation.
7. Smooth only added root corrections over a window measured in seconds; re-solve the constraints. Quality measures the final correction relative to the original mapped root candidate, not the smoother's intermediate output. High remaining correction speed is reported, not silently called temporally solved.
8. Independently measure all active support anchors from final poses. Missing or skipped residual entries cannot hide a violated constraint. Inner/outer reach violations and nonconvergence prevent complete status.
9. Bake to the actual target parent graph. Reject invalid graphs, nonpositive/nonfinite or overflowing scale, inconsistent sample arrays, and nonrepresentable rigid poses before publishing local tracks. Verify the tracks through independent matrix FK and skin-reference invariants.

## Mathematical corrections

The previous fully extended standing failure came from two incompatible numerical shortcuts: the analytic solver shortened maximum reach by one nanometer, creating a roughly 20.844-micrometer lateral knee bend; a near-parallel quaternion shortcut then discarded that bend. The bake validator correctly rejected the inconsistent pose. The refined solver uses the closed reach interval `abs(l1-l2) <= d <= l1+l2`, handles its endpoints explicitly, and uses a precise direction swing. Bake tolerance is not relaxed to conceal the discrepancy.

Shared-root reach solving now includes both the inner and outer reach surfaces. For a leg with segment lengths 0.8 and 0.2 meters, a target 0.2 meters from the hip cannot be solved by bending alone; the shared root must move away until the 0.6-meter inner bound is met, or report an unresolved constraint.

IK applies the directional correction to the already mapped animated world frame. Reconstructing from target rest alone would erase the source's axial twist. Missing target animation channels retain reference local transforms; reattaching toe descendants retains supplied baseline local rotations rather than resetting them to rest. The final hierarchy refresh also updates noncontrolled thigh/calf side branches, such as twist bones, while preserving solved knee/ankle positions. Refreshing only descendants of the ankle leaves side branches attached to stale parent transforms and can make an otherwise valid pose impossible to bake.

Temporal smoothing integrates a piecewise-linear correction signal over a seconds window. This avoids weighting densely sampled regions more heavily merely because they contain more frames. Final correction speed remains a maximum adjacent-sample added velocity, in meters per second; it is not a physical acceleration or a claim of globally optimized motion dynamics.

## Failure matrix

| Trigger | Outcome and owner |
|---|---|
| No reliable source foot markers | Free preview, partial capability; pipeline |
| Phase-only or unknown trajectory, or an explicitly zero-confidence source plane | No world support anchors, partial capability; pipeline |
| Missing requested marker, out-of-clip or unsampled interval | Unfulfilled annotation and partial status; contact/pipeline |
| Requested slide/roll outside foot-support MVP | Explicit unsupported-mode partial result; pipeline |
| Inconsistent source units/axes/baseline or incompatible support plane | Failed input with field-level diagnosis; contracts/pipeline |
| Nonpositive two-bone segment length | Failed rig admission; contracts; analytic API also rejects invalid lengths |
| Inner/outer reach conflict, unfulfilled concurrent anchor or nonconvergence | Final-pose residuals and partial status; pose/quality |
| Remaining added correction speed or penetration exceeds tolerance | Partial quality result; quality |
| Bad actual-parent graph, invalid scale, missing sample or impossible local pose | No local tracks and explicit bake diagnostics; adapter |
| Algorithm revision changes | Old results invalidate using the actual executing revision, including when a loaded recipe still records the old revision |

## Validation boundary

`bake-acceptance.test.ts` uniquely owns the calibrated source-to-local-delivery acceptance contract. It uses independently implemented 4x4 matrix operations rather than production quaternion/FK/readback helpers. Inputs include roughly 2-meter and 0.5-meter targets, nonproportional legs, standing, alternating walk-like motion, turns, jumps, reference-frame changes, and nonjoint parent transformations. These are synthetic numerical/business scenarios, not a substitute for visually checking real mocap on real skinned assets.

The old R01-R14 and N/T/F counterexamples are retained as historical evidence. Passing their exact constants is necessary but insufficient: the final acceptance also checks reference-frame invariance, fixed-length pose reconstruction, executable contact semantics, finite local output and actual-parent playback.

MR-06 editor/session work and real 2 m / 0.5 m walk/turn/jump validation remain pending; MR-07/08 are not declared complete.

One downstream integration check is explicit: `packages/render/src/skin.ts` currently evaluates parent matrices in node-array order. Before MR-06 admits arbitrary glTF node ordering, its runtime owner must verify or correct that traversal. The independent matrix oracle validates the local-track contract, not the unintegrated renderer or GPU path. No renderer change is included in this core refinement.

## Independent review decisions

| Independent reviewer | Reviewed work beyond their own implementation | Decision |
|---|---|---|
| Mathematics queue | Business capability gates, annotation intervals, units, planes and invalid bone admission | PASS within the accepted requested-marker semantics |
| Business queue | Primary agent's final-pose quality checks, seconds-based temporal integration and explicit source trajectory semantics | PASS |
| Delivery queue | Mathematical pose changes and final quality composition; side-branch failure reproduced before repair and independently retested afterwards | PASS for the current foot core |

An additional 10,000-case CPU probe varied segment lengths, target directions and positions within the reachable annulus. Maximum segment-length error was approximately `3.324e-15 m`; maximum direction error was `1.334e-15`. This probe supplements the committed tests and is not a real mocap or physical-balance validation.

The existing frozen `main.ts`, `binding-math.ts`, `binding-export.ts` and legacy `retarget.ts` files did not grow. No broad repository tests, dependency installation, asset regeneration, service restart or GPU session were used to substitute for the affected-owner analysis.

## Final integration gate

**PASS for the currently implemented foot core and local-track delivery contract.** This is not MR-06/07/08 product acceptance.

```powershell
pnpm exec vitest run apps/editor/test/motion-retarget packages/scene/test/retarget-meta.test.ts packages/scene/test/asset-meta.test.ts
pnpm run typecheck
git diff --check
```

Results: **15 files, 251 tests passed** (200 motion-retarget tests and 51 relevant scene metadata tests); project typecheck passed; diff whitespace checks passed. The final side-branch fixture's read-only TypeScript construction was corrected before commit, then its 15-test pose owner and project typecheck were rerun successfully. No production change followed the 251-test run.

The only validation expansion beyond module tests was the existing project-wide typecheck, needed to verify the changed sampling/solver interfaces and shared scene algorithm revision. No full repository test suite or full application build was run. Algorithm revision changes are recorded by `RETARGET_ALGORITHM_VERSION`, and the execution dependency fingerprint uses that runtime revision rather than trusting an old recipe's version string.
