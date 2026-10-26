import { validateLayoutGrids } from "../layout/index.js";
import { renderDeckApp } from "./deck-app.js";
import { renderPresenterApp } from "./presenter-app.js";
import { renderFrameMode } from "./motion.js";
import { exportDeckAsPptx } from "./pptx.js";
import { createPdfExportUrl, exportDeckAsPdf, installPdfExportRenderer } from "./pdf.js";
import { installFullscreenFit } from "./fullscreen.js";
import { createThemeController, installThemePicker, isDeckThemeEnabled } from "./theme.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character]);

export function renderDeckLauncher(container, decks, {
  title = "Decks Collection",
  subtitle = "Launcher",
  deckParam = "deck",
} = {}) {
  const cards = decks.map((deck) => `
    <a class="deck-card" href="/?${deckParam}=${encodeURIComponent(deck.id)}">
      <div class="deck-card-kicker">Slide Deck</div>
      <div>
        <h2 class="deck-card-title">${escapeHtml(deck.title)}</h2>
        <p class="deck-card-desc">${escapeHtml(deck.description)}</p>
      </div>
      <div class="deck-card-action">Open deck</div>
    </a>
  `).join("");
  container.innerHTML = `
    <div class="app-shell">
      <header class="app-menu">
        <div class="app-menu-brand">
          <h1 class="app-menu-title">${escapeHtml(title)}</h1>
          <p class="app-menu-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </header>
      <main class="deck-launcher">
        <div class="deck-launcher-inner">
          <div class="deck-launcher-grid">${cards}</div>
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
    closeAll();
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
  entry.textContent = "Animate";
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
      <summary aria-label="Export options">Export <span aria-hidden="true">▾</span></summary>
      <div class="app-menu-export-options" role="menu" aria-label="Export options">
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
      pptx.textContent = "Preparing…";
      try {
        await exportDeckAsPptx({
          title: deck.title || "Slides",
          author: deck.presenter || deck.owner || "",
          company: deck.company || "",
        });
        pptx.textContent = "Downloaded";
        window.setTimeout(() => {
          pptx.textContent = "PPTX";
          pptx.disabled = false;
        }, 1600);
      } catch (error) {
        console.error("[lattice] PPTX export failed:", error);
        pptx.textContent = "Export failed";
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
    <summary aria-label="Presentation options">Present <span aria-hidden="true">▾</span></summary>
    <div class="app-menu-present-options" role="menu" aria-label="Presentation options">
      <button type="button" data-present-action="fullscreen" role="menuitem">Full screen</button>
      <button type="button" data-present-action="presenter" role="menuitem">Presenter view</button>
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
