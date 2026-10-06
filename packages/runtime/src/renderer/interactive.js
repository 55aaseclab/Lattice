import { axisBottom, axisLeft } from "d3-axis";
import { extent } from "d3-array";
import { drag } from "d3-drag";
import { scaleLinear } from "d3-scale";
import { select, pointer } from "d3-selection";
import { curveMonotoneX, line } from "d3-shape";
import { timeFormat } from "d3-time-format";

export function initInteractiveTrendCharts(rootElement, deckId) {
  const storageKey = `slides-interactive-trend:${deckId}`;
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");

  rootElement.querySelectorAll("[data-interactive-trend-chart]").forEach((chartElement) => {
    const chartId = chartElement.dataset.interactiveTrendChart;
    const surface = chartElement.querySelector(".interactive-trend-chart-surface");
    if (!surface) return;

    const readJson = (selector, fallback) => {
      const source = chartElement.querySelector(selector);
      if (!source?.textContent) return fallback;
      return JSON.parse(source.textContent);
    };

    const series = readJson("[data-trend-series]", []).map((point, index) => ({
      ...point,
      index,
      dateObject: new Date(point.date),
    }));
    const annotations = readJson("[data-trend-annotations]", []);
    const ticks = readJson("[data-trend-ticks]", []);
    const options = readJson("[data-trend-options]", {});
    const viewStartIndex = options.viewStartIndex ?? 0;
    const visibleSeries = series.slice(viewStartIndex);
    const formatMonth = timeFormat("%b %Y");

    function saveAnnotation(annotationId, x, y) {
      const all = JSON.parse(localStorage.getItem(storageKey) || "{}");
      all[chartId] ??= {};
      all[chartId][annotationId] = { x, y };
      localStorage.setItem(storageKey, JSON.stringify(all));
      saved[chartId] ??= {};
      saved[chartId][annotationId] = { x, y };
    }

    function draw() {
      const width = Math.max(320, surface.clientWidth);
      const height = Math.max(220, surface.clientHeight);
      const margin = { top: 26, right: 18, bottom: 42, left: 42 };
      const innerWidth = width - margin.left - margin.right;
      const innerHeight = height - margin.top - margin.bottom;

      surface.innerHTML = "";

      const svg = select(surface)
        .append("svg")
        .attr("class", "d3-trend-svg")
        .attr("width", width)
        .attr("height", height)
        .attr("role", "img")
        .attr("aria-label", chartElement.dataset.trendAriaLabel || "Trend chart");

      const plot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
      const x = scaleLinear()
        .domain(extent(visibleSeries, (point) => point.index))
        .range([0, innerWidth]);
      const y = scaleLinear().domain([0, 100]).range([innerHeight, 0]);

      plot
        .append("g")
        .attr("class", "d3-trend-grid")
        .call(axisLeft(y).tickValues([0, 25, 50, 75, 100]).tickSize(-innerWidth).tickFormat((value) => value))
        .call((axis) => axis.select(".domain").remove())
        .call((axis) => axis.selectAll("text").style("font-size", "10pt"));

      plot
        .append("g")
        .attr("class", "d3-trend-axis d3-trend-axis-x")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(
          axisBottom(x)
            .tickValues(ticks.map((tick) => tick.index))
            .tickFormat((index) => ticks.find((tick) => tick.index === index)?.label ?? ""),
        )
        .call((axis) => axis.selectAll("text").style("font-size", "10pt"));

      const trendLine = line()
        .x((point) => x(point.index))
        .y((point) => y(point.value))
        .curve(curveMonotoneX);

      plot
        .append("path")
        .datum(visibleSeries)
        .attr("class", "d3-trend-line")
        .attr("d", trendLine);

      plot
        .selectAll(".d3-trend-point")
        .data(visibleSeries)
        .join("circle")
        .attr("class", "d3-trend-point")
        .attr("cx", (point) => x(point.index))
        .attr("cy", (point) => y(point.value))
        .attr("r", 3);

      const hoverLine = plot
        .append("line")
        .attr("class", "d3-trend-hover-line")
        .attr("y1", 0)
        .attr("y2", innerHeight)
        .style("opacity", 0);
      const hoverPoint = plot.append("circle").attr("class", "d3-trend-hover-point").attr("r", 5).style("opacity", 0);
      const tooltip = select(surface).append("div").attr("class", "d3-trend-tooltip");

      svg.on("pointermove", (event) => {
        const [mouseX] = pointer(event, plot.node());
        const nearest = visibleSeries.reduce((best, point) => {
          const distance = Math.abs(x(point.index) - mouseX);
          return distance < best.distance ? { point, distance } : best;
        }, { point: visibleSeries[0], distance: Number.POSITIVE_INFINITY }).point;

        const pointX = margin.left + x(nearest.index);
        const pointY = margin.top + y(nearest.value);
        hoverLine.attr("x1", x(nearest.index)).attr("x2", x(nearest.index)).style("opacity", 1);
        hoverPoint.attr("cx", x(nearest.index)).attr("cy", y(nearest.value)).style("opacity", 1);
        tooltip
          .style("opacity", 1)
          .style("left", `${Math.min(width - 170, Math.max(8, pointX + 10))}px`)
          .style("top", `${Math.max(8, pointY - 36)}px`)
          .html(`<strong>${formatMonth(nearest.dateObject)}</strong><br />Interest: ${nearest.value}`);
      });

      svg.on("pointerleave", () => {
        hoverLine.style("opacity", 0);
        hoverPoint.style("opacity", 0);
        tooltip.style("opacity", 0);
      });

      const annotationLayer = select(surface).append("div").attr("class", "d3-trend-annotation-layer");
      const chartSaved = saved?.[chartId] ?? {};

      annotationLayer
        .selectAll(".d3-trend-annotation")
        .data(annotations)
        .join("div")
        .attr("class", "d3-trend-annotation")
        .attr("data-annotation-id", (annotation) => annotation.id)
        .style("left", (annotation) => `${chartSaved[annotation.id]?.x ?? annotation.x}%`)
        .style("top", (annotation) => `${chartSaved[annotation.id]?.y ?? annotation.y}%`)
        .html(
          (annotation) => `
            <p class="d3-trend-annotation-title">${annotation.title}</p>
            ${annotation.lines.map((lineText) => `<p>${lineText}</p>`).join("")}
          `,
        )
        .call(
          drag()
            .on("start", function () {
              select(this).classed("is-dragging", true);
            })
            .on("drag", function (event, annotation) {
              const node = this;
              const rect = surface.getBoundingClientRect();
              const annotationRect = node.getBoundingClientRect();
              const nextX = Math.max(0, Math.min(rect.width - annotationRect.width, event.x));
              const nextY = Math.max(0, Math.min(rect.height - annotationRect.height, event.y));
              const nextXPct = (nextX / rect.width) * 100;
              const nextYPct = (nextY / rect.height) * 100;
              select(node).style("left", `${nextXPct}%`).style("top", `${nextYPct}%`);
              annotation.x = nextXPct;
              annotation.y = nextYPct;
            })
            .on("end", function (event, annotation) {
              select(this).classed("is-dragging", false);
              const left = parseFloat(select(this).style("left"));
              const top = parseFloat(select(this).style("top"));
              saveAnnotation(annotation.id, left, top);
            }),
        );
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(surface);
  });
}

export function initInteractiveAnnotations(rootElement, deckId) {
  const storageKey = `slides-annotations:${deckId}`;
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");

  rootElement.querySelectorAll("[data-annotation-surface]").forEach((surface) => {
    const surfaceId = surface.dataset.annotationSurface;
    surface.querySelectorAll(".interactive-annotation").forEach((annotation) => {
      const annotationId = annotation.dataset.annotationId;
      const savedState = saved?.[surfaceId]?.[annotationId];
      if (savedState) {
        annotation.style.left = `${savedState.x}%`;
        annotation.style.top = `${savedState.y}%`;
      }
    });
  });

  let dragState = null;

  rootElement.addEventListener("pointerdown", (event) => {
    const annotation = event.target.closest(".interactive-annotation");
    if (!annotation) return;
    const surface = annotation.closest("[data-annotation-surface]");
    if (!surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const annotationRect = annotation.getBoundingClientRect();
    dragState = {
      surface,
      annotation,
      surfaceId: surface.dataset.annotationSurface,
      annotationId: annotation.dataset.annotationId,
      offsetX: event.clientX - annotationRect.left,
      offsetY: event.clientY - annotationRect.top,
      surfaceRect,
    };
    annotation.classList.add("is-dragging");
    annotation.setPointerCapture(event.pointerId);
  });

  rootElement.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    const { surfaceRect, annotation } = dragState;
    const widthPx = annotation.getBoundingClientRect().width;
    const heightPx = annotation.getBoundingClientRect().height;
    const nextLeft = Math.max(0, Math.min(surfaceRect.width - widthPx, event.clientX - surfaceRect.left - dragState.offsetX));
    const nextTop = Math.max(0, Math.min(surfaceRect.height - heightPx, event.clientY - surfaceRect.top - dragState.offsetY));
    annotation.style.left = `${(nextLeft / surfaceRect.width) * 100}%`;
    annotation.style.top = `${(nextTop / surfaceRect.height) * 100}%`;
  });

  function commitDrag() {
    if (!dragState) return;
    const { annotation, surfaceId, annotationId } = dragState;
    const nextX = parseFloat(annotation.style.left);
    const nextY = parseFloat(annotation.style.top);
    const all = JSON.parse(localStorage.getItem(storageKey) || "{}");
    all[surfaceId] ??= {};
    all[surfaceId][annotationId] = { x: nextX, y: nextY };
    localStorage.setItem(storageKey, JSON.stringify(all));
    annotation.classList.remove("is-dragging");
    dragState = null;
  }

  rootElement.addEventListener("pointerup", commitDrag);
  rootElement.addEventListener("pointercancel", commitDrag);
}
