import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const managed = mode === 'praxis';
  const decks = resolve('decks');
  return {
    base: managed ? '/apps/slides/_business/' : './',
    define: managed ? { 'import.meta.env.PRAXIS_SLIDES_API_BASE': JSON.stringify('/apps/slides/') } : {},
    plugins: managed ? [{
      name: 'public-business-catalog',
      enforce: 'pre',
      load(file) {
        if (file === resolve(decks, 'registry.js')) return "import '@55aaseclab/lattice-runtime/themes/simple-light/styles.css';export const deckRegistry={};export const deckList=[];";
        if (file === resolve('src/presentation-decks.js')) return 'export const v2DeckRegistry={};';
        if (file.startsWith(decks + '/')) throw new Error('The business catalog cannot bundle private decks.');
      },
    }] : [],
    build: { outDir: managed ? 'dist-business' : 'dist' },
  };
});
