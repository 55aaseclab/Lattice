import { bootDeckPortal } from "@55aaseclab/lattice-runtime/renderer";
import { defaultPalette, palettes } from "@55aaseclab/lattice-runtime/themes/simple-light";
import { deckList, deckRegistry } from "../decks/registry.js";

bootDeckPortal({
  deckRegistry,
  deckList,
  themes: palettes,
  defaultTheme: defaultPalette,
});
