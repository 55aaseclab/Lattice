import { z } from 'zod';
import { simpleLightBlocks as blocks, simpleLightTechnical as technical, simpleLightLayouts as layouts } from '@55aaseclab/lattice-runtime/themes/simple-light';
import { renderDataChart, renderDataDiagram, renderDataShape } from '@55aaseclab/lattice-runtime/data-visuals';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const escapeText = value => String(value ?? '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
const text = z.string().max(20000);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100);
const integer = z.number().int().min(1).max(32);
const scalar = z.union([text, z.number().finite(), z.boolean()]);
const head = z.array(z.union([scalar, z.object({ label: text, reveal: slug.optional() }).strict()])).max(32);
const rows = z.array(z.array(scalar).max(32)).max(100);
const optionalReveal = { reveal: slug.optional(), name: text.optional() };
const gridCell = z.object({ col: integer, row: integer, colSpan: integer.optional(), rowSpan: integer.optional(), fit: z.enum(['contain', 'cover', 'stretch']).optional(), name: text.optional(), children: z.lazy(() => nodes).optional(), text: text.optional() }).strict();
const cell = z.object({ label: text.optional(), state: z.enum(['free', 'used', 'target', 'overflow', 'header']).optional(), span: z.number().int().min(1).max(8).optional() }).strict();
const memory = { columns: integer.optional(), cells: z.array(cell).max(256), caption: text.optional(), ...optionalReveal };
const table = { head: head.optional(), rows, caption: text.optional(), compact: z.boolean().optional(), name: text.optional() };
const box = { text: text.optional(), children: z.lazy(() => nodes).optional(), name: text.optional() };
const positioned = { ...box, anchor: z.enum(['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right']).optional(), region: z.enum(['body-full', 'body-left', 'body-right']).optional() };
export const nodeSchema = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), ...box }).strict(),
  z.object({ kind: z.literal('textbox'), ...box }).strict(),
  z.object({ kind: z.literal('table'), ...table }).strict(),
  z.object({ kind: z.literal('image'), assetId: slug, alt: text.optional(), caption: text.optional(), fit: z.enum(['contain', 'cover', 'stretch']).optional() }).strict(),
  z.object({ kind: z.literal('positioned'), ...positioned }).strict(),
  z.object({ kind: z.literal('positionedTextbox'), ...positioned }).strict(),
  z.object({ kind: z.literal('positionedGroup'), ...positioned }).strict(),
  z.object({ kind: z.literal('grid'), columns: integer, rows: integer, gap: z.number().min(0).max(96).optional(), margin: z.number().min(0).max(96).optional(), cells: z.array(gridCell).max(128), name: text.optional() }).strict(),
  z.object({ kind: z.literal('gridCell'), ...gridCell.shape }).strict(),
  z.object({ kind: z.literal('codeBlock'), code: text, language: text.optional(), caption: text.optional(), ...optionalReveal }).strict(),
  z.object({ kind: z.literal('terminalBlock'), command: text.optional(), output: text.optional(), caption: text.optional(), ...optionalReveal }).strict(),
  z.object({ kind: z.literal('memoryGrid'), ...memory }).strict(),
  z.object({ kind: z.literal('arrow'), direction: z.enum(['up', 'down', 'left', 'right']).optional(), lengthPx: z.number().min(12).max(480).optional(), label: text.optional(), tone: z.enum(['ink', 'accent', 'danger']).optional(), reveal: slug.optional() }).strict(),
  z.object({ kind: z.literal('markerBadge'), number: z.number().int().min(0).max(99), tone: z.enum(['ink', 'accent', 'danger']).optional(), reveal: slug.optional() }).strict(),
  z.object({ kind: z.literal('warningCallout'), title: text.optional(), body: text, tone: z.enum(['warning', 'danger', 'info']).optional(), ...optionalReveal }).strict(),
  z.object({ kind: z.literal('compareTable'), ...table, highlightColumn: z.number().int().min(0).max(31).optional(), reveal: slug.optional() }).strict(),
  z.object({ kind: z.literal('reveal'), stop: slug, children: z.lazy(() => nodes) }).strict(),
  z.object({ kind: z.literal('chart'), chartType: z.enum(['bar','line','pie']), categories: z.array(z.string().max(160)).min(1).max(24), series: z.array(z.object({ name:z.string().max(160),values:z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(24) }).strict()).min(1).max(6),caption:z.string().max(1000).optional() }).strict(),
  z.object({ kind: z.literal('diagram'),direction:z.enum(['LR','TB']).optional(),nodes:z.array(z.object({id:slug,label:z.string().max(160)}).strict()).min(1).max(20),edges:z.array(z.object({from:slug,to:slug,label:z.string().max(160).optional()}).strict()).max(80),caption:z.string().max(1000).optional() }).strict(),
  z.object({ kind: z.literal('shape'),shape:z.enum(['rect','rectangle','rounded-rectangle','ellipse','line','arrow']),fill:z.enum(['none','text','muted','accent','accentAlt','surface','line','danger']).optional(),border:z.enum(['none','text','muted','accent','accentAlt','surface','line','danger']).optional() }).strict(),
]));
export const nodes = z.array(nodeSchema).max(128);
const shared = { id: slug, layout: slug, title: text.optional(), footnote: text.optional(), stops: z.array(slug).min(1).max(100).optional() };
const body = { body: text.optional(), bodyNodes: nodes.optional() };
const split = { left: text.optional(), right: text.optional(), leftNodes: nodes.optional(), rightNodes: nodes.optional() };
const callout = z.object({ stop: slug.optional(), title: text.optional(), body: text, tone: z.enum(['warning', 'danger', 'info']).optional() }).strict();
const note = z.object({ body: text, title: text.optional(), tone: z.enum(['warning', 'danger', 'info']).optional() }).strict();
const fieldShapes = {
  'title-slide': { subtitle: text.optional() },
  'title-body': body,
  'title-body-split': split,
  'title-body-split-one-third-two-thirds': split,
  'title-two-columns': split,
  'title-only': body,
  'one-column': body,
  'main-point': {}, 'section-header': {}, blank: {},
  'section-title-description': { subtitle: text.optional(), ...body },
  caption: body, 'big-number': body,
  'stage-table': { stages: z.array(z.object({ kicker: text, title: text, summary: text }).strict()).min(1).max(8) },
  hook: { badgeNumber: z.number().int().min(0).max(99).optional(), badgeLabel: text.optional(), badgeTone: z.enum(['ink', 'accent', 'danger']).optional(), hook: text },
  concept: { analogyStop: slug, termsStop: slug, analogy: z.array(text).max(32), terms: z.object({ head, rows, caption: text.optional() }).strict() },
  mechanism: { steps: z.array(z.object({ stop: slug, text, grid: z.object(memory).strict().optional() }).strict()).max(32) },
  evidence: { events: z.array(z.object({ stop: slug, time: text.optional(), command: text.optional(), output: text.optional(), caption: text.optional() }).strict()).max(32) },
  impact: { callout, points: z.array(z.object({ stop: slug, text }).strict()).max(32) },
  score: { tableReveal: slug.optional(), caption: text.optional(), head, rows, highlightColumn: z.number().int().min(0).max(31).optional(), note: note.optional() },
  'fix-status': { tableReveal: slug.optional(), caption: text.optional(), head, rows, highlightColumn: z.number().int().min(0).max(31).optional(), callout: callout.optional() },
  takeaways: { items: z.array(z.object({ stop: slug, text }).strict()).max(32) },
};
export const genericLayoutNames = Object.keys(fieldShapes).slice(0, 13);
export const originalLayouts = ['title-slide', 'title-body', 'title-body-split', 'title-two-columns', 'one-column', 'main-point', 'section-header', 'blank'];
export function layoutSchema(layout) { return fieldShapes[layout] && z.object({ ...shared, ...fieldShapes[layout] }).strict(); }
export function layoutFields(layout) { return Object.keys({ ...shared, ...fieldShapes[layout] }); }
export function supportedLayouts(templateId) { return [...genericLayoutNames, ...(templateId === 'stage-table' ? ['stage-table'] : templateId === 'vuln-explainer' ? ['hook', 'concept', 'mechanism', 'evidence', 'impact', 'score', 'fix-status', 'takeaways'] : [])]; }

