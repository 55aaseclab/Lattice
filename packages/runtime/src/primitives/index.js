import {
  defineGrid,
  gridContainerStyle,
  gridAreaStyle,
  gridPlacementStyle,
  renderGridOverlay,
} from "../grid/index.js";
import { validateGridPlacements } from "../validator/index.js";

export function createPrimitives({ textboxClass = "slide-textbox", groupClass = "slide-group" } = {}) {
  const styleAttrs = (styles = {}) =>
    Object.entries(styles)
      .filter(([, value]) => value !== "" && value !== null && value !== void 0)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");

  const positioned = ({
    anchor = "center",
    region = "body-full",
    content = "",
    className = "",
    insetX = 18,
    insetY = 17,
    width = "",
    maxWidth = "",
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
        <div class="${contentClasses}" ${style ? `style="${style}"` : ""}>
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

    textbox({ body, className = "" }) {
      const classes = [textboxClass, className].filter(Boolean).join(" ");
      return `
        <div class="${classes}">
          ${body}
        </div>
      `;
    },

    positioned({ body, anchor = "center", region = "body-full", className = "", insetX = 18, insetY = 17, width = "", maxWidth = "" }) {
      return positioned({ anchor, region, content: body, className, insetX, insetY, width, maxWidth });
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
        .map(({ area = "", col, row, colSpan = 1, rowSpan = 1, content = "", cellClassName = "", fit = "", style = "" }) => {
          const classes = ["sl-grid-cell", fit ? `sl-fit-${fit}` : "", cellClassName].filter(Boolean).join(" ");
          const placement = area ? gridAreaStyle(area) : gridPlacementStyle({ col, row, colSpan, rowSpan });
          return `
            <div class="${classes}" style="${[placement, style].filter(Boolean).join("; ")}">
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

    gridCell({ area = "", col, row, colSpan = 1, rowSpan = 1, content = "", className = "", fit = "", style = "" }) {
      const classes = ["sl-grid-cell", fit ? `sl-fit-${fit}` : "", className].filter(Boolean).join(" ");
      const placement = area ? gridAreaStyle(area) : gridPlacementStyle({ col, row, colSpan, rowSpan });
      return `
        <div class="${classes}" style="${[placement, style].filter(Boolean).join("; ")}">
          ${content}
        </div>
      `;
    },
  };
}
