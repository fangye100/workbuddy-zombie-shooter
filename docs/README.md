# Project knowledge for every Agent

This is the repository-owned entrypoint for Codex, WorkBuddy and other development
Agents. Reading it needs no WorkBuddy memory service or browser. Start with
[`AGENTS.md`](../AGENTS.md), then select the relevant sources below.

## Authority and citation

1. Current user instructions and project `AGENTS.md` govern work.
2. Live source contracts, project/scene data and tests define actual behavior.
3. Current guides route work to those contracts; design documents describe intent.
4. Acceptance reports and daily logs are evidence at their recorded revision,
   not current execution rules or proof that a design was implemented.

Use [the machine-readable catalog](knowledge/catalog.json) to find documents by
stable ID, role, topic and status. IDs are independent of numbering: two `39-*`
and two `40-*` documents exist. Cite the full repository path plus heading (and
commit when a historical result matters). Never cite only “document 39” or an
unavailable conversation. Relative links make references portable to any checkout.
Untracked deliveries and draft briefs are not published knowledge.

## Task routes

| Task | Read first | Live source / owner |
|---|---|---|
| Ownership, dependency analysis, refactoring | [Layer contract](architecture/layers.md), [CodeGraph MCP](knowledge/codegraph.md) | `tools/architecture/layers.json`; current checkout source |
| Current implementation versus original architecture | [Current structure map](44-CodeGraph代码结构图谱.md#current-source-review-2026-10-09) | Source-qualified owners, direct GPU path and explicit dormant/design features; earlier numerical audit remains historical |
| Scene authoring and persistence | [Development workflow](43-GameplayDevelopmentWorkflow.md), [scene design](14-Scene系统与场景数据持久化架构设计.md) | `packages/scene/src/document.ts`, `project.ts`, `asset-meta.ts`; `@aether/runtime` author stores |
| Gameplay, NPCs, rewards and audio events | [Gameplay design](13-玩法与关卡设计GDD.md), [workflow](43-GameplayDevelopmentWorkflow.md) | `packages/zombie-game/src`; `assets/scenes`; `packages/content` data |
| Generic weapons, ray collision and timing | [Weapons report](39-Unified-weapons-and-animation-hooks.md), [layer contract](architecture/layers.md) | `packages/runtime/src/weapon-system.ts`, `weapon-combat.ts`, `solid-ray.ts` |
| HUD, language, touch/mouse and game audio | [Input report](37-CombatInputAndPopulationQuality.md), [audio guide](42-GameplayAudioIntegration.md) | `packages/zombie-game/src/presentation`; host supplies viewport/input/Play ports |
| Rigging, retarget and IK | [Rigging workflow](rigging/character-rigging-workflow.md), [body IK](animation/body-ik-blending.md), [transitions](animation/pose-transitions.md) | `packages/render`, `packages/scene` contracts; editor binding adapters |
| Scene art, materials, architectural LOD | [Visual quality playbook](art/visual-quality-playbook.md), [street report](36-StreetQualityAndArchitecturalLOD.md) | Scene/asset files; generic renderer; art validation tools |
| Browser or GPU acceptance | [Browser entry](browser-verification.md), project browser/GPU rules | Headed target checkout; runtime evidence, not a build alone |
| Agent authoring via MCP | [Editor MCP](../tools/mcp-editor/README.md) | `editor_workflow` → explicit instance selection → live schema/revision |
| Earlier choices and incident evidence | Catalog entries with `historical` status | `docs/review`, `docs/evidence`, `.workbuddy/memory`; verify against source |

## Find and maintain knowledge

```powershell
pnpm run knowledge:find -- --topic animation
pnpm run knowledge:find -- --role framework --status current
pnpm run knowledge:check
pnpm run architecture:check
```

The finder returns stable IDs, full paths, sections to consult, and authority.
The check validates IDs, tracked coverage, paths, status/role vocabulary and SOT
references. It does not declare old content current. Add/update a catalog entry
when publishing a guide or durable design decision; export important session
conclusions into a focused `docs/` guide with owner, contracts, failure behavior,
verification and remaining work. Daily logs remain immutable historical context.
Do not bulk promote their obsolete commands or temporary parameters into rules.

The [2026-10-09 documentation audit](review/documentation-audit-2026-10-09.md)
records corrected routes and verification scope. Current guides must be repaired
internally after source moves; an added routing banner alone is insufficient.
Historical reports keep their original paths/counts, with a notice directing new
work to the current contract. Architecture designs are intent, not blanket proof
that their FrameGraph, export, subsystem or MCP roadmap has shipped.

The CodeGraph cache is derived and checkout-local. It supplements source reads
and this catalog; neither graph centrality nor document age determines truth.
