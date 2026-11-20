import { createBusinessHooks } from './praxis/business-hooks.mjs';
import { createWebIntegration } from './praxis/web.mjs';
import { createStorageIntegration } from './praxis/storage.mjs';
import { createDeploymentIntegration } from './praxis/deployment.mjs';
import { createBusinessSchema } from './src/business/schema-definition.mjs';

export function createIntegration({ z }) {
const businessError=(status,code)=>Object.assign(new Error(code),{status,code});
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const common = { spaceId: id }, mutation = { ...common, idempotencyKey: id };
function planningInput(schema, args) {
  const { spaceId: ignoredSpace, resourceId: ignoredResource, expectedRevision: ignoredRevision, idempotencyKey: ignoredKey, ...input } = args;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw businessError(400, 'INVALID_INPUT');
  return parsed.data;
}
const native = createBusinessSchema(z);
const SLIDES_OPERATIONS=native.OPERATIONS, slidesInputs=native.inputs, SLIDES_NO_RESOURCE=native.NO_RESOURCE, SLIDES_DOCUMENT_WRITES=native.DOCUMENT_WRITES, SLIDES_KEYED_OPERATIONS=native.KEYED_OPERATIONS, SLIDES_SNAPSHOT_OPERATIONS=native.SNAPSHOT_OPERATIONS, slidesIdSchema=native.idSchema, slidesRevisionSchema=native.revisionSchema;
const SLIDES_ACTIONS=['read','create','update','render','export','delete','notes','manage_lock'];
const errorSegment = z.union([z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/).refine(value => !['__proto__','prototype','constructor'].includes(value)), z.number().int().min(0).max(1000000)]);
const fieldError = z.object({ path: z.array(errorSegment).min(1).max(24), code: z.enum(Object.values(z.ZodIssueCode)) }).strict();

function slidesErrorDetails(status, code, value) {
  if (status === 409 && code === 'REVISION_CONFLICT' && /^[1-9][0-9]{0,14}$/.test(value?.currentRevision || '') && typeof value.currentRevision === 'string') return { currentRevision: value.currentRevision };
  if (status !== 400 || code !== 'INVALID_INPUT' || !Array.isArray(value?.fieldErrors)) return {};
  const fieldErrors = value.fieldErrors.slice(0,20).flatMap(item => {
    const result = fieldError.safeParse({ path: item?.path, code: item?.code });
    return result.success ? [result.data] : [];
  });
  return fieldErrors.length ? { fieldErrors } : {};
}

function slidesRequiredActions(operation, input = {}) {
  const actions = new Set();
  if (!['create_deck', 'get_capabilities', 'get_media_catalog', 'get_template'].includes(operation)) actions.add('read');
  if (['preview', 'lint', 'prepare_audio', 'render_video', 'review'].includes(operation) || operation === 'check' && input.rendered !== false) actions.add('render');
  if (['export', 'render_video'].includes(operation)) actions.add('export');
  if (['review', 'budget'].includes(operation) || operation === 'prepare_audio' && input.kind === 'narration' || operation === 'render_video' && input.operation === 'subtitles') actions.add('notes');
  if (input.includeNotes === true || operation === 'get_links' && input.view === 'presenter') actions.add('notes');
  if (operation === 'apply_edits' && input.operations?.some(edit => edit.kind === 'reset_template' || edit.kind === 'set_notes' || edit.kind === 'add_slide' && edit.slide?.notes)) actions.add('notes');
  return [...actions];
}

