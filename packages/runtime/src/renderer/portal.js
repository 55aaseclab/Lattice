import { t } from './locale.js';
import { validateLayoutGrids } from "../layout/index.js";
import { renderDeckApp } from "./deck-app.js";
import { renderPresenterApp } from "./presenter-app.js";
import { renderFrameMode } from "./motion.js";
import { exportDeckAsPptx } from "./pptx.js";
import { createPdfExportUrl, exportDeckAsPdf, installPdfExportRenderer } from "./pdf.js";
import { installFullscreenFit } from "./fullscreen.js";
import { createThemeController, installThemePicker, isDeckThemeEnabled } from "./theme.js";
import { renderDeckCard } from './launcher-card.js';

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character]);

export function renderDeckLauncher(container, decks, {
  title = t("Presentations", "演示文稿"),
  subtitle = t("Presentations", "演示文稿"),
  deckParam = "deck",
} = {}) {
  const cards = decks.map(deck => renderDeckCard(deck, { deckParam })).join('');
  container.innerHTML = `
    <div class="deck-library-shell">
      <aside class="deck-library-sidebar" aria-label="${t("Deck navigation", "文稿导航")}">
        <div class="deck-library-brand">Lattice<span>${escapeHtml(subtitle)}</span></div>
        <nav><a class="deck-library-nav" href="/" aria-current="page"><span>${t("All decks", "全部文稿")}</span><span>${decks.length}</span></a></nav>
      <button class="deck-library-lang" type="button" data-deck-language></button></aside>
      <main class="deck-launcher">
        <div class="deck-launcher-inner">
          <h1>${escapeHtml(title)}</h1>
          ${cards ? `<div class="deck-launcher-grid">${cards}</div>` : ("<p role=\"status\">" + t("No decks available.", "暂无可阅读的文稿。") + "</p>")}
        </div>
      </main>
    </div>
  `;
}

export function installDismissibleMenus(menus, { root = document } = {}) {
  const menuList = Array.from(menus);
  if (!menuList.length) return () => {};
  const closeAll = (except = null) => menuList.forEach((menu) => {
    if (menu !== except) menu.open = false;
  });
  const onToggle = (event) => {
    if (event.currentTarget.open) closeAll(event.currentTarget);
  };
  menuList.forEach((menu) => menu.addEventListener("toggle", onToggle));
  const onPointerDown = (event) => {
    if (!menuList.some((menu) => menu.open)) return;
    if (!menuList.some((menu) => menu.contains(event.target))) closeAll();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !menuList.some((menu) => menu.open)) return;
    const openMenu = menuList.find(menu => menu.open && menu.contains(root.activeElement));
    closeAll();
    openMenu?.querySelector("summary")?.focus();
    event.preventDefault();
  };
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("keydown", onKeyDown);
  return () => {
    menuList.forEach((menu) => menu.removeEventListener("toggle", onToggle));
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("keydown", onKeyDown);
  };
}

function installMotionEntry(actions, deckId, deckParam) {
  if (!actions || actions.querySelector("#motion-toggle")) return;
  const motionUrl = new URL(window.location.href);
  motionUrl.searchParams.set(deckParam, deckId);
  motionUrl.searchParams.set("motion", "1");
  ["presenter", "edit", "grid", "source", "frame", "lens"].forEach((key) => motionUrl.searchParams.delete(key));
  const entry = document.createElement("a");
  entry.id = "motion-toggle";
  entry.className = "app-menu-link";
  entry.href = `${motionUrl.pathname}${motionUrl.search}`;
  entry.textContent = t("Motion", "动画");
  actions.append(entry);
}

function installDeckMenus({ deck, deckParam, themeController, themes, enablePptx, enablePdf }) {
  const menu = document.querySelector(".app-menu");
  const actions = menu?.querySelector(".app-menu-actions");
  const present = menu?.querySelector("#present-toggle");
  if (!menu || !actions || !present) return;

  actions.querySelector('a[href*="edit=1"]')?.remove();
  actions.querySelector("#presenter-toggle")?.remove();
  installMotionEntry(actions, deck.id, deckParam);

  let picker = null;
  if (themeController && themes?.length) {
    picker = installThemePicker({ container: actions, controller: themeController, themes });
  }

  if (enablePptx || enablePdf) {
    const exportMenu = document.createElement("details");
    exportMenu.className = "app-menu-export-menu";
    exportMenu.innerHTML = `
      <summary aria-label="${t("Export", "导出")}">${t("Export", "导出")} <span aria-hidden="true">▾</span></summary>
      <div class="app-menu-export-options" role="menu" aria-label="${t("Export", "导出")}">
        ${enablePptx ? '<button type="button" data-export-action="pptx" role="menuitem">PPTX</button>' : ""}
        ${enablePdf ? '<button type="button" data-export-action="pdf" role="menuitem">PDF</button>' : ""}
      </div>`;
    exportMenu.querySelector('[data-export-action="pdf"]')?.addEventListener("click", () => {
      exportDeckAsPdf(createPdfExportUrl({ deckId: deck.id, deckParam }));
      exportMenu.open = false;
    });
    const pptx = exportMenu.querySelector('[data-export-action="pptx"]');
    pptx?.addEventListener("click", async () => {
      if (pptx.disabled) return;
      exportMenu.open = false;
      pptx.disabled = true;
      pptx.textContent = t("Preparing…", "正在准备…");
      try {
        await exportDeckAsPptx({
          title: deck.title || "Slides",
          author: deck.presenter || deck.owner || "",
          company: deck.company || "",
        });
        pptx.textContent = t("Downloaded", "已下载");
        window.setTimeout(() => {
          pptx.textContent = "PPTX";
          pptx.disabled = false;
        }, 1600);
      } catch (error) {
        console.error("[lattice] PPTX export failed:", error);
        pptx.textContent = t("Export failed", "导出失败");
        window.setTimeout(() => {
          pptx.textContent = "PPTX";
          pptx.disabled = false;
        }, 2600);
      }
    });
    actions.insertBefore(exportMenu, picker);
  }

  const presentMenu = document.createElement("details");
  presentMenu.className = "app-menu-present-menu";
  presentMenu.innerHTML = `
    <summary aria-label="${t("Presentation options", "演示选项")}">${t("Present", "演示")} <span aria-hidden="true">▾</span></summary>
    <div class="app-menu-present-options" role="menu" aria-label="${t("Presentation options", "演示选项")}">
      <button type="button" data-present-action="fullscreen" role="menuitem">${t("Fullscreen", "全屏")}</button>
      <button type="button" data-present-action="presenter" role="menuitem">${t("Presenter view", "主讲视图")}</button>
    </div>`;
  const reveal = document.querySelector(".reveal");
  const fullscreen = installFullscreenFit({ reveal });
  presentMenu.querySelector('[data-present-action="fullscreen"]').addEventListener("click", async () => {
    if (document.fullscreenElement === reveal) await document.exitFullscreen();
    else {
      await reveal?.requestFullscreen();
      fullscreen.fit();
    }
    presentMenu.open = false;
  });
  presentMenu.querySelector('[data-present-action="presenter"]').addEventListener("click", () => {
    const presenterUrl = new URL(window.location.href);
    presenterUrl.searchParams.set(deckParam, deck.id);
    presenterUrl.searchParams.set("presenter", "1");
    ["motion", "edit"].forEach((key) => presenterUrl.searchParams.delete(key));
    window.open(`${presenterUrl.pathname}${presenterUrl.search}`, "_blank", "noopener");
    presentMenu.open = false;
  });
  present.replaceWith(presentMenu);
  menu.append(presentMenu);
  installDismissibleMenus(menu.querySelectorAll("details"));
}