function children(node, assetUrl) {
  if (node.children) return renderNodes(node.children, assetUrl);
  const paragraph = `<p>${escapeHtml(node.text ?? '')}</p>`;
  return ['textbox', 'positionedTextbox'].includes(node.kind) ? paragraph : blocks.textbox({ body: paragraph });
}
export function renderNodes(values, assetUrl = id => `lattice-asset:${id}`) {
  return values.map(node => {
    const { kind, children: ignored, ...parameters } = node;
    if (['group', 'textbox', 'positioned', 'positionedTextbox', 'positionedGroup'].includes(kind)) return blocks[kind]({ ...parameters, body: children(node, assetUrl) });
    if (kind === 'image') {
      const src = assetUrl(node.assetId);
      if (typeof src !== 'string' || !/^(?:data:image\/(?:png|jpeg|webp);base64,|lattice-asset:|\/(?!\/))/.test(src)) throw new Error('Asset URL is not an approved local image reference.');
      return blocks.image({ ...parameters, src: escapeHtml(src), alt: escapeHtml(node.alt ?? ''), caption: escapeHtml(node.caption ?? '') });
    }
    if (kind === 'table') return blocks.table({ ...parameters, head: (node.head ?? []).map(value => escapeHtml(typeof value === 'object' ? value.label : value)), rows: node.rows.map(row => row.map(escapeHtml)), caption: escapeHtml(node.caption ?? '') });
    if (kind === 'grid') return blocks.grid({ ...parameters, name: escapeHtml(node.name ?? ''), overlay: false, nested: true, cells: node.cells.map(cell => ({ ...cell, content: children(cell, assetUrl) })) });
    if (kind === 'gridCell') return blocks.gridCell({ ...parameters, content: children(node, assetUrl) });
    if (kind === 'reveal') return technical.reveal({ stop: node.stop, content: children(node, assetUrl) });
    if (kind === 'warningCallout') return technical.warningCallout({ ...parameters, body: node.body.includes('<') ? `<p>${escapeHtml(node.body)}</p>` : node.body });
    if (kind === 'chart') return renderDataChart(parameters);
    if (kind === 'diagram') return renderDataDiagram(parameters);
    if (kind === 'shape') return renderDataShape(parameters);
    return technical[kind](parameters);
  }).join('');
}

