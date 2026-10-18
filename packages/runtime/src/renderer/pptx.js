let PptxGenJS;

// The Lattice canvas is authored at 960 × 540. Keeping this explicit makes
// the DOM geometry below deterministic even when Reveal is currently scaled
// for a large screen or a narrow browser window.
const PPTX_WIDTH = 13.333;
const PPTX_HEIGHT = 7.5;
const PX_TO_POINT = 72 / 96;

const SVG_STYLE_PROPERTIES = [
  "color",
  "display",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "vector-effect",
  "visibility",
];

const EXCLUDED_CLASSES = [
  "slide-note-source",
  "slide-grid-overlay",
  "sl-grid-overlay",
  "sl-dimension-overlay",
];

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function cleanClassName(element) {
  return Array.from(element.classList || [])
    .filter((className) => !className.startsWith("reveal"))
    .join(" ");
}

function objectName(element, kind, index) {
  const classes = cleanClassName(element).toLowerCase();
  const role =
    (classes.includes("title") && "Title") ||
    (classes.includes("roadmap") && "Roadmap") ||
    (classes.includes("outcome") && "Outcome") ||
    (classes.includes("timeline") && "Timeline") ||
    (classes.includes("label") && "Label") ||
    (classes.includes("tool") && "Tool") ||
    (classes.includes("capability") && "Capability") ||
    (classes.includes("mechanism") && "Mechanism") ||
    (classes.includes("card") && "Card") ||
    "";
  return `${role || kind} ${index}`;
}

function number(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function colorFromCss(value) {
  if (!value || value === "transparent" || value === "none") return null;
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const source = hex[1];
    const expanded = source.length === 3 || source.length === 4
      ? source.split("").map((part) => `${part}${part}`).join("")
      : source;
    const rgb = expanded.slice(0, 6).toUpperCase();
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) / 255 : 1;
    return { color: rgb, transparency: Math.round((1 - alpha) * 100) };
  }
  const channels = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
  const srgb = value.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i);
  const channelValues = channels
    ? [channels[1], channels[2], channels[3]].map(Number)
    : srgb
      ? [srgb[1], srgb[2], srgb[3]].map((channel) => Number(channel) * 255)
      : null;
  if (!channelValues) return null;
  const rgb = channelValues
    .map((channel) => Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const alphaValue = channels ? channels[4] : srgb?.[4];
  const alpha = alphaValue === undefined ? 1 : Math.max(0, Math.min(1, Number(alphaValue)));
  return { color: rgb, transparency: Math.round((1 - alpha) * 100) };
}

function lineFromCss(style, side) {
  const width = number(style.getPropertyValue(`border-${side}-width`));
  const type = style.getPropertyValue(`border-${side}-style`);
  const color = colorFromCss(style.getPropertyValue(`border-${side}-color`));
  if (!width || type === "none" || !color || color.transparency >= 100) return null;
  return {
    color: color.color,
    transparency: color.transparency,
    width: Math.max(0.3, width * PX_TO_POINT),
    dashType: type === "dashed" ? "dash" : type === "dotted" ? "sysDot" : "solid",
  };
}

function toSlideBounds(rect, canvasRect) {
  const scaleX = PPTX_WIDTH / canvasRect.width;
  const scaleY = PPTX_HEIGHT / canvasRect.height;
  return {
    x: (rect.left - canvasRect.left) * scaleX,
    y: (rect.top - canvasRect.top) * scaleY,
    w: rect.width * scaleX,
    h: rect.height * scaleY,
  };
}

function ownText(element) {
  let text = "";
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent || "";
    } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "BR") {
      text += "\n";
    }
  }
  return text
    .replace(/[\t ]*\n[\t ]*/g, "\n")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}

function isExcluded(element) {
  if (EXCLUDED_CLASSES.some((className) => element.classList?.contains(className))) return true;
  return ["SCRIPT", "STYLE", "ASIDE", "DEFS", "MARKER"].includes(element.tagName);
}

function isVisibleBox(element, style) {
  // A hidden Reveal slide is made transparent while exporting, which is an
  // inherited opacity. Its descendants are still fully laid out and need to
  // become editable PPTX objects, so do not use opacity as a visibility test.
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0.2 && rect.height > 0.2;
}

