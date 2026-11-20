// Source-only local installation recipe. Preserve volume identities during upgrades.
export const localCompose = {
  "services": {
    "slides": {
      "build": {
        "args": {
          "PRAXIS_GID": "${PRAXIS_GID:-1000}",
          "PRAXIS_UID": "${PRAXIS_UID:-1000}"
        },
        "context": "./third_party/lattice",
        "dockerfile": "Dockerfile.praxis"
      },
      "cap_drop": [
        "ALL"
      ],
      "command": [
        "node",
        "/opt/praxis/scripts/start-lattice.mjs"
      ],
      "configs": [
        {
          "source": "native-launcher",
          "target": "/opt/praxis/launch-builtin.mjs"
        }
      ],
      "depends_on": {
        "core": {
          "condition": "service_started",
          "required": true
        }
      },
      "entrypoint": [
        "node",
        "/opt/praxis/launch-builtin.mjs"
      ],
      "environment": {
        "HEALTH_URL": "http://127.0.0.1:14666/_business/"
      },
      "healthcheck": {
        "interval": "10s",
        "retries": 6,
        "start_period": "10s",
        "test": [
          "CMD",
          "node",
          "-e",
          "fetch(process.env.HEALTH_URL).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        "timeout": "5s"
      },
      "image": "praxis-builtins/lattice:local",
      "init": true,
      "logging": {
        "driver": "json-file",
        "options": {
          "max-file": "3",
          "max-size": "10m"
        }
      },
      "network_mode": "service:core",
      "read_only": false,
      "restart": "unless-stopped",
      "security_opt": [
        "no-new-privileges:true"
      ],
      "shm_size": "1gb",
      "stop_grace_period": "30s",
      "tmpfs": [
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777"
      ],
      "volumes": [
        {
          "read_only": true,
          "source": "slides-config",
          "target": "/config",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-data",
          "target": "/data/slides",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-decks",
          "target": "/app/decks",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-state",
          "target": "/app/.lattice",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-exports",
          "target": "/app/dist/static-decks",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        }
      ]
    },
    "slides-business": {
      "build": {
        "args": {
          "PRAXIS_GID": "${PRAXIS_GID:-1000}",
          "PRAXIS_UID": "${PRAXIS_UID:-1000}"
        },
        "context": "./third_party/lattice",
        "dockerfile": "Dockerfile.praxis"
      },
      "cap_drop": [
        "ALL"
      ],
      "command": [
        "node",
        "src/business/server.mjs",
        "--host",
        "127.0.0.1",
        "--port",
        "4328"
      ],
      "configs": [
        {
          "source": "native-launcher",
          "target": "/opt/praxis/launch-builtin.mjs"
        }
      ],
      "depends_on": {
        "core": {
          "condition": "service_started",
          "required": true
        }
      },
      "entrypoint": [
        "node",
        "/opt/praxis/launch-builtin.mjs"
      ],
      "environment": {
        "HEALTH_URL": "http://127.0.0.1:4328/health"
      },
      "healthcheck": {
        "interval": "10s",
        "retries": 6,
        "start_period": "10s",
        "test": [
          "CMD",
          "node",
          "-e",
          "fetch(process.env.HEALTH_URL).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        "timeout": "5s"
      },
      "image": "praxis-builtins/lattice:local",
      "init": true,
      "logging": {
        "driver": "json-file",
        "options": {
          "max-file": "3",
          "max-size": "10m"
        }
      },
      "network_mode": "service:core",
      "read_only": false,
      "restart": "unless-stopped",
      "security_opt": [
        "no-new-privileges:true"
      ],
      "shm_size": "1gb",
      "stop_grace_period": "30s",
      "tmpfs": [
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777"
      ],
      "volumes": [
        {
          "read_only": true,
          "source": "slides-config",
          "target": "/config",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-data",
          "target": "/data/slides",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-decks",
          "target": "/app/decks",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-state",
          "target": "/app/.lattice",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "slides-exports",
          "target": "/app/dist/static-decks",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        }
      ]
    }
  },
  "volumes": {
    "slides-config": {},
    "slides-data": {},
    "slides-decks": {},
    "slides-exports": {},
    "slides-state": {}
  },
  "initializeVolumes": [],
  "webVolumes": []
};
