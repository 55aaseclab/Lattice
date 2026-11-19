/*
 * simple-light stop-reveal animation preset catalog (M7).
 *
 * Themes own the only named animation vocabulary. A deck never writes
 * animation CSS: its lattice.timeline.v1 declaration references preset names
 * from this catalog, and the timeline/edit/compile surfaces validate against
 * this machine-readable catalog before anything is written or rendered.
 *
 * The presets themselves are pure per-frame CSS in ./styles.css keyed on the
 * canonical frame variables (Slide Runtime contract): every painted frame is
 * a pure function of the integer frame, so DOM, workbench preview, and video
 * export render identical pixels for the same frame. No keyframes, no wall
 * clock, no backend time.
 */

export const STOP_REVEAL_PRESETS_SCHEMA = "lattice.stop-reveal-presets.v1";

export const ANIMATION_DIRECTIONS = ["up", "down", "left", "right", "none"];

function integerParam({ minimum, maximum, fallback }) {
  return { type: "integer", minimum, maximum, default: fallback };
}

function enumParam(values, fallback) {
  return { type: "enum", values, default: fallback };
}

export const ANIMATION_PARAM_CATALOG = {
  direction: enumParam(ANIMATION_DIRECTIONS, "up"),
  durationFrames: integerParam({ minimum: 1, maximum: 600, fallback: 12 }),
  stagger: integerParam({ minimum: 0, maximum: 300, fallback: 0 }),
  distancePx: integerParam({ minimum: 0, maximum: 480, fallback: 24 }),
};

export const STOP_REVEAL_PRESET_CATALOG = Object.freeze({
  schema: STOP_REVEAL_PRESETS_SCHEMA,
  theme: "simple-light",
  version: 1,
  description:
    "Named stop-reveal animation presets. Reveal windows end exactly on the stop's frame: " +
    "jumping to a stop always shows its fully revealed state. stagger shifts each element's " +
    "window start earlier by index * stagger frames so every element of a stop completes " +
    "together on the stop frame.",
  presets: Object.freeze([
    Object.freeze({
      name: "fade",
      description: "Opacity-only reveal from 0 to 1 across the animation window.",
      params: Object.freeze({
        durationFrames: { ...ANIMATION_PARAM_CATALOG.durationFrames },
        stagger: { ...ANIMATION_PARAM_CATALOG.stagger },
      }),
    }),
    Object.freeze({
      name: "rise",
      description: "Fade plus a directional translate that settles on the revealed position.",
      params: Object.freeze({
        direction: { ...ANIMATION_PARAM_CATALOG.direction },
        durationFrames: { ...ANIMATION_PARAM_CATALOG.durationFrames },
        stagger: { ...ANIMATION_PARAM_CATALOG.stagger },
        distancePx: { ...ANIMATION_PARAM_CATALOG.distancePx },
      }),
    }),
    Object.freeze({
      name: "wipe",
      description: "Directional clip-path wipe uncovering the element across the animation window.",
      params: Object.freeze({
        direction: { ...ANIMATION_PARAM_CATALOG.direction },
        durationFrames: { ...ANIMATION_PARAM_CATALOG.durationFrames },
        stagger: { ...ANIMATION_PARAM_CATALOG.stagger },
      }),
    }),
  ]),
});

export function findStopRevealPreset(name) {
  if (typeof name !== "string") return null;
  return STOP_REVEAL_PRESET_CATALOG.presets.find((preset) => preset.name === name) ?? null;
}

/**
 * Validate an animation declaration ({preset, ...params}) against the catalog.
 * Returns { ok, errors, normalized } where normalized carries every declared
 * param plus catalog defaults for params the preset declares.
 */
export function validateStopRevealAnimation(animation, { label = "animation" } = {}) {
  const errors = [];
  if (animation === null || typeof animation !== "object" || Array.isArray(animation)) {
    return { ok: false, errors: [`${label} must be an object`], normalized: null };
  }
  const preset = findStopRevealPreset(animation.preset);
  if (!preset) {
    const known = STOP_REVEAL_PRESET_CATALOG.presets.map((entry) => entry.name).join(", ");
    errors.push(`${label}.preset ${JSON.stringify(animation.preset ?? null)} is not in the theme preset catalog (known: ${known})`);
    return { ok: false, errors, normalized: null };
  }
  const normalized = { preset: preset.name };
  for (const [paramName, paramSpec] of Object.entries(preset.params)) {
    const raw = animation[paramName];
    if (raw === undefined) {
      normalized[paramName] = paramSpec.default;
      continue;
    }
    if (paramSpec.type === "enum") {
      if (!paramSpec.values.includes(raw)) {
        errors.push(`${label}.${paramName} must be one of ${JSON.stringify(paramSpec.values)}, got ${JSON.stringify(raw)}`);
        continue;
      }
      normalized[paramName] = raw;
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      errors.push(`${label}.${paramName} must be an integer, got ${JSON.stringify(raw)}`);
      continue;
    }
    if (raw < paramSpec.minimum || raw > paramSpec.maximum) {
      errors.push(`${label}.${paramName} must be between ${paramSpec.minimum} and ${paramSpec.maximum}, got ${raw}`);
      continue;
    }
    normalized[paramName] = raw;
  }
  const unknown = Object.keys(animation).filter((key) => key !== "preset" && !(key in preset.params));
  for (const key of unknown) {
    errors.push(`${label}.${key} is not a parameter of preset "${preset.name}" (allowed: ${Object.keys(preset.params).join(", ")})`);
  }
  return { ok: errors.length === 0, errors, normalized: errors.length === 0 ? normalized : null };
}
