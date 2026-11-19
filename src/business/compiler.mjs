// A projection contains output from the original native template modules.
// The browser reconnects serializable output to the existing portal API.
const escapeText = value => String(value ?? '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
export function hydrateProjection(projection, { includeNotes = false, viewId = projection.id, assetUrl } = {}) {
  if (!projection || !Array.isArray(projection.slideDefinitions) || projection.manifest?.schema !== 'lattice.deck.v2') throw new TypeError('A native Lattice projection is required.');
  const slides = projection.slideDefinitions.map(slide => ({
    ...slide,
    html: assetUrl ? slide.html.replace(/lattice-asset:([a-z0-9][a-z0-9-]*)/g, (match, id) => {
      const url = assetUrl(id);
      if (typeof url !== 'string' || !/^(?:\/(?!\/)|data:image\/(?:png|jpeg|webp);base64,)/.test(url)) throw new TypeError('An approved image asset URL is required.');
      return url.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }) : slide.html,
    notes: includeNotes ? slide.notes ?? '' : '',
  }));
  return { id: viewId, title: escapeText(projection.title), description: escapeText(projection.description), owner: escapeText(projection.owner), presenter: escapeText(projection.presenter), canvas: projection.canvas,
    manifest: projection.manifest, theme: 'simple-light', paletteId: projection.paletteId,
    slideDefinitions: slides, buildSlides: () => slides.map(slide => slide.html),
    templateIdentity: projection.templateIdentity };
}

export function installProjectionStyles(projection, root = document) {
  root.getElementById('lattice-native-template-styles')?.remove();
  if (!projection.styles) return;
  const style = root.createElement('style');
  style.id = 'lattice-native-template-styles';
  style.textContent = projection.styles;
  root.head.append(style);
}

export function presentationWarnings(document, format) {
  if (format !== 'pptx') return [];
  const warnings = [];
  const visit = (value, slideId) => {
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'image') warnings.push({ code: 'IMAGE_CONTENT', slideId, message: 'The image remains image content in PPTX; it is not an editable vector shape.' });
    if (value.kind === 'chart' && value.chartType === 'pie') warnings.push({code:'VECTOR_IMAGE_FALLBACK',slideId,message:'Pie chart arcs remain vector image content in PPTX; they are not native editable shapes.'});
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(item => visit(item, slideId)); else if (child && typeof child === 'object') visit(child, slideId);
  };
  for (const slide of document.content.slides) visit(slide, slide.id);
  return warnings;
}
