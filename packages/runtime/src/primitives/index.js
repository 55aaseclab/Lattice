import {
  defineGrid,
  gridContainerStyle,
  gridAreaStyle,
  gridPlacementStyle,
  renderGridOverlay,
} from "../grid/index.js";
import { validateGridPlacements } from "../validator/index.js";

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

const standardFits = new Set(["contain", "cover", "stretch"]);

const assertArray = (value, name) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`[lattice-primitives] ${name} must be an array`);
  }
};

const assertNonEmptyString = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`[lattice-primitives] ${name} must be a non-empty string`);
  }
};

const fitClass = (fit, name) => {
  if (fit !== "" && !standardFits.has(fit)) {
    throw new TypeError(`[lattice-primitives] ${name}.fit must be contain, cover, or stretch`);
  }
  return fit ? `slide-fit-${fit}` : "";
};

const tableCellContent = (value) => {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  throw new TypeError("[lattice-primitives] table cell value must be a string, number, or boolean");
};

const tableCellMarkup = (tag, cell) => {
  const isDescriptor =
    cell !== null &&
    typeof cell === "object" &&
    !Array.isArray(cell) &&
    Object.hasOwn(cell, "value");
  if (isDescriptor) {
    const { value, colspan, rowspan, scope = "" } = cell;
    const spanAttrs = [
      Number.isInteger(colspan) && colspan > 1 ? ` colspan="${colspan}"` : "",
      Number.isInteger(rowspan) && rowspan > 1 ? ` rowspan="${rowspan}"` : "",
      tag === "th" && scope ? ` scope="${escapeHtml(scope)}"` : "",
    ].join("");
    return `<${tag}${spanAttrs}>${tableCellContent(value)}</${tag}>`;
  }
  return `<${tag}>${tableCellContent(cell)}</${tag}>`;
};

