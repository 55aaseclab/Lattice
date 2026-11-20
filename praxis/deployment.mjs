import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
import { createManagedService } from './managed-service.mjs';
import { validateSlidesModelCacheConfig, resolveSlidesModelCaches } from './model-caches.mjs';
export function createDeploymentIntegration() { return {
  stack: createStackIntegration(),
  localCompose,
  managedService: createManagedService,
  managedServices: ['slides-business'],
  "dataId": "slides",
  "volumes": [
    "slides",
    "slides-decks",
    "slides-state",
    "slides-exports"
  ],
  "adapterPort": 4328,
  "runtime": {
    "HOME": "/data/slides/home",
    "XDG_CACHE_HOME": "/data/slides/cache",
    "SLIDES_BUSINESS_KEY_FILE": "/config/key",
    "SLIDES_BUSINESS_SPACES_FILE": "/config/spaces.json",
    "SLIDES_BUSINESS_AUTHORIZATION_URL": "http://127.0.0.1:4326/api/business/slides/authorize-job",
    "SLIDES_BUSINESS_AUTHORIZATION_HOST": "${originHost}"
  },
  "spaces": {
    "version": 1,
    "spaces": {
      "${spaceId}": "/data/slides/slides.json"
    }
  },
  "businessBindings": {
    "dataDir": "/data/slides",
    "spacesFile": "/app-config/slides/spaces.json"
  },
  "initialFiles": [],
  "native": {
    "dockerfile": "Dockerfile.praxis",
    "command": [
      "node",
      "/opt/praxis/scripts/start-lattice.mjs"
    ]
  },
  validateBusinessConfig(config) { validateSlidesModelCacheConfig(config.modelCaches); },
  resolveModelCaches: resolveSlidesModelCaches,
  writerPorts: [4666, 14666]
}; }