function isScreenReaderOnlyBox(element, style) {
  // This is the conventional visually-hidden accessibility pattern: an
  // out-of-flow one-pixel box that is clipped out of the visual canvas. A
  // PPTX has no equivalent semantic-only box, and emitting it as text can
  // make it visible in importers. Detect the visual geometry and CSS only;
  // no deck, class, or content knowledge belongs in the exporter.
  const rect = element.getBoundingClientRect();
  const hasClip = style.clip && style.clip !== "auto" && style.clip !== "rect(auto, auto, auto, auto)";
  const hasClipPath = style.clipPath && style.clipPath !== "none";
  const isOutOfFlow = style.position === "absolute" || style.position === "fixed";
  const clipsOverflow = style.overflow === "hidden" || style.overflow === "clip";
  return (
    isOutOfFlow &&
    rect.width <= 1.1 &&
    rect.height <= 1.1 &&
    clipsOverflow &&
    (hasClip || hasClipPath)
  );
}

function isChevron(style) {
  return style.clipPath && style.clipPath !== "none" && style.clipPath.includes("polygon");
}

function verticalAlignment(style) {
  if (["center", "normal"].includes(style.alignItems) && ["grid", "inline-grid", "flex", "inline-flex"].includes(style.display)) {
    return "mid";
  }
  if (style.alignItems === "end" || style.alignItems === "flex-end") return "bottom";
  return "top";
}

function horizontalAlignment(style) {
  if (style.textAlign === "center") return "center";
  if (style.textAlign === "right" || style.textAlign === "end") return "right";
  return "left";
}

function cssFontFace(value) {
  return (value || "Arial")
    .split(",")[0]
    .trim()
    .replace(/^['"]|['"]$/g, "") || "Arial";
}

function addLine(slide, shapeType, x1, y1, x2, y2, line, name) {
  slide.addShape(shapeType.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line,
    objectName: name,
  });
}

function addBorders(slide, shapeType, element, style, bounds, objectIndex) {
  const borders = {
    top: lineFromCss(style, "top"),
    right: lineFromCss(style, "right"),
    bottom: lineFromCss(style, "bottom"),
    left: lineFromCss(style, "left"),
  };
  if (borders.top) addLine(slide, shapeType, bounds.x, bounds.y, bounds.x + bounds.w, bounds.y, borders.top, objectName(element, "Border", objectIndex));
  if (borders.right) addLine(slide, shapeType, bounds.x + bounds.w, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h, borders.right, objectName(element, "Border", objectIndex));
  if (borders.bottom) addLine(slide, shapeType, bounds.x, bounds.y + bounds.h, bounds.x + bounds.w, bounds.y + bounds.h, borders.bottom, objectName(element, "Border", objectIndex));
  if (borders.left) addLine(slide, shapeType, bounds.x, bounds.y, bounds.x, bounds.y + bounds.h, borders.left, objectName(element, "Border", objectIndex));
}

function addEditableBox(slide, shapeType, element, style, bounds, objectIndex) {
  const fill = colorFromCss(style.backgroundColor);
  const radius = Math.max(
    number(style.borderTopLeftRadius),
    number(style.borderTopRightRadius),
    number(style.borderBottomLeftRadius),
    number(style.borderBottomRightRadius),
  );
  const hasFill = fill && fill.transparency < 100;
  if (hasFill) {
    slide.addShape(
      isChevron(style) ? shapeType.chevron : radius > 0 ? shapeType.roundRect : shapeType.rect,
      {
        ...bounds,
        fill,
        line: { color: fill.color, transparency: 100 },
        objectName: objectName(element, isChevron(style) ? "Roadmap step" : "Shape", objectIndex),
      },
    );
  }
  addBorders(slide, shapeType, element, style, bounds, objectIndex);
}

function addEditableText(slide, element, style, bounds, text, objectIndex) {
  const color = colorFromCss(style.color) || { color: "111111", transparency: 0 };
  const padding = [
    number(style.paddingTop) * PX_TO_POINT,
    number(style.paddingRight) * PX_TO_POINT,
    number(style.paddingBottom) * PX_TO_POINT,
    number(style.paddingLeft) * PX_TO_POINT,
  ];
  slide.addText(text, {
    ...bounds,
    margin: padding,
    breakLine: false,
    fontFace: cssFontFace(style.fontFamily),
    fontSize: Math.max(1, number(style.fontSize, 16) * PX_TO_POINT),
    color: color.color,
    transparency: color.transparency,
    bold: Number(style.fontWeight) >= 600 || style.fontWeight === "bold",
    italic: style.fontStyle === "italic",
    align: horizontalAlignment(style),
    valign: verticalAlignment(style),
    fit: "shrink",
    breakLine: false,
    paraSpaceAfterPt: 0,
    paraSpaceBeforePt: 0,
    lineSpacingMultiple: 1,
    objectName: objectName(element, "Text", objectIndex),
  });
}

const splitCssColor = (value) => {
  const color = colorFromCss(value);
  if (!color) return null;
  return {
    color: `rgb(${Number.parseInt(color.color.slice(0, 2), 16)}, ${Number.parseInt(color.color.slice(2, 4), 16)}, ${Number.parseInt(color.color.slice(4, 6), 16)})`,
    opacity: String((100 - color.transparency) / 100),
  };
};

export function normalizeSvgPaint(svg) {
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const property of ["fill", "stroke"]) {
      const styled = element.style?.getPropertyValue?.(property);
      const raw = styled || element.getAttribute(property);
      if (!raw || (!raw.startsWith("rgb(") && !raw.startsWith("rgba(") && !raw.startsWith("color("))) continue;
      const paint = splitCssColor(raw);
      if (!paint) continue;
      if (styled) element.style.setProperty(property, paint.color);
      else element.setAttribute(property, paint.color);
      if (paint.opacity !== "1") {
        const opacityProperty = `${property}-opacity`;
        const styledOpacity = element.style?.getPropertyValue?.(opacityProperty);
        const existing = number(styledOpacity || element.getAttribute(opacityProperty), 1);
        const normalizedOpacity = String(existing * Number(paint.opacity));
        if (styledOpacity) element.style.setProperty(opacityProperty, normalizedOpacity);
        else element.setAttribute(opacityProperty, normalizedOpacity);
      }
    }
  }
  return svg;
}

