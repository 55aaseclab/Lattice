const compactText = (value, maximum = 64) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1).trimEnd()}…`
    : normalized;
};

const firstUsefulClass = (element) =>
  [...(element.classList || [])].find((name) =>
    !name.startsWith("sl-") &&
    !name.startsWith("reveal-") &&
    !["present", "past", "future"].includes(name),
  );

export function describeElement(element) {
  if (!element) return null;
  const authored = element.getAttribute?.("data-inspector-name") || element.getAttribute?.("aria-label");
  if (authored) return compactText(authored);
  if (element.id) return `#${element.id}`;
  const tag = element.tagName?.toLowerCase?.() || "element";
  const className = firstUsefulClass(element);
  const selector = `${tag}${className ? `.${className}` : ""}`;
  const text = !className ? compactText(element.textContent, 42) : "";
  return text ? `${selector} · ${text}` : selector;
}

export function elementArea(element) {
  const cell = element?.closest?.("[data-area], .sl-grid-cell, .ph");
  if (!cell) return null;
  const authored = cell.getAttribute?.("data-area");
  if (authored) return authored;
  const inlineArea = cell.style?.gridArea;
  if (inlineArea && !["auto", "initial", "inherit"].includes(inlineArea)) return inlineArea;
  const semanticClass = [...(cell.classList || [])].find((name) =>
    !["ph", "sl-grid-cell", "padded", "positioning-context", "top-left", "center-top", "center-bottom", "center-middle"]
      .includes(name) &&
    !name.startsWith("slide-fit-") &&
    !name.startsWith("body-region-"),
  );
  return semanticClass || null;
}

export function slideAddress(slide, fallback = null) {
  return slide?.dataset?.slideId || slide?.dataset?.slideNumber || fallback;
}
