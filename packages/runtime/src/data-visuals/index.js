import { scaleBand, scaleLinear } from 'd3-scale';
import { line, pie, arc } from 'd3-shape';
import { defineGrid, gridPlacementRect, gridAreaRect, gridSpacingTokens } from '../grid/index.js';
import { layoutGrids } from '../layout/index.js';
import { createPrimitives } from '../primitives/index.js';

export const DATA_VISUALS_VERSION = 1;
const blocks = createPrimitives({ textboxClass: 'slide-textbox', groupClass: 'slide-group' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const textbox = (value, inheritColor = false) => blocks.textbox({ body: `<p${inheritColor ? ' style="color:inherit"' : ''}>${escape(value)}</p>` });
const slug = /^[a-z0-9][a-z0-9-]{0,99}$/;
const colors = ['var(--sl-theme-roadmap)', 'var(--sl-theme-accent)', 'var(--sl-theme-accent-alt)', 'var(--sl-theme-timeline-base)', 'var(--sl-theme-ink)', 'var(--sl-theme-muted)'];
const box = gridAreaRect(layoutGrids.titleBody, 'body');
const width = box.width, height = box.height;
const fail = message => { throw new TypeError(`[lattice-data-visuals] ${message}`); };
const plain = (value, max = 160) => typeof value === 'string' && value.length <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown or invalid data-visual parameters.'); }
function optionalCaption(value) { if (value.caption !== undefined && !plain(value.caption, 1000)) fail('Caption must be bounded plain text.'); }

export const DATA_VISUAL_CATALOG = Object.freeze({
  schema: 'lattice.data-visuals.v1', version: DATA_VISUALS_VERSION,
  chart: { chartTypes: ['bar', 'line', 'pie'], fields: ['chartType', 'categories', 'series', 'caption'], editablePptx: { bar: true, line: true, pie: false } },
  diagram: { directions: ['LR', 'TB'], fields: ['direction', 'nodes', 'edges', 'caption'], editablePptx: true, placement: 'Deterministic native grid in node order.' },
  shape: { shapes: ['rect', 'rectangle', 'rounded-rectangle', 'ellipse', 'line', 'arrow'], fields: ['shape', 'fill', 'border'], editablePptx: true },
});

export function validateDataChart(value) {
  fields(value, ['chartType', 'categories', 'series', 'caption']); optionalCaption(value);
  if (!['bar', 'line', 'pie'].includes(value.chartType)) fail('Unknown chart type.');
  if (!Array.isArray(value.categories) || !value.categories.length || value.categories.length > 24 || value.categories.some(category => !plain(category))) fail('Charts require one to twenty-four bounded category labels.');
  if (!Array.isArray(value.series) || !value.series.length || value.series.length > 6) fail('Charts require one to six series.');
  for (const series of value.series) {
    fields(series, ['name', 'values']);
    if (!plain(series.name) || !Array.isArray(series.values) || series.values.length !== value.categories.length || series.values.some(number => !Number.isFinite(number) || Math.abs(number) > 1e12)) fail('Chart values must be finite and match the category count.');
  }
  if (value.chartType === 'pie' && (value.series.length !== 1 || value.series[0].values.some(number => number < 0) || !value.series[0].values.some(number => number > 0))) fail('A pie chart requires one nonnegative series with a positive total.');
  return { ok: true };
}

export function validateDataDiagram(value) {
  fields(value, ['direction', 'nodes', 'edges', 'caption']); optionalCaption(value);
  if (value.direction !== undefined && !['LR', 'TB'].includes(value.direction)) fail('Unknown diagram direction.');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 20) fail('Diagrams require one to twenty nodes.');
  const ids = new Set();
  for (const node of value.nodes) {
    fields(node, ['id', 'label']);
    if (!slug.test(node.id) || ids.has(node.id) || !plain(node.label)) fail('Diagram nodes require unique stable IDs and bounded labels.');
    ids.add(node.id);
  }
  if (!Array.isArray(value.edges) || value.edges.length > 80) fail('Diagram edges must be bounded.');
  for (const edge of value.edges) {
    fields(edge, ['from', 'to', 'label']);
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || edge.label !== undefined && !plain(edge.label)) fail('Diagram edges must reference distinct existing nodes.');
  }
  return { ok: true };
}

const tokenColors = { none: 'none', text: 'var(--sl-theme-ink)', muted: 'var(--sl-theme-muted)', accent: 'var(--sl-theme-roadmap)', accentAlt: 'var(--sl-theme-accent)', surface: 'var(--sl-theme-label-surface)', line: 'var(--sl-theme-line)', danger: 'var(--sl-theme-accent)' };
export function validateDataShape(value) {
  fields(value, ['shape', 'fill', 'border']);
  if (!DATA_VISUAL_CATALOG.shape.shapes.includes(value.shape) || value.fill !== undefined && !Object.hasOwn(tokenColors, value.fill) || value.border !== undefined && !Object.hasOwn(tokenColors, value.border)) fail('Shapes require native semantic tokens.');
  return { ok: true };
}