const encodeSvgDataUri = (source) =>
  `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`;

const normalizeSvgSource = (source) => {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement?.tagName.toLowerCase() !== "svg") return null;
  normalizeSvgPaint(parsed.documentElement);
  return new XMLSerializer().serializeToString(parsed.documentElement);
};

function svgDataUri(svg) {
  const clone = svg.cloneNode(true);
  const originalNodes = [svg, ...svg.querySelectorAll("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];
  originalNodes.forEach((source, index) => {
    const target = cloneNodes[index];
    if (!target) return;
    const style = window.getComputedStyle(source);
    const serialized = SVG_STYLE_PROPERTIES
      .map((property) => `${property}:${style.getPropertyValue(property)}`)
      .join(";");
    target.setAttribute("style", serialized);
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  normalizeSvgPaint(clone);
  const source = new XMLSerializer().serializeToString(clone);
  return encodeSvgDataUri(source);
}

async function imageDataUri(image) {
  const source = image.currentSrc || image.src;
  if (!source) return null;
  if (source.startsWith("data:")) return source;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Unable to embed image: ${source}`);
  const blob = await response.blob();
  if (blob.type === "image/svg+xml" || new URL(source, window.location.href).pathname.endsWith(".svg")) {
    const normalized = normalizeSvgSource(await blob.text());
    if (normalized) return encodeSvgDataUri(normalized);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(blob);
  });
}

async function addVectorImage(slide, element, canvasRect, objectIndex) {
  const rect = element.getBoundingClientRect();
  const bounds = toSlideBounds(rect, canvasRect);
  if (element.tagName === "svg") {
    slide.addImage({
      data: svgDataUri(element),
      ...bounds,
      objectName: objectName(element, "Vector SVG", objectIndex),
      altText: element.getAttribute("aria-label") || "Vector diagram",
    });
    return;
  }
  const data = await imageDataUri(element);
  if (!data) return;
  slide.addImage({
    data,
    ...bounds,
    objectName: objectName(element, "Image", objectIndex),
    altText: element.alt || "Image",
  });
}

const SVG_PATH_TOKEN = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:(?:\d*\.\d+)|(?:\d+\.?))(?:[eE][-+]?\d+)?/g;
const SVG_PATH_COMMAND = /^[AaCcHhLlMmQqSsTtVvZz]$/;

export function parseViewBox(svg) {
  const values = (svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = values;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function parseSvgPathData(data) {
  if (!data || data.replace(SVG_PATH_TOKEN, "").replace(/[\s,]/g, "")) return null;
  const tokens = data.match(SVG_PATH_TOKEN) || [];
  const pointCount = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
  };
  const points = [];
  let index = 0;
  let command = null;
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let previousCubic = null;
  let previousQuadratic = null;
  let previousCommand = null;

  const nextNumber = () => {
    const value = Number(tokens[index]);
    if (!Number.isFinite(value)) throw new Error("Invalid SVG path number");
    index += 1;
    return value;
  };
  const read = (count) => Array.from({ length: count }, nextNumber);
  const isRelative = () => command === command.toLowerCase();
  const endpoint = (x, y) => ({
    x: isRelative() ? current.x + x : x,
    y: isRelative() ? current.y + y : y,
  });
  const reflect = (control) => ({
    x: 2 * current.x - control.x,
    y: 2 * current.y - control.y,
  });

  try {
    while (index < tokens.length) {
      if (SVG_PATH_COMMAND.test(tokens[index])) command = tokens[index++];
      if (!command) return null;
      const upper = command.toUpperCase();
      if (upper === "A") return null;
      if (upper === "Z") {
        points.push({ close: true });
        current = { ...subpathStart };
        previousCubic = null;
        previousQuadratic = null;
        previousCommand = "Z";
        command = null;
        continue;
      }
      const count = pointCount[upper];
      if (!count || index + count > tokens.length || SVG_PATH_COMMAND.test(tokens[index])) return null;
      const values = read(count);

      if (upper === "M") {
        const target = endpoint(values[0], values[1]);
        points.push({ ...target, moveTo: true });
        current = target;
        subpathStart = { ...target };
        command = command === "m" ? "l" : "L";
      } else if (upper === "L") {
        const target = endpoint(values[0], values[1]);
        points.push(target);
        current = target;
      } else if (upper === "H") {
        const target = { x: isRelative() ? current.x + values[0] : values[0], y: current.y };
        points.push(target);
        current = target;
      } else if (upper === "V") {
        const target = { x: current.x, y: isRelative() ? current.y + values[0] : values[0] };
        points.push(target);
        current = target;
      } else if (upper === "C") {
        const control1 = endpoint(values[0], values[1]);
        const control2 = endpoint(values[2], values[3]);
        const target = endpoint(values[4], values[5]);
        points.push({ ...target, curve: { type: "cubic", x1: control1.x, y1: control1.y, x2: control2.x, y2: control2.y } });
        current = target;
        previousCubic = control2;
      } else if (upper === "S") {
        const control1 = ["C", "S"].includes(previousCommand) && previousCubic ? reflect(previousCubic) : { ...current };
        const control2 = endpoint(values[0], values[1]);
        const target = endpoint(values[2], values[3]);
        points.push({ ...target, curve: { type: "cubic", x1: control1.x, y1: control1.y, x2: control2.x, y2: control2.y } });
        current = target;
        previousCubic = control2;
      } else if (upper === "Q") {
        const control = endpoint(values[0], values[1]);
        const target = endpoint(values[2], values[3]);
        points.push({ ...target, curve: { type: "quadratic", x1: control.x, y1: control.y } });
        current = target;
        previousQuadratic = control;
      } else if (upper === "T") {
        const control = ["Q", "T"].includes(previousCommand) && previousQuadratic ? reflect(previousQuadratic) : { ...current };
        const target = endpoint(values[0], values[1]);
        points.push({ ...target, curve: { type: "quadratic", x1: control.x, y1: control.y } });
        current = target;
        previousQuadratic = control;
      }

      if (!["C", "S"].includes(upper)) previousCubic = null;
      if (!["Q", "T"].includes(upper)) previousQuadratic = null;
      previousCommand = upper;
    }
  } catch {
    return null;
  }
  return points.some((point) => point.moveTo) ? points : null;
}

export function isSimpleSvgPathSet(svg) {
  const viewBox = parseViewBox(svg);
  const paths = Array.from(svg.children);
  if (!viewBox || !paths.length || paths.some((path) => path.tagName.toLowerCase() !== "path")) return null;
  if (svg.getAttribute("transform") || svg.querySelector("[transform], use, text, image, filter, mask, clipPath, marker, linearGradient, radialGradient, pattern")) return null;
  if ((svg.getAttribute("preserveAspectRatio") || "").trim() !== "none") return null;

  const parsedPaths = [];
  for (const path of paths) {
    const style = window.getComputedStyle(path);
    const hasDash = style.strokeDasharray && style.strokeDasharray !== "none";
    const unsupportedStroke = style.strokeLinecap !== "butt" || style.strokeLinejoin !== "miter";
    const opacity = number(style.opacity, 1);
    const fillOpacity = number(style.fillOpacity, 1) * opacity;
    const strokeOpacity = number(style.strokeOpacity, 1) * opacity;
    const fill = colorFromCss(style.fill);
    const stroke = colorFromCss(style.stroke);
    const points = parseSvgPathData(path.getAttribute("d"));
    if (
      !points ||
      hasDash ||
      unsupportedStroke ||
      (fill && fill.transparency < 100 && !Number.isFinite(fillOpacity)) ||
      (stroke && stroke.transparency < 100 && !Number.isFinite(strokeOpacity))
    ) return null;
    parsedPaths.push({
      points,
      fill: fill && fill.transparency < 100
        ? { ...fill, transparency: Math.min(100, fill.transparency + Math.round((1 - fillOpacity) * 100)) }
        : { color: "000000", transparency: 100 },
      line: stroke && stroke.transparency < 100
        ? {
            color: stroke.color,
            transparency: Math.min(100, stroke.transparency + Math.round((1 - strokeOpacity) * 100)),
            width: Math.max(0.25, number(style.strokeWidth, 1) * PX_TO_POINT),
          }
        : { color: "000000", transparency: 100 },
    });
  }
  return { viewBox, paths: parsedPaths };
}

function addNativeSvgPaths(slide, shapeType, svg, canvasRect, objectIndex) {
  const definition = isSimpleSvgPathSet(svg);
  if (!definition) return false;
  const bounds = toSlideBounds(svg.getBoundingClientRect(), canvasRect);
  const mapPoint = ({ x, y }) => ({
    x: ((x - definition.viewBox.x) / definition.viewBox.width) * bounds.w,
    y: ((y - definition.viewBox.y) / definition.viewBox.height) * bounds.h,
  });
  definition.paths.forEach((path, pathIndex) => {
    const points = path.points.map((point) => {
      if (point.close) return point;
      const mapped = mapPoint(point);
      if (point.curve) {
        const control1 = mapPoint({ x: point.curve.x1, y: point.curve.y1 });
        const control2 = point.curve.type === "cubic" ? mapPoint({ x: point.curve.x2, y: point.curve.y2 }) : null;
        mapped.curve = {
          type: point.curve.type,
          x1: control1.x,
          y1: control1.y,
          ...(control2 ? { x2: control2.x, y2: control2.y } : {}),
        };
      }
      if (point.moveTo) mapped.moveTo = true;
      return mapped;
    });
    slide.addShape(shapeType.custGeom, {
      ...bounds,
      fill: path.fill,
      line: path.line,
      points,
      objectName: objectName(svg, "Native SVG path", objectIndex + pathIndex),
    });
  });
  return true;
}

function noteText(canvas) {
  const note = canvas.querySelector(".slide-note-source");
  if (!note) return "";
  return note.innerText.replace(/\n{3,}/g, "\n\n").trim();
}

async function addCanvasToPptxSlide(pptxSlide, shapeType, canvas, slideIndex) {
  const canvasRect = canvas.getBoundingClientRect();
  const background = colorFromCss(window.getComputedStyle(canvas).backgroundColor) || { color: "FFFFFF", transparency: 0 };
  pptxSlide.background = { color: background.color, transparency: background.transparency };

  let objectIndex = 0;
  const addObject = () => {
    objectIndex += 1;
    return objectIndex;
  };

  const walk = async (element) => {
    if (!(element instanceof Element) || isExcluded(element)) return;
    const style = window.getComputedStyle(element);
    if (!isVisibleBox(element, style)) return;
    if (isScreenReaderOnlyBox(element, style)) return;
    const currentIndex = addObject();

    if (element.tagName === "svg") {
      if (addNativeSvgPaths(pptxSlide, shapeType, element, canvasRect, currentIndex)) return;
      await addVectorImage(pptxSlide, element, canvasRect, currentIndex);
      return;
    }

    if (element.tagName === "IMG") {
      await addVectorImage(pptxSlide, element, canvasRect, currentIndex);
      return;
    }

    const bounds = toSlideBounds(element.getBoundingClientRect(), canvasRect);
    addEditableBox(pptxSlide, shapeType, element, style, bounds, currentIndex);
    const text = ownText(element);
    if (text) addEditableText(pptxSlide, element, style, bounds, text, currentIndex);

    for (const child of element.children) {
      await walk(child);
    }
  };

  // `aria-hidden` is commonly used on decorative SVGs. It must not remove
  // their visual counterpart from the export, so visibility is governed by
  // CSS and the intentionally excluded authoring-only elements above.
  await walk(canvas);
  const notes = noteText(canvas);
  if (notes) pptxSlide.addNotes(notes.split("\n"));
  return { slideIndex, objectCount: objectIndex };
}

function activateCanvasForExport(canvas) {
  const previous = canvas.getAttribute("style");
  // Reveal marks future slides `display:none`. Giving the canvas a zero
  // opacity preserves the user's visible slide while exposing exact geometry
  // for conversion. Opacity is not inherited, so its children retain their
  // own computed text and fill colours during extraction.
  const section = canvas.closest("section");
  const previousSection = section?.getAttribute("style") ?? null;
  // Reveal hides future sections rather than their canvas. Preserve the
  // authored 960×540 coordinate space, only making the inactive section
  // measurable for this conversion pass.
  if (section) {
    section.style.setProperty("display", "block", "important");
    section.style.setProperty("visibility", "visible", "important");
    section.style.setProperty("opacity", "0", "important");
    section.style.setProperty("transform", "none", "important");
    section.style.setProperty("left", "0", "important");
    section.style.setProperty("top", "0", "important");
  }
  canvas.style.setProperty("display", "block", "important");
  canvas.style.setProperty("visibility", "visible", "important");
  return () => {
    if (previous === null) canvas.removeAttribute("style");
    else canvas.setAttribute("style", previous);
    if (section) {
      if (previousSection === null) section.removeAttribute("style");
      else section.setAttribute("style", previousSection);
    }
  };
}

function fileNameForDeck(title) {
  const safeTitle = (title || "slides")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "slides";
  const day = new Date().toISOString().slice(0, 10);
  return `${safeTitle}-${day}.pptx`;
}

export async function exportDeckAsPptx({ title = "Slides", author = "", company = "" } = {}) {
  // Keep the editable-export library out of the normal authoring bundle. It
  // is only needed at the explicit moment a user exports a presentation.
  if (!PptxGenJS) {
    ({ default: PptxGenJS } = await import("pptxgenjs"));
  }
  await document.fonts?.ready;
  await nextFrame();

  const canvases = Array.from(document.querySelectorAll(".reveal .slides > .slide-canvas"));
  if (!canvases.length) throw new Error("No slide canvases were found for PPTX export.");

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "LATTICE_WIDE", width: PPTX_WIDTH, height: PPTX_HEIGHT });
  pptx.layout = "LATTICE_WIDE";
  pptx.author = author || "Lattice";
  pptx.company = company || "";
  pptx.subject = "Editable slide deck export";
  pptx.title = title;
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
    lang: "en-US",
  };

  const result = [];
  for (const [index, canvas] of canvases.entries()) {
    const restore = activateCanvasForExport(canvas);
    try {
      await nextFrame();
      const slide = pptx.addSlide();
      result.push(await addCanvasToPptxSlide(slide, pptx.ShapeType, canvas, index + 1));
    } finally {
      restore();
    }
  }

  await pptx.writeFile({ fileName: fileNameForDeck(title), compression: true });
  return result;
}