const slidesDescriptions = {
  get_capabilities: 'Read the native Lattice library contract: immutable templates, semantic layouts and slots, primitives, technical blocks, palettes, animation parameters, native media and audience catalogs, export formats, prerequisites and limits. Read this before authoring; do not invent a parallel layout or visual vocabulary.',
  get_media_catalog: 'Query the actual native audio voices, music styles and installed media engines through the typed native catalog selector. Reports provider and engine prerequisites from the native query; never substitutes a hardcoded unavailable result or accepts a command, executable or host path.',
  get_template: 'Inspect one immutable native Lattice template by its catalog ID, including variables, slot fields, guidance, depth budgets and version identity. This exposes metadata, not executable template source or host paths.',
  get_slot_guidance: 'Read the exact native template slots and field guidance for this authorized document before editing. Fill the native fields and reuse its layout and stable library components; do not substitute generic positioned text boxes.',
  list_decks: 'List only the authorized document summaries in one space. Returns stable resource IDs and revisions, not source files or speaker notes.',
  read_deck: 'Read one authorized document revision or selected slides. includeNotes defaults to false; speaker notes require the separate notes permission. Read the current revision before editing.',
  create_deck: 'Scaffold one document at its explicitly authorized resource ID using an immutable native Lattice templateId and validated templateVars. Read the library catalog and template first. Reuses native content, layouts, notes and rendering; never creates an independent renderer or modifies the template library. Use one stable idempotency key.',
  apply_edits: 'Atomically apply bounded native content-slot, slide-structure, notes, palette and timeline edits at the current revision. Read native template slot guidance first. Reuse its native layouts, primitives and technical blocks. To explicitly remake an earlier document, use reset_template as the only operation with a catalog templateId, validated templateVars and reason; requires read, update and notes, current revision and a stable idempotency key. The same resource gains a native scaffold revision while all previous revisions and artifacts remain preserved; then fill its native slots in subsequent edits. Locked documents reject the reset. Completed native audio and audience jobs may be attached through their typed operations; their original permissions are rechecked. No raw HTML, JS, CSS, arbitrary file paths or whole-document replacement. Native validation, provenance and content locks apply; notes changes require notes permission.',
  list_assets: 'List only assets attached to this authorized document. Asset IDs do not grant access to other documents or host paths.',
  create_upload: 'Reserve a temporary image or audio upload for one authorized document with exact MIME type, byte length and SHA-256. Maximum size is 128 MiB. Send ordered base64 chunks of at most 1 MiB through write_upload_chunk, then finish_upload to verify and stage it. No document content changes before a separate attach_asset edit; no host paths or arbitrary upload URL.',
  write_upload_chunk: 'Write the next ordered base64 chunk of at most 1 MiB to your document-bound temporary upload. Supply its exact current byte offset and a stable idempotency key for retries. Owner, client, resource, expiry, total size and order are checked; the chunk cannot target a file path.',
  finish_upload: 'Finish your fully uploaded image or audio file by verifying byte count, SHA-256 and allowed MIME signature. Returns a staged asset ID; attach it explicitly through apply_edits at the current revision. A completed upload does not change slide content or grant access to another document.',
  import_asset: 'Stage and validate one bounded image or audio file from an allowed typed inline source as a persistent job. This does not modify document content. Read the resulting staged asset ID, then attach_asset through apply_edits at the current revision. Unknown rights remain unknown.',
  remove_asset: 'Remove one unreferenced asset from the document using its current revision and stable idempotency key. Referenced assets and host files cannot be deleted.',
  preview: 'Start an actual image preview of a fixed document revision, selected slides and optional reveal stop. Requires read and render. Read the completed image artifact to inspect the real canvas; do not claim a preview exists before the job succeeds.',
  check: 'Run native Lattice lint and rendered inspection for a fixed document revision. rendered:true requires render permission; rendered:false performs native structural checks without a browser. Findings retain native slide, area and element locations. Use a stable idempotency key.',
  validate: 'Run native Lattice document validation, preserving native manifest, bindings, layout, assets and runtime checks. A clean structural report does not replace visual inspection or template depth budgets.',
  lint: 'Run the existing native Lattice rendered lint rules for one fixed document revision. Requires read and render permission. Findings retain the native rule identity and slide locations; this complements structural validation, rendered inspection and template budget checks without changing the template.',
  budget: 'Run the native template depth-budget referee for this document, including visible content, narration and stop alignment. Uses the selected template machine-readable budget; requires notes permission because native checks inspect narration. No invented minimums or substitutes.',
  prepare_audio: 'Run the native narration or background-audio workflow as a fixed-revision job. Narration additionally requires notes permission; background music does not read notes. Select only native catalog voices and typed options; preserves native timing, duration gates, timeline declaration, provenance and content locks. Missing native engine or provisioned voice is a reported prerequisite, not a fabricated result.',
  render_video: 'Run native video planning, backend diagnostics, still/video rendering, subtitles or chapters through the typed operation selector and immutable source snapshot. Reuses native backends and integer-frame timeline. Requires read, render and export, and any source-note permission required by the selected operation. Never accepts a command, executable or output path.',
  review: 'Run the native audience pack, review, verification and session workflow through its typed selector. Reuses the native persona catalog, evidence pack, schemas and convergence rules; requires notes permission for narration evidence. Provider prerequisites must be reported honestly, and no arbitrary model command or host path is accepted.',
  export: 'Export a fixed document revision as a supported PNG, HTML, PDF or editable PPTX artifact. Requires read and export; notes require an explicit separate permission. requireEditable:true must fail rather than silently rasterize unsupported PPTX content. This does not publicly publish a document.',
  get_job: 'Read one document-bound persistent job, its actual status, immutable source revision, findings and artifact IDs. Original job permissions are rechecked. queued or running is not completed.',
  cancel_job: 'Request cancellation of a job you initiated or own. Use a stable idempotency key. Cancellation is complete only after cancelled is reported; this never exposes process control.',
  retry_job: 'Retry a failed or interrupted document-bound job as a new attempt with a new idempotency key. The original immutable snapshot and required permissions are retained.',
  get_artifact: 'Read metadata, bounded inline content or an explicitly bounded byte chunk for one authorized document artifact. Images are actual MCP image content. Prefer the protected download URL for large files; do not load an entire video into the model context. Every read rechecks original permissions; IDs and URLs are not authorization.',
  list_revisions: 'List immutable document versions and authorized difference summaries. Historical versions and speaker notes retain their current resource permissions.',
  restore_revision: 'Restore a historical document as a new version using the current revision and stable idempotency key. Does not rewrite history or bypass a content lock. Restoring changed notes requires notes permission.',
  set_content_lock: 'Explicitly freeze or unlock a document for an authorized owner with manage_lock. Requires the current revision and a reason; the server computes fingerprints and no client-supplied lock value is accepted.',
  archive_deck: 'Archive or restore one document using its current revision and stable idempotency key. This is reversible business-data archiving, not physical file deletion.',
  get_links: 'Get an authenticated viewing or presentation link for one authorized document revision. presenter requires notes permission. This does not create public access or return bearer tokens in a URL.',
};
const slidesTools = Object.entries(SLIDES_OPERATIONS).filter(([operation]) => operation !== 'events').map(([operation, action]) => ({
  name: `slides_${operation}`, appId: 'slides', operation, action,
  description: slidesDescriptions[operation],
  requiredActions: ['preview', 'lint', 'export', 'prepare_audio', 'render_video', 'review', 'budget'].includes(operation) ? ['read', ...(['review', 'budget'].includes(operation) ? ['notes'] : []), ...(['render_video', 'lint'].includes(operation) ? ['render'] : []), ...(operation === 'render_video' ? ['export'] : [])] : [],
  readOnly: !SLIDES_KEYED_OPERATIONS.has(operation),
  schema: z.object({
    ...common,
    ...(SLIDES_NO_RESOURCE.has(operation) ? {} : { resourceId: slidesIdSchema }),
    ...(SLIDES_KEYED_OPERATIONS.has(operation) ? { idempotencyKey: id } : {}),
    ...(operation !== 'create_deck' && (SLIDES_DOCUMENT_WRITES.has(operation) || SLIDES_SNAPSHOT_OPERATIONS.has(operation)) ? { expectedRevision: slidesRevisionSchema } : {}),
    ...slidesInputs[operation].shape,
  }).strict(),
  input: args => planningInput(slidesInputs[operation], args),
}));
const operationActions={"get_capabilities":"read","get_media_catalog":"read","get_template":"read","get_slot_guidance":"read","list_decks":"read","read_deck":"read","create_deck":"create","apply_edits":"update","list_assets":"read","create_upload":"update","write_upload_chunk":"update","finish_upload":"update","import_asset":"update","remove_asset":"update","preview":"render","check":"read","validate":"read","lint":"read","budget":"read","export":"export","prepare_audio":"render","render_video":"render","review":"render","get_job":"read","cancel_job":"read","retry_job":"read","get_artifact":"read","list_revisions":"read","restore_revision":"update","set_content_lock":"manage_lock","archive_deck":"delete","get_links":"read","events":"read"};
const operations=Object.fromEntries(Object.entries(operationActions).map(([name,action])=>[name,{action,mutation:SLIDES_KEYED_OPERATIONS.has(name)}]));
const observedCapabilities={"get_capabilities":"read","get_media_catalog":"read","get_template":"read","get_slot_guidance":"read","list_decks":"read","read_deck":"read","create_deck":"create","apply_edits":"update","list_assets":"read","create_upload":"create","write_upload_chunk":"update","finish_upload":"update","import_asset":"create","remove_asset":"delete","preview":"read","check":"read","validate":"read","lint":"read","budget":"read","export":"read","prepare_audio":"create","render_video":"create","review":"create","get_job":"read","cancel_job":"update","retry_job":"create","get_artifact":"read","list_revisions":"read","restore_revision":"update","set_content_lock":"update","archive_deck":"delete","get_links":"read","events":"read"};
for(const [name,definition]of Object.entries(operations))definition.capability=observedCapabilities[name];
function validateInvocation(request) {
const {appId,operation,spaceId,resourceId}=request;const action=operationActions[operation];
if(request.sourceResourceId!==undefined)throw businessError(400,'INVALID_REQUEST');
if (appId === 'slides') {
    if (SLIDES_NO_RESOURCE.has(operation) ? resourceId !== undefined : !slidesIdSchema.safeParse(resourceId).success) throw businessError(400, 'RESOURCE_REQUIRED');
    const revisionRequired = operation !== 'create_deck' && (SLIDES_DOCUMENT_WRITES.has(operation) || SLIDES_SNAPSHOT_OPERATIONS.has(operation));
    if (revisionRequired ? !slidesRevisionSchema.safeParse(request.expectedRevision).success : request.expectedRevision !== undefined) throw businessError(400, 'INVALID_REVISION');
    if (SLIDES_KEYED_OPERATIONS.has(operation) ? !identifier(request.idempotencyKey) : request.idempotencyKey !== undefined) throw businessError(400, 'INVALID_REQUEST');
    if (!slidesInputs[operation].safeParse(request.input || {}).success) throw businessError(400, 'INVALID_INPUT');
    if (operation === 'get_artifact') {
      const input = request.input || {};
      if (Number(Boolean(input.artifactId)) + Number(Boolean(input.assetId)) !== 1 || input.mode !== 'chunk' && (input.offset !== undefined || input.length !== undefined)) throw businessError(400, 'INVALID_INPUT');
    }
  }
}
return {schemaVersion:1,appId:"lattice-slides",web:createWebIntegration(),storage:createStorageIntegration(),deployment:createDeploymentIntegration(),business:{adapterId:"slides",actions:["read","create","update","render","export","manage_lock","delete","notes"],scopes:{"slides:read":["read"],"slides:write":["create","update"],"slides:render":["render"],"slides:export":["export"],"slides:notes":["notes"],"slides:delete":["delete"],"slides:lock":["manage_lock"]},targetedCreate:true,operations,tools:slidesTools,skill:{name:"mcp-slides",path:"skills/mcp-slides/SKILL.md"},instructions:["Lattice document content and native template slots are editable business data through typed Slides tools. Read slides_get_capabilities and the available native template and slot guidance before authoring. Scaffold an immutable native template, edit its content and native component parameters, inspect actual previews, run native validation and budgets, then export a verified revision. Do not replace native templates, typography or components with a parallel renderer or generic positioned boxes. Software source, template and theme implementation, raw HTML/JS/CSS and host paths remain unavailable. Job creation is not completed rendering or delivery."],validateInvocation,...createBusinessHooks({slidesRequiredActions,slidesErrorDetails}),schemas:{slidesAvailable:true,SLIDES_OPERATIONS,slidesInputs,SLIDES_NO_RESOURCE,SLIDES_DOCUMENT_WRITES,SLIDES_KEYED_OPERATIONS,SLIDES_SNAPSHOT_OPERATIONS,slidesIdSchema,slidesRevisionSchema,SLIDES_ACTIONS,slidesErrorDetails,slidesRequiredActions},events:{operation:'events'}}};
}