function svg(paths, label, preserve = false) { return paths ? `<svg data-lattice-data-visual="true" preserveAspectRatio="${preserve ? 'xMidYMid meet' : 'none'}" role="img" aria-label="${escape(label)}" viewBox="0 0 ${width} ${height}" style="position:absolute;inset:0;width:100%;height:100%">${paths}</svg>` : ''; }
function frame(body, caption, kind) { return `<div data-lattice-data-visual="${kind}" style="position:relative;box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--sl-theme-body)"><div style="position:relative;min-height:0;flex:1">${body}</div>${caption ? textbox(caption) : ''}</div>`; }
function legend(series) { return `<div style="display:flex;gap:${gridSpacingTokens.gap}px;flex-wrap:wrap">${series.map((entry, index) => `<div style="color:${colors[index % colors.length]}">${textbox(entry.name, true)}</div>`).join('')}</div>`; }

export function renderDataChart(value) {
  validateDataChart(value);
  const { chartType, categories, series, caption = '' } = value;
  if (chartType === 'bar') {
    const values = series.flatMap(entry => entry.values), min = Math.min(0, ...values), max = Math.max(1, ...values);
    const x = scaleLinear().domain([min, max]).range([0, 82]), baseline = x(0);
    const body = `<div style="display:flex;flex-direction:column;height:100%;min-height:0;gap:${gridSpacingTokens.scale.sm}px">${legend(series)}${categories.map((category, index) => `<div style="display:flex;gap:${gridSpacingTokens.scale.sm}px;flex:1;min-height:0"><div style="width:22%;display:flex;align-items:center">${textbox(category)}</div><div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:${gridSpacingTokens.scale.xs}px">${series.map((entry, seriesIndex) => `<div style="position:relative;height:100%;min-height:0"><div style="position:absolute;top:15%;height:70%;left:${Math.min(baseline, x(entry.values[index]))}%;width:${Math.abs(x(entry.values[index]) - baseline)}%;background:${colors[seriesIndex % colors.length]}"></div><div style="position:relative;display:block;text-align:right">${textbox(entry.values[index])}</div></div>`).join('')}</div></div>`).join('')}</div>`;
    return frame(body, caption, 'bar');
  }
  if (chartType === 'line') {
    const values = series.flatMap(entry => entry.values), minimum = Math.min(0, ...values), maximum = Math.max(1, ...values);
    const x = scaleBand().domain(categories.map((_, index) => String(index))).range([gridSpacingTokens.edge, width - gridSpacingTokens.edge]);
    const y = scaleLinear().domain([minimum, maximum]).range([height - gridSpacingTokens.edge, gridSpacingTokens.edge]);
    const draw = line().x((_, index) => x(String(index)) + x.bandwidth() / 2).y(number => y(number));
    const ticks=y.ticks(4);
    const gridLines=ticks.map(tick=>`<path d="M ${gridSpacingTokens.edge} ${y(tick)} L ${width-gridSpacingTokens.edge} ${y(tick)}" fill="none" stroke="var(--sl-theme-line)" stroke-width="1"/>`).join('');
    const paths = series.map((entry, index) => `<path d="${draw(entry.values)}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="2"/>${entry.values.map((number,point)=>{const px=x(String(point))+x.bandwidth()/2,py=y(number);return `<path d="M ${px-3} ${py} L ${px} ${py-3} L ${px+3} ${py} L ${px} ${py+3} Z" fill="${colors[index%colors.length]}" stroke="none"/>`;}).join('')}`).join('');
    const labels = categories.map((category,index) => `<div style="position:absolute;bottom:0;left:${(x(String(index))+x.bandwidth()/2)/width*100}%;transform:translateX(-50%)">${textbox(category)}</div>`).join('');
    const tickLabels=ticks.map(tick=>`<div style="position:absolute;left:0;top:${y(tick)/height*100}%;transform:translateY(-50%)">${textbox(tick)}</div>`).join('');
    return frame(`${svg(gridLines+paths, series.map(entry => entry.name).join(', '))}${legend(series)}${labels}${tickLabels}`, caption, 'line');
  }
  const radius = Math.min(width, height) / 2 - gridSpacingTokens.gap - gridSpacingTokens.padding;
  const wedges = pie().sort(null)(series[0].values), draw = arc().innerRadius(0).outerRadius(radius);
  const paths = wedges.map((wedge, index) => `<path d="${draw(wedge)}" transform="translate(${width / 2},${height / 2})" fill="${colors[index % colors.length]}"/>`).join('');
  const labels = categories.map((category, index) => ({ name: `${category}: ${series[0].values[index]}` }));
  return frame(`${svg(paths, categories.join(', '),true)}${legend(labels)}`, caption, 'pie');
}

