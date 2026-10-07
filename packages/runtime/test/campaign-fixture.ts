import type { SceneDocument } from '@aether/scene';
/** Small authored scheduling fixture. Campaign population tuning has its own contract test. */
export function smallCampaignFixture(source: SceneDocument): SceneDocument {
  const doc=structuredClone(source);
  const counts:Record<string,number>={nd_f1r0_sp0:5,nd_f1r0_sp1:4,nd_f1r0_sp2:3,nd_f1r2_sp0:4,nd_f1r2_sp1:4,nd_f1r2_sp2:4};
  for(const n of doc.nodes)for(const c of n.components)if(c.kind==='SpawnPoint' && counts[n.id]!==undefined){c.count=counts[n.id]!;c.radius=1.5;}
  return doc;
}
