const kebabCase = (value) => String(value).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);

export function resolveTheme(themes, requestedId, fallbackId = themes[0]?.id) {
  if (!Array.isArray(themes) || themes.length === 0) {
    throw new TypeError("[lattice-theme] themes must be a non-empty array");
  }
  return themes.find(({ id }) => id === requestedId)
    || themes.find(({ id }) => id === fallbackId)
    || themes[0];
}

export function isDeckThemeEnabled(deck, themes) {
  return Boolean(deck && Array.isArray(themes) && themes.length);
}

export function applyThemeTokens(theme, {
  root = document.documentElement,
  prefix = "sl-theme",
  dataset = "latticeTheme",
} = {}) {
  if (!theme?.id || !theme?.tokens) throw new TypeError("[lattice-theme] theme must define id and tokens");
  root.dataset[dataset] = theme.id;
  Object.entries(theme.tokens).forEach(([name, value]) => {
    root.style.setProperty(`--${prefix}-${kebabCase(name)}`, value);
  });
  return theme;
}

export function createThemeController({
  themes,
  defaultTheme = themes?.[0]?.id,
  storageKey = "lattice-theme",
  queryParam = "theme",
  prefix = "sl-theme",
  dataset = "latticeTheme",
  root = document.documentElement,
  location = window.location,
  history = window.history,
  storage = window.localStorage,
  persist = true,
  onChange,
} = {}) {
  const currentUrl = new URL(location.href);
  const requested = currentUrl.searchParams.get(queryParam) || (persist ? storage?.getItem(storageKey) : "");
  let current = resolveTheme(themes, requested, defaultTheme);

  const apply = (themeId, { write = true } = {}) => {
    current = resolveTheme(themes, themeId, defaultTheme);
    applyThemeTokens(current, { root, prefix, dataset });
    if (write && persist) storage?.setItem(storageKey, current.id);
    if (write && queryParam) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.set(queryParam, current.id);
      history?.replaceState({}, "", nextUrl);
    }
    onChange?.(current);
    return current;
  };

  apply(current.id, { write: false });
  return {
    apply,
    get current() {
      return current;
    },
  };
}

export function installThemePicker({
  container = document.querySelector(".app-menu-actions"),
  controller,
  themes,
  label = "Theme",
} = {}) {
  if (!container || !controller || !themes?.length) return null;
  const picker = document.createElement("details");
  picker.className = "deck-theme-picker";
  picker.innerHTML = `
    <summary aria-label="Choose slide theme">
      <span class="deck-theme-summary-label">${label}</span>
      <span class="deck-theme-summary-swatches" aria-hidden="true"></span>
    </summary>
    <div class="deck-theme-menu" role="listbox" aria-label="Slide themes"></div>
  `;
  const menu = picker.querySelector(".deck-theme-menu");
  const summarySwatches = picker.querySelector(".deck-theme-summary-swatches");
  const render = () => {
    const selected = controller.current;
    summarySwatches.innerHTML = (selected.swatches || [])
      .map((color) => `<i style="--theme-swatch:${color}"></i>`)
      .join("");
    menu.innerHTML = themes.map(({ id, name, swatches = [] }) => `
      <button class="deck-theme-option${id === selected.id ? " is-selected" : ""}" type="button" role="option" aria-selected="${id === selected.id}" data-theme-id="${id}">
        <span class="deck-theme-option-swatches" aria-hidden="true">${swatches.map((color) => `<i style="--theme-swatch:${color}"></i>`).join("")}</span>
        <span>${name}</span>
      </button>`).join("");
  };
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-theme-id]");
    if (!option) return;
    controller.apply(option.dataset.themeId);
    render();
    picker.open = false;
  });
  render();
  container.append(picker);
  return picker;
}