export function renderDataDiagram(value) {
  validateDataDiagram(value);
  const horizontal = value.direction !== 'TB';
  const grid = defineGrid({ name: 'data-diagram', canvas: { width, height }, columns: horizontal ? value.nodes.length : 1, rows: horizontal ? 1 : value.nodes.length, gap: 'lg', margin: 'md' });
  const rectangles = new Map(value.nodes.map((node, index) => [node.id, gridPlacementRect(grid, { col: horizontal ? index + 1 : 1, row: horizontal ? 1 : index + 1 })]));
  const paths = value.edges.map(edge => {
    const from = rectangles.get(edge.from), to = rectangles.get(edge.to);
    const forward = horizontal ? to.left > from.left : to.top > from.top;
    const x1 = horizontal ? from.left + (forward ? from.width : 0) : from.left + from.width / 2;
    const y1 = horizontal ? from.top + from.height / 2 : from.top + (forward ? from.height : 0);
    const x2 = horizontal ? to.left + (forward ? 0 : to.width) : to.left + to.width / 2;
    const y2 = horizontal ? to.top + to.height / 2 : to.top + (forward ? 0 : to.height);
    const length=Math.hypot(x2-x1,y2-y1),ux=(x2-x1)/length,uy=(y2-y1)/length,head=gridSpacingTokens.scale.sm;
    const d = `${line()([[x1, y1], [x2, y2]])} M ${x2-ux*head-uy*head/2} ${y2-uy*head+ux*head/2} L ${x2} ${y2} L ${x2-ux*head+uy*head/2} ${y2-uy*head-ux*head/2}`;
    return `<path d="${d}" stroke="var(--sl-theme-roadmap)" stroke-width="2" fill="none"/>`;
  }).join('');
  const nodes = value.nodes.map(node => {
    const rectangle = rectangles.get(node.id);
    return `<div data-diagram-node="${escape(node.id)}" style="position:absolute;box-sizing:border-box;left:${rectangle.left / width * 100}%;top:${rectangle.top / height * 100}%;width:${rectangle.width / width * 100}%;height:${rectangle.height / height * 100}%;padding:${gridSpacingTokens.padding}px;border:1px solid var(--sl-theme-line);background:var(--sl-theme-label-surface);display:flex;align-items:center;justify-content:center;overflow-wrap:anywhere;text-align:center">${textbox(node.label)}</div>`;
  }).join('');
  const labels = value.edges.filter(edge => edge.label).map(edge => {
    const from = rectangles.get(edge.from), to = rectangles.get(edge.to);
    const x = (from.left + from.width / 2 + to.left + to.width / 2) / 2, y = (from.top + from.height / 2 + to.top + to.height / 2) / 2;
    return `<div style="position:absolute;left:${x / width * 100}%;top:${y / height * 100}%;transform:translate(-50%,-50%);background:var(--sl-theme-canvas);text-align:center">${textbox(edge.label)}</div>`;
  }).join('');
  return frame(`${svg(paths, value.nodes.map(node => node.label).join(', '))}${nodes}${labels}`, value.caption, 'diagram');
}

export function renderDataShape(value) {
  validateDataShape(value);
  const fill = tokenColors[value.fill ?? 'accent'], border = tokenColors[value.border ?? 'none'];
  if (['rect', 'rectangle', 'rounded-rectangle'].includes(value.shape)) return `<div data-lattice-data-visual="shape" style="box-sizing:border-box;width:100%;height:100%;background:${fill};border:${border === 'none' ? '0' : `1px solid ${border}`};${value.shape === 'rounded-rectangle' ? `border-radius:${gridSpacingTokens.padding}px` : ''}"></div>`;
  const d = value.shape === 'ellipse'
    ? `M ${width} ${height / 2} C ${width} ${height * 0.776} ${width * 0.776} ${height} ${width / 2} ${height} C ${width * 0.224} ${height} 0 ${height * 0.776} 0 ${height / 2} C 0 ${height * 0.224} ${width * 0.224} 0 ${width / 2} 0 C ${width * 0.776} 0 ${width} ${height * 0.224} ${width} ${height / 2} Z`
    : `M 0 ${height / 2} L ${width} ${height / 2}${value.shape === 'arrow' ? ` M ${width - gridSpacingTokens.gap} ${height / 2 - gridSpacingTokens.gap} L ${width} ${height / 2} L ${width - gridSpacingTokens.gap} ${height / 2 + gridSpacingTokens.gap}` : ''}`;
  return `<div style="position:relative;width:100%;height:100%">${svg(`<path d="${d}" fill="${value.shape === 'ellipse' ? fill : 'none'}" stroke="${value.shape === 'ellipse' ? border : fill}" stroke-width="2"/>`, value.shape)}</div>`;
}
