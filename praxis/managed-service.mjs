import { dirname, resolve } from 'node:path';
import { resolveSlidesModelCaches } from './model-caches.mjs';
export async function createManagedService({ app: slides, config, corePort: port, uid, gid, workspace, controlDirectory, stateDirectories, appDirectories, readOnlyFiles, privatePath, readPrivateJson, distinctDirectories, mount, overlaps, isWithin, fail, build }) {
  const services = {}, ports = [];
  if (slides) {
    if (slides.managed !== true || slides.url !== 'http://127.0.0.1:4328/api/business') fail('INVALID_MANAGED_ENDPOINT', 'Slides requires its managed fixed loopback adapter.');
    await privatePath(slides.dataDir, { directory: true, data: true });
    await privatePath(slides.spacesFile);
    const mapping = await readPrivateJson(slides.spacesFile);
    if (!mapping || Object.keys(mapping).some(key => key !== 'spaces') || !mapping.spaces || typeof mapping.spaces !== 'object' || Array.isArray(mapping.spaces) || JSON.stringify(Object.keys(mapping.spaces).sort()) !== JSON.stringify([...slides.spaces].sort())) fail('INVALID_SPACE_MAPPING', 'Slides mapping must match its configured spaces exactly.');
    const files = Object.values(mapping.spaces);
    if (new Set(files).size !== files.length || files.some(file => typeof file !== 'string' || dirname(file) !== slides.dataDir || !file.endsWith('.json'))) fail('INVALID_SPACE_MAPPING', 'Slides spaces require separate JSON files in their registered data directory.');
    for (const file of files) await privatePath(file, { allowMissing: true, data: true, maxSize: Infinity });
    if (stateDirectories.concat(appDirectories).some(directory => overlaps(directory, slides.dataDir)) || readOnlyFiles.concat(slides.spacesFile).some(file => isWithin(slides.dataDir, file)) || isWithin(slides.dataDir, controlDirectory)) fail('OVERLAPPING_DATA_MOUNT', 'Slides data must remain separate from identity, other applications, credentials and controls.');
    appDirectories.push(slides.dataDir);
    const modelCaches = await resolveSlidesModelCaches(slides.modelCaches, { uid, protectedPaths: [workspace, controlDirectory, ...stateDirectories, ...appDirectories, ...readOnlyFiles, slides.spacesFile, config.observationsFile && dirname(config.observationsFile), config.console?.storageStatusFile && dirname(config.console.storageStatusFile), config.console?.storageConfigFile, ...Object.values(config.apps).flatMap(app => [app.keyFile && dirname(app.keyFile), app.spacesFile && dirname(app.spacesFile), app.dataDir, app.dataFile && dirname(app.dataFile)])] });
    services['slides-business'] = {
      image: 'praxis-business/slides:local',
      build,
      command: ['node', 'src/business/server.mjs', '--host', '127.0.0.1', '--port', '4328'],
      network_mode: 'host', init: true, user: `${uid}:${gid}`, read_only: true, restart: 'unless-stopped',
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], tmpfs: ['/tmp:rw,nosuid,nodev,size=1024m,mode=1777'], shm_size: '1gb', stop_grace_period: '30s',
      environment: { SLIDES_BUSINESS_KEY_FILE: slides.keyFile, SLIDES_BUSINESS_SPACES_FILE: slides.spacesFile, SLIDES_BUSINESS_AUTHORIZATION_URL: `http://127.0.0.1:${port}/api/business/slides/authorize-job`, SLIDES_BUSINESS_AUTHORIZATION_HOST: new URL(config.issuer).host, ...modelCaches.environment },
      healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4328/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], interval: '10s', timeout: '5s', retries: 3, start_period: '10s' },
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      volumes: [mount(slides.dataDir), mount(slides.keyFile, true), mount(slides.spacesFile, true), ...modelCaches.volumes],
    };
    ports.push(4328);
  }
  return { services, ports };
}
