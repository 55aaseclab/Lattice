import { projectInventory } from './inventory.mjs';
export function createStorageIntegration() { return {
  recovery: { configFields: ['spacesFile','dataDir'], async collect(ctx) { const map=await ctx.readConfiguration('spacesFile'); const seen=new Set(); for(const file of Object.values(map.spaces||{})){ if(seen.has(file))continue;seen.add(file);await ctx.register({kind:'sqlite',source:file,target:'lattice.db'}); } const blobs=new Set(Object.values(map.blobs||{})); if(!blobs.size)for(const file of seen)blobs.add(file+'.blobs');let index=0;for(const path of blobs)await ctx.register({kind:'directory',source:path,target:'blobs/'+index++},{optional:true}); } },
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
