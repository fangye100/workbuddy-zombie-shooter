const instance = { type: 'string', description: 'Exact instanceId from editor_instances. Never select an arbitrary tab.' };
const revision = { type: 'string', description: 'Current scene revision from scene_get; stale writes are rejected.' };
const object = { type: 'object' };
const tool = (name, description, properties = {}, required = []) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const scoped = (name, description, properties = {}, required = []) => tool(name, description,
  { instanceId: instance, ...properties }, ['instanceId', ...required]);
const edit = (name, description, properties = {}, required = []) => scoped(name, description,
  { expectedRevision: revision, ...properties }, ['expectedRevision', ...required]);

export const EDITOR_TOOLS = [
  tool('editor_workflow', 'Read the development workflow, source contracts, author/save/verify sequence, failure recovery and capability limits. No live instance required.'),
  tool('editor_instances', 'List connected Game Editor instances and their scene/ready/dirty/play state. Explicitly target one instance in subsequent calls.'),
  scoped('scene_list', 'List registered project scenes. Uses the project scenes manifest.'),
  scoped('scene_get', 'Read the current author scene, stable NodeIds, environment and revision. Runtime state never overwrites this document.'),
  edit('scene_open', 'Open a registered scene in this editor instance without page navigation. Reject unsaved changes unless discardUnsaved=true.',
    { path: {type:'string'}, discardUnsaved:{type:'boolean'} }, ['path']),
  edit('scene_create', 'Create and register a new scene through the existing transactional project service. Does not switch the current scene.',
    {path:{type:'string'},name:{type:'string'},copyCurrent:{type:'boolean'}}, ['path','name']),
  edit('scene_edit_nodes', 'Apply an atomic batch by stable NodeId through the editor command/history layer. add/replace take a complete SceneNode; remove optionally includes descendants. Component validation and reference/capacity rules apply.',
    { label:{type:'string'}, operations:{type:'array',minItems:1,maxItems:128,items:{type:'object',properties:{op:{enum:['add','replace','remove']},nodeId:{type:'string'},node:object,cascade:{type:'boolean'}},required:['op','nodeId'],additionalProperties:false}} }, ['operations']),
  edit('scene_set_environment', 'Replace the complete environment through the same validated undoable command as the UI. Read scene_get first to preserve fields.', {environment:object}, ['environment']),
  scoped('scene_validate', 'Return scene schema, reference and capacity diagnostics without changing the scene.'),
  edit('scene_history', 'Undo or redo the shared editor history and update the viewport.', {action:{enum:['undo','redo']}}, ['action']),
  edit('scene_save', 'Persist the author scene with the existing disk-conflict checks. Never bypass UI drafts, Play locks or author field authority.'),
  edit('editor_play', 'Start paused, resume, pause, single-step or stop using PlayController. stop restores the author scene and releases Play resources.',
    {action:{enum:['start','resume','pause','step','stop']},steps:{type:'integer',minimum:1,maximum:600}}, ['action']),
  scoped('editor_runtime', 'Inspect actual runtime tick, player, NPC count, Play resource ledger, weapon/audio diagnostics, and copied navigation flow-budget/avoidance/contact/stuck facts. Read-only; does not advance simulation.'),
  scoped('editor_capture', 'Capture the next actual GPU viewport frame as PNG. This is the 3D canvas, not the DOM HUD. Requires a live rendered editor; timeout is explicit.'),
];
