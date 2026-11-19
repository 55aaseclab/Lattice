import { z } from 'zod';

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const revisionSchema = z.string().regex(/^[1-9][0-9]{0,14}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/).refine(value => !['__proto__','prototype','constructor'].includes(value), 'Unsafe field');
const text = z.string().max(20000), title = z.string().trim().min(1).max(200);
const nativeData = z.lazy(() => z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null(), z.array(nativeData).max(200), z.record(field, nativeData).refine(value => Object.keys(value).length <= 100, 'Too many fields')]));
export const nativeValueSchema = nativeData;
const page = { cursor: z.string().regex(/^\d{1,9}$/).optional(), limit: z.number().int().min(1).max(100).optional() };
const ids = z.array(slug).max(100);
const path = z.array(z.union([field, z.number().int().min(0).max(199)])).min(1).max(10);
export const templateVarsSchema = z.object({ owner: z.string().max(200).optional(), presenter: z.string().max(200).optional(), description: z.string().max(2000).optional(), stages: z.number().int().min(1).max(8).optional() }).strict();
export const nativeSlideSchema = z.object({ id: slug, layout: slug, title: text.optional() }).catchall(nativeData);
const metadata = z.object({ title: title.optional(), description: z.string().max(2000).optional(), owner: z.string().max(200).optional(), presenter: z.string().max(200).optional(), language: z.enum(['zh-CN','en']).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Patch must not be empty');
export const editOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reset_template'), templateId: slug, templateVars: templateVarsSchema.default({}), reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('set_metadata'), patch: metadata }).strict(),
  z.object({ kind: z.literal('set_content_field'), slideId: slug, fieldPath: path, value: nativeData }).strict(),
  z.object({ kind: z.literal('add_slide'), slide: nativeSlideSchema, afterSlideId: slug.nullable().optional() }).strict(),
  z.object({ kind: z.literal('remove_slide'), slideId: slug }).strict(),
  z.object({ kind: z.literal('reorder_slides'), slideIds: ids }).strict(),
  z.object({ kind: z.literal('set_notes'), slideId: slug, notes: text }).strict(),
  z.object({ kind: z.literal('set_timeline'), timeline: z.record(field, nativeData) }).strict(),
  z.object({ kind: z.literal('set_palette'), paletteId: slug }).strict(),
  z.object({ kind: z.literal('attach_asset'), stagedAssetId: idSchema }).strict(),
  z.object({ kind: z.literal('attach_audio_artifact'), jobId: idSchema }).strict(),
  z.object({ kind: z.literal('set_review_session'), jobId: idSchema }).strict(),
]);
export const inputs = Object.freeze({
  get_capabilities: z.object({}).strict(),
  get_media_catalog: z.object({}).strict(),
  get_template: z.object({ templateId: slug }).strict(),
  get_slot_guidance: z.object({ slideId: slug.optional() }).strict(),
  list_decks: z.object(page).strict(),
  read_deck: z.object({ revision: revisionSchema.optional(), slideIds: z.array(slug).max(100).optional(), includeNotes: z.boolean().default(false) }).strict(),
  create_deck: z.object({ title, templateId: slug, templateVars: templateVarsSchema.default({}), language: z.enum(['zh-CN','en']).default('zh-CN') }).strict(),
  apply_edits: z.object({ operations: z.array(editOperationSchema).min(1).max(50).refine(operations => !operations.some(edit => edit.kind === 'reset_template') || operations.length === 1, 'Template reset must be the only edit') }).strict(),
  list_assets: z.object(page).strict(),
  create_upload: z.object({ mimeType: z.enum(['image/png','image/jpeg','image/webp','audio/wav','audio/mpeg','audio/ogg','audio/mp4']), byteLength: z.number().int().min(1).max(128 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), rights: z.string().max(1000).default('unknown'), sourceLabel: z.string().max(1000).default('') }).strict(),
  write_upload_chunk: z.object({ uploadId: idSchema, offset: z.number().int().nonnegative(), data: z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  finish_upload: z.object({ uploadId: idSchema }).strict(),
  import_asset: z.object({ source: z.object({ kind: z.literal('inline'), mimeType: z.enum(['image/png','image/jpeg','image/webp','audio/wav','audio/mpeg','audio/ogg','audio/mp4']), data: z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(), rights: z.string().max(1000).default('unknown'), sourceLabel: z.string().max(1000).default('') }).strict(),
  remove_asset: z.object({ assetId: idSchema }).strict(),
  preview: z.object({ slideIds: ids.optional(), stopId: slug.optional(), width: z.enum(['1280','960']).default('1280') }).strict(),
  check: z.object({ slideIds: ids.optional(), rendered: z.boolean().default(true) }).strict(),
  validate: z.object({}).strict(),
  lint: z.object({}).strict(),
  budget: z.object({ unit: z.enum(['zh','en']).default('zh') }).strict(),
  export: z.object({ format: z.enum(['png','html','pdf','pptx']), slideIds: ids.optional(), includeNotes: z.boolean().default(false), requireEditable: z.boolean().default(false) }).strict(),
  prepare_audio: z.object({ kind: z.enum(['narration','bgm']), engine: z.enum(['kokoro','piper']).optional(), voice: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/).optional(), speed: z.number().min(0.5).max(2).optional(), style: slug.optional(), seed: z.number().int().nonnegative().max(2147483647).optional(), volume: z.number().min(0).max(1).optional(), sourceAssetId: idSchema.optional() }).strict(),
  render_video: z.object({ operation: z.enum(['plan','doctor','still','render','subtitles','chapters']).default('render'), backend: z.enum(['remotion','hyperframes']).default('remotion'), route: slug.optional(), frame: z.number().int().nonnegative().max(10000000).optional(), frames: z.array(z.number().int().nonnegative().max(10000000)).max(100).optional() }).strict(),
  review: z.object({ operation: z.enum(['pack','review','verify','personas','session_init','session_append','session_check']).default('pack'), personas: z.array(slug).min(1).max(2).optional(), round: z.number().int().min(1).max(100).optional(), stills: z.enum(['none','full']).default('none'), review: nativeData.optional(), reviews: z.array(nativeData).max(6).optional(), sessionJobId: idSchema.optional(), packJobId: idSchema.optional(), reviewJobIds: z.array(idSchema).max(6).optional(), improvements: nativeData.optional(), conclusion: nativeData.optional(), packHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  get_job: z.object({ jobId: idSchema }).strict(),
  cancel_job: z.object({ jobId: idSchema }).strict(),
  retry_job: z.object({ jobId: idSchema }).strict(),
  get_artifact: z.object({ artifactId: idSchema.optional(), assetId: idSchema.optional(), mode: z.enum(['metadata','inline','chunk']).default('metadata'), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(1).max(1048576).optional() }).strict(),
  list_revisions: z.object(page).strict(),
  restore_revision: z.object({ revision: revisionSchema }).strict(),
  set_content_lock: z.object({ mode: z.enum(['freeze','unlock']), reason: z.string().trim().min(1).max(1000) }).strict(),
  archive_deck: z.object({ archived: z.boolean() }).strict(),
  get_links: z.object({ revision: revisionSchema.optional(), view: z.enum(['view','present','presenter']).default('view') }).strict(),
  events: z.object({ after: z.number().int().nonnegative().default(0) }).strict(),
});
export const OPERATIONS = Object.freeze({ get_capabilities:'read',get_media_catalog:'read',get_template:'read',get_slot_guidance:'read',list_decks:'read',read_deck:'read',create_deck:'create',apply_edits:'update',list_assets:'read',create_upload:'update',write_upload_chunk:'update',finish_upload:'update',import_asset:'update',remove_asset:'update',preview:'render',check:'read',validate:'read',lint:'read',budget:'read',export:'export',prepare_audio:'render',render_video:'render',review:'render',get_job:'read',cancel_job:'read',retry_job:'read',get_artifact:'read',list_revisions:'read',restore_revision:'update',set_content_lock:'manage_lock',archive_deck:'delete',get_links:'read',events:'read' });
export const NO_RESOURCE = new Set(['get_capabilities','get_media_catalog','get_template','list_decks','events']);
export const DOCUMENT_WRITES = new Set(['create_deck','apply_edits','remove_asset','restore_revision','set_content_lock','archive_deck']);
export const SNAPSHOT_OPERATIONS = new Set(['create_upload','import_asset','preview','check','validate','lint','budget','export','prepare_audio','render_video','review']);
export const KEYED_OPERATIONS = new Set([...DOCUMENT_WRITES,...SNAPSHOT_OPERATIONS,'cancel_job','retry_job','write_upload_chunk','finish_upload']);
export const TOOL_DESCRIPTIONS = Object.freeze({
  get_capabilities:'Discover the actual native Lattice template, layout, component, palette, animation, audio, video and audience catalogs. Templates, themes and skills are immutable; capabilities are adapted from Lattice instead of a separate slide model.',
  get_template:'Read a native template and its slot guidance, variables, layouts and depth budgets. Use the returned field guidance before authoring; no template code can be changed.',
  get_slot_guidance:'Read the current native document slot guidance and bounded editable field paths. Fields stay in the native template content structure; do not invent a new element or layout schema.',
  create_deck:'Scaffold one authorized native Lattice document from an existing immutable template. The trusted native scaffold supplies its actual content, notes, manifest and template identity.',
  apply_edits:'Apply a bounded atomic batch of native content-slot, structure, notes, timeline or palette edits. Nested field paths must stay within an actual native content slot. Never supply HTML, code, CSS, file paths, template source or a whole-document replacement. Requires current revision and stable idempotency key. An explicit reset_template must be the only edit, requires read/update/notes, scaffolds a new native version and preserves previous history and artifacts.',
  validate:'Start native structural validation for an immutable document revision.',
  budget:'Run the native template depth-budget checks for an immutable document revision.',
  prepare_audio:'Run the existing native narration or background-music workflow in an isolated materialized snapshot. Choose actual catalog voices/presets; no arbitrary command, provider, model or filesystem path is accepted.',
  render_video:'Run native video planning, diagnostics, still/render, subtitles or chapter delivery for a fixed snapshot using an installed backend. Output paths are server-owned.',
  review:'Run the existing native audience pack, review or session checks for a fixed snapshot. Missing configured providers fail explicitly; no invented review result or internal improvement agent.',
});
