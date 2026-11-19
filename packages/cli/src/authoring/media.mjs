import { listKokoroVoices } from '../audio/kokoro.js';
import { listPiperVoices, PIPER_RELEASE } from '../audio/piper.js';
import { BGM_STYLES } from '../audio/bgm-synth.js';
import { personaCatalog } from '../audience/personas.js';
export { validateAudienceReview } from '../audience/review-schema.js';

export async function getNativeMediaCatalog() {
  const kokoro = await listKokoroVoices();
  const piper = listPiperVoices();
  return {
    schema: 'lattice.native-media-catalog.v1',
    voices: {
      schema: kokoro.schema,
      defaultVoice: kokoro.defaultVoice,
      engines: [
        { id: 'kokoro', backend: kokoro.backend, version: kokoro.backendVersion, model: kokoro.model },
        { id: 'piper', release: PIPER_RELEASE, provisioned: Object.keys(piper).length > 0 },
      ],
      voices: {
        ...Object.fromEntries(Object.entries(kokoro.voices).map(([id, value]) => [id, { ...value, engine: 'kokoro' }])),
        ...Object.fromEntries(Object.entries(piper).map(([id, value]) => [id, { ...value, engine: 'piper' }])),
      },
    },
    backgroundMusic: Object.keys(BGM_STYLES),
    audience: personaCatalog(),
    video: { backends: ['remotion', 'hyperframes'], operations: ['plan', 'doctor', 'still', 'render', 'subtitles', 'chapters'] },
    prerequisites: [
      'Voice metadata does not imply that speech model weights are provisioned.',
      'Backend diagnostics verify installed runtime dependencies; no operation installs packages.',
      'Audience model execution uses server configuration and the existing native review workflow.',
    ],
  };
}