export function bootDeckPortal({
  container = "#app",
  deckRegistry,
  deckList = Object.values(deckRegistry || {}),
  launcher = {},
  deckParam = "deck",
  themes = [],
  defaultTheme,
  themePrefix = "sl-theme",
  themeDataset = "latticeTheme",
  themeStorageKey = "lattice-theme",
  enablePptx = true,
  enablePdf = true,
  v2Decks = null,
} = {}) {
  const appElement = typeof container === "string" ? document.querySelector(container) : container;
  if (!appElement) throw new Error("[lattice-portal] container not found");
  const url = new URL(window.location.href);
  const selectedDeckId = url.searchParams.get(deckParam);
  const selectedDeck = selectedDeckId ? deckRegistry?.[selectedDeckId] : null;
  const presentMode = url.searchParams.get("present") === "1";
  const presenterMode = url.searchParams.get("presenter") === "1";
  const motionMode = url.searchParams.get("motion") === "1";
  const pdfRendererMode = url.searchParams.get("export") === "pdf-renderer";
  const gridValidation = validateLayoutGrids();
  if (!gridValidation.ok) console.warn("[lattice] layout grid validation found issues:", gridValidation.errors);

  if (presentMode) {
    // M2 Lattice Presentation (A14): Lattice-owned, no video backend. An
    // unknown or missing deck id renders an explicit error — never a
    // fallback to the v1 deck app or the launcher. Loaded lazily so the v1
    // deck app client graph never carries the presentation/slide-runtime
    // modules.
    import("./presentation-app.js")
      .then(({ bootPresentation, renderPresentationError }) => {
        let boot;
        if (!selectedDeckId) {
          boot = Promise.resolve(renderPresentationError(appElement, {
            deckId: null,
            errors: [{ code: "missing-deck", param: deckParam, value: null, message: `present mode requires a ?${deckParam}=<deck-id> parameter` }],
          }));
        } else {
          boot = bootPresentation(appElement, { deckId: selectedDeckId, v2Decks, presenter: presenterMode });
        }
        boot?.catch?.((error) => {
          console.error("[lattice] presentation failed to start:", error);
          renderPresentationError(appElement, {
            deckId: selectedDeckId,
            errors: [{ code: "boot-failed", message: error?.message ?? String(error) }],
          });
        });
      })
      .catch((error) => {
        console.error("[lattice] presentation failed to start:", error);
      });
    return { deck: selectedDeck, mode: "presentation", themeController: null };
  }

  const useThemes = isDeckThemeEnabled(selectedDeck, themes);
  const themeController = useThemes ? createThemeController({
    themes,
    defaultTheme,
    storageKey: `${themeStorageKey}:${selectedDeck.id}`,
    prefix: themePrefix,
    dataset: themeDataset,
    onChange: (theme) => {
      document.title = `${theme.name} · ${selectedDeck.title || "Slides"}`;
    },
  }) : null;

  if (!selectedDeck) {
    renderDeckLauncher(appElement, deckList, { deckParam, ...launcher });
  } else if (motionMode) {
    renderFrameMode(appElement, selectedDeck);
    if (themeController) installThemePicker({ controller: themeController, themes });
  } else if (presenterMode) {
    renderPresenterApp(appElement, selectedDeck);
  } else {
    renderDeckApp(appElement, selectedDeck);
    if (pdfRendererMode) installPdfExportRenderer();
    else installDeckMenus({
      deck: selectedDeck,
      deckParam,
      themeController,
      themes,
      enablePptx,
      enablePdf,
    });
  }
  return { deck: selectedDeck, mode: motionMode ? "motion" : presenterMode ? "presenter" : selectedDeck ? "deck" : "launcher", themeController };
}