export function createPrimitives({ textboxClass = "slide-textbox", groupClass = "slide-group" } = {}) {
  const styleAttrs = (styles = {}) =>
    Object.entries(styles)
      .filter(([, value]) => value !== "" && value !== null && value !== void 0)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");

  const nameAttr = (name) => (name ? ` data-inspector-name="${escapeHtml(name)}"` : "");

  const positioned = ({
    anchor = "center",
    region = "body-full",
    content = "",
    className = "",
    insetX = 18,
    insetY = 17,
    width = "",
    maxWidth = "",
    name = "",
  }) => {
    const regionClasses = ["sl-positioned", `sl-region-${region}`]
      .filter(Boolean)
      .join(" ");
    const contentClasses = ["sl-positioned-content", `sl-anchor-${anchor}`, className]
      .filter(Boolean)
      .join(" ");
    const style = styleAttrs({
      "--sl-inset-x": typeof insetX === "number" ? `${insetX}px` : insetX,
      "--sl-inset-y": typeof insetY === "number" ? `${insetY}px` : insetY,
      "--sl-width": typeof width === "number" ? `${width}px` : width,
      "--sl-max-width": typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth,
    });
    return `
      <div class="${regionClasses}">
        <div class="${contentClasses}"${nameAttr(name)} ${style ? `style="${style}"` : ""}>
          ${content}
        </div>
      </div>
    `;
  };

  return {
    group({ body, className = "" }) {
      const classes = [groupClass, className].filter(Boolean).join(" ");
      return `
        <div class="${classes}">
          ${body}
        </div>
      `;
    },

    textbox({ body, className = "", name = "" }) {
      const classes = [textboxClass, className].filter(Boolean).join(" ");
      return `
        <div class="${classes}"${nameAttr(name)}>
          ${body}
        </div>
      `;
    },

    table({ head = [], rows = [], caption = "", compact = false, className = "", name = "" }) {
      assertArray(head, "table.head");
      assertArray(rows, "table.rows");
      rows.forEach((row, index) => assertArray(row, `table.rows[${index}]`));
      const classes = ["slide-table", compact ? "slide-table-compact" : "", className].filter(Boolean).join(" ");
      const captionMarkup = caption ? `<caption>${caption}</caption>` : "";
      const headMarkup = head.length
        ? `<thead><tr>${head.map((cell) => tableCellMarkup("th", cell)).join("")}</tr></thead>`
        : "";
      const bodyMarkup = `<tbody>${rows
        .map((row) => `<tr>${row.map((cell) => tableCellMarkup("td", cell)).join("")}</tr>`)
        .join("")}</tbody>`;
      return `<table class="${classes}"${nameAttr(name)}>${captionMarkup}${headMarkup}${bodyMarkup}</table>`;
    },

    image({ src, alt = "", fit = "", width = "", height = "", ratio = "", caption = "", className = "", name = "" }) {
      assertNonEmptyString(src, "image.src");
      const classes = ["slide-figure", fitClass(fit, "image"), className].filter(Boolean).join(" ");
      const imgStyle = styleAttrs({
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        "aspect-ratio": ratio,
      });
      const img = `<img src="${src}" alt="${alt}"${imgStyle ? ` style="${imgStyle}"` : ""}>`;
      const captionMarkup = caption ? `<figcaption>${caption}</figcaption>` : "";
      return `<figure class="${classes}"${nameAttr(name)}>${img}${captionMarkup}</figure>`;
    },

    positioned({ body, anchor = "center", region = "body-full", className = "", insetX = 18, insetY = 17, width = "", maxWidth = "", name = "" }) {
      return positioned({ anchor, region, content: body, className, insetX, insetY, width, maxWidth, name });
    },

    positionedTextbox({ body, anchor = "center", region = "body-full", className = "", insetX = 18, insetY = 17, width = "", maxWidth = "" }) {
      return positioned({
        anchor,
        region,
        content: this.textbox({ body, className }),
        className: "sl-positioned-primitive",
        insetX,
        insetY,
        width,
        maxWidth,
      });
    },

    positionedGroup({ body, anchor = "center", region = "body-full", className = "", insetX = 18, insetY = 17, width = "", maxWidth = "" }) {
      return positioned({
        anchor,
        region,
        content: this.group({ body, className }),
        className: "sl-positioned-group",
        insetX,
        insetY,
        width,
        maxWidth,
      });
    },

    grid({ columns, rows, gap = 0, margin = 0, areas = {}, cells = [], className = "", overlay = true, nested = false, name = "" }) {
      const grid = defineGrid({ name, columns, rows, gap, margin, areas });
      const report = validateGridPlacements(grid);
      if (!report.ok) {
        console.warn(`[lattice-grid] placement issues in grid "${name || "anonymous"}":`, report.errors);
      }
      const cellMarkup = cells
        .map(({ area = "", col, row, colSpan = 1, rowSpan = 1, content = "", cellClassName = "", fit = "", style = "", name: cellName = "" }) => {
          const classes = ["sl-grid-cell", fitClass(fit, "grid cell"), cellClassName].filter(Boolean).join(" ");
          const placement = area ? gridAreaStyle(area) : gridPlacementStyle({ col, row, colSpan, rowSpan });
          return `
            <div class="${classes}"${area ? ` data-area="${escapeHtml(area)}"` : ""}${nameAttr(cellName)} style="${[placement, style].filter(Boolean).join("; ")}">
              ${content}
            </div>
          `;
        })
        .join("");
      return `
        <div class="${["sl-grid", nested ? "sl-grid-nested" : "", className].filter(Boolean).join(" ")}" ${name ? `data-grid="${name}"` : ""} style="${gridContainerStyle(grid)}">
          ${cellMarkup}
          ${overlay ? renderGridOverlay(grid) : ""}
        </div>
      `;
    },

    gridCell({ area = "", col, row, colSpan = 1, rowSpan = 1, content = "", className = "", fit = "", style = "", name = "" }) {
      const classes = ["sl-grid-cell", fitClass(fit, "grid cell"), className].filter(Boolean).join(" ");
      const placement = area ? gridAreaStyle(area) : gridPlacementStyle({ col, row, colSpan, rowSpan });
      return `
        <div class="${classes}"${area ? ` data-area="${escapeHtml(area)}"` : ""}${nameAttr(name)} style="${[placement, style].filter(Boolean).join("; ")}">
          ${content}
        </div>
      `;
    },
  };
}
