import { initializeDatabase } from './database.mjs';
import { createDemoIntegration } from './demo.mjs';
import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
import { createManagedService } from './managed-service.mjs';
import { validateSlidesModelCacheConfig, resolveSlidesModelCaches } from './model-caches.mjs';
export function createDeploymentIntegration() { return {
  initializeDatabase,
  initialDatabases: [{"path": "lattice.db", "spaceId": "${spaceId}", "value": {"schemaVersion": 1, "cursor": 0, "documents": {}, "versions": {}, "receipts": {}, "jobs": {}, "assets": {}, "uploads": {}, "artifacts": {}, "events": []}}],
  demo: createDemoIntegration(),
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
    "SLIDES_REQUIRE_DATABASE": "1",
    "XDG_CACHE_HOME": "/data/slides/cache",
    "SLIDES_BUSINESS_KEY_FILE": "/config/key",
    "SLIDES_BUSINESS_SPACES_FILE": "/config/spaces.json",
    "SLIDES_BUSINESS_AUTHORIZATION_URL": "http://127.0.0.1:4326/api/business/slides/authorize-job",
    "SLIDES_BUSINESS_AUTHORIZATION_HOST": "${originHost}"
  },
  "spaces": {
    "version": 1,
    "spaces": {
      "${spaceId}": "/data/slides/lattice.db"
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
