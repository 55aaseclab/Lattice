import { createNativeHttpHandler } from './web-handler.mjs';
function route({method,pathname,search=''}) {
  const parameters=new URLSearchParams(search),shell=['/','/index.html'].includes(pathname),managed=parameters.has('slidesSpace')||parameters.has('slidesResource')||parameters.get('deck')?.includes(':');
  const checks=[];
  if(method==='POST'&&pathname==='/workbench/api/render')checks.push('native-render');
  if(shell&&(!parameters.get('deck')||managed))pathname='/_business/';
  else if(!pathname.startsWith('/_business/')&&!pathname.startsWith('/api/slides/')) {checks.push('legacy-decks');if(shell)pathname='/_viewer/';}
  if(pathname.startsWith('/api/slides/'))return {binding:'core',pathname:'/api/business/slides/web/'+pathname.slice('/api/slides/'.length),checks};
  return {binding:'native',pathname,checks};
}

export function createWebIntegration() {
  return {
    "slug": "slides",
    "policy": "grant",
    "kind": "proxy",
    "upgradePolicies": ["legacy-decks"],
    "nativePort": 14666,
    "nativePolicies": {
      "legacy-decks": {
        "resource": "legacy-decks",
        "actions": [
          "read"
        ],
        "legacyEndpoint": "/api/business/web-resource-access/slides/legacy-decks"
      },
      "native-render": {
        "resource": "legacy-decks",
        "actions": [
          "read",
          "render"
        ],
        "legacyEndpoint": "/api/business/web-resource-access/slides/native-render"
      }
    },
    "noNavigationPrefixes": ["/workbench/api", "/lattice/portal/api", "/lattice/portal/decks"],
    httpHandlers: [{prefix:'/api/business/slides/web/',createHandler:createNativeHttpHandler}],
    nativeReads: [{path:'/lattice/portal/decks',resource:'legacy-decks',action:'read',maximumBytes:2097152}],
    jobAuthorization: {path:'/api/business/slides/authorize-job',maximumBytes:16384,maximumActions:8},
    "corePrefixes": [
      "/api/business/slides/web/"
    ],
    route
  };
}
