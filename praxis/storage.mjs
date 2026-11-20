import { projectInventory } from './inventory.mjs';
export function createStorageIntegration() { return {
  inventory: { project: projectInventory, mapping: { field: 'spacesFile', input: 'slidesSpaces' }, sourceLabels: { decks: '原生文稿目录', '.lattice': '原生编辑与素材状态' } },
  "rootId": "lattice",
  "sourceId": "slides",
  "paths": {
    "slidesDecks": "native/decks",
    "slidesState": "native/.lattice",
    "slidesBusiness": "business"
  },
  "sources": [
    {
      "kind": "directory",
      "path": "slidesDecks",
      "target": "decks",
      "registerDefault": true,
      "nativeSource": "decks"
    },
    {
      "kind": "directory",
      "path": "slidesState",
      "target": ".lattice",
      "registerDefault": true,
      "nativeSource": ".lattice"
    },
    {
      "kind": "directory",
      "path": "slidesBusiness",
      "target": "business"
    }
  ],
  "omissions": [],
  relocation: {
  "registeredRoots": [
    {
      "target": "decks",
      "path": "slidesDecks"
    },
    {
      "target": ".lattice",
      "path": "slidesState"
    }
  ],
  "businessBindings": {
    "dataDir": "slidesBusiness"
  },
  "spaceMap": {
    "input": "slidesMapping",
  "fileField": "spacesFile",
    "assertionInput": "slidesSpaces",
    "path": "slidesBusiness",
    "mode": "basename",
    "businessDirectoryField": "dataDir"
  }
}
}; }