// Additional native layouts extend an instance's renderer table without replacing any original entry.
export const nativeLayoutRenderers = {
  'title-body-split-one-third-two-thirds': slide => layouts.titleBodySplitOneThirdTwoThirds({ ...slide, left: slide.leftHtml ?? `<p>${escapeHtml(slide.left)}</p>`, right: slide.rightHtml ?? `<p>${escapeHtml(slide.right)}</p>` }),
  'title-only': slide => layouts.titleOnly({ ...slide, body: slide.bodyHtml ?? (slide.body ? `<p>${escapeHtml(slide.body)}</p>` : '') }),
  'section-title-description': slide => layouts.sectionTitleDescription({ ...slide, body: slide.bodyHtml ?? `<p>${escapeHtml(slide.body)}</p>` }),
  caption: slide => layouts.caption({ ...slide, body: slide.bodyHtml ?? `<p>${escapeHtml(slide.body)}</p>` }),
  'big-number': slide => layouts.bigNumber({ ...slide, body: escapeHtml(slide.body ?? '') }),
};

export function safeTemplateContent(content, assetUrl) {
  return { ...content, slides: content.slides.map(original => {
    const slide = structuredClone(original);
    for (const key of ['title', 'subtitle', 'footnote']) if (slide[key] !== undefined) slide[key] = escapeText(slide[key]);
    for (const key of ['body', 'left', 'right']) if (slide[`${key}Nodes`]) slide[`${key}Html`] = renderNodes(slide[`${key}Nodes`], assetUrl);
    // These two native helpers accept trusted HTML; their public business slots remain plain text.
    for (const key of ['callout', 'note']) if (slide[key]?.body?.includes('<')) slide[key].body = `<p>${escapeHtml(slide[key].body)}</p>`;
    return slide;
  }) };
}
