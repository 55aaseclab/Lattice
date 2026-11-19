// AI audience (v1.2, V2.0.31 critique increment) — visual perceptor for the
// experience pack (design §2 视觉（真实观感）). The stop stills the pack
// already renders are DESCRIBED by a pinned vision-language model, so persona
// reviews can judge what a viewer actually SEES (layout, emphasis, on-screen
// text) instead of only hearing the narration and reading metrics.
//
// V2.0.31 (M11 视觉判断层): description alone reads as "what is there" —
// the judgment dimension (layout feel, visual weight, emphasis, whitespace,
// contrast) was missing, so the VL call is now a DESIGN REVIEW: every still
// also gets a `critique` judged against dimensions distilled from the
// canvas-design skill (visual hierarchy, contrast, emphasis, balance,
// whitespace, alignment). The increment is backward compatible: packs built
// before it carry no critique fields and are consumed unchanged.
//
// Invocation (pinned, recorded into the pack toolchain): `opencode run -m
// opencode/nemotron-3.5-super-vl-free "<prompt>" -f <still.png>` — the free
// supply the 2026-10-29 probe proved (the prompt must precede -f: opencode's
// variadic --file swallows trailing positionals otherwise). Mirrors the
// whisper ASR backend contract: a test-only deterministic stub engine
// (LATTICE_VL_ENGINE=stub), an explicit off switch, and FAILURE DEGRADATION —
// a VL outage never blocks the pack: stills, transcript, and metrics are
// unaffected and the pack records the failure in vision.md instead.

import { spawnSync } from "node:child_process";
import fsSync from "node:fs";

export const VL_MODEL_ID = "opencode/nemotron-3.5-super-vl-free";

// The judgment dimensions, distilled from the canvas-design skill's design
// principles (≤8 review points; slides are judged as designed canvases, not
// as art objects — the dimensions transfer, the manifesto does not).
export const VL_CRITIQUE_DIMENSIONS = Object.freeze([
  "visual hierarchy — where the eye lands first, and whether that is the frame's actual point",
  "contrast — whether key text and emphasis separate cleanly from background and secondary content",
  "emphasis placement — whether the strongest visual weight sits on the frame's message",
  "balance — composition weight without lopsided corners or hollow regions",
  "whitespace — breathing room that is neither cramped nor hollow",
  "alignment — coherent edges and grid discipline",
]);

export const VL_PROMPT = [
  "You are the visual perceptor and design critic of an AI slide-deck audience watching one frozen frame of a technical presentation.",
  "First describe in 2-3 concrete sentences what a viewer SEES: the layout, the exact key on-screen text (quote short phrases verbatim), and where the visual emphasis sits. Do not speculate beyond the image and do not summarize the topic.",
  `Then critique the frame as a design reviewer, one short sentence per violated or notable dimension, against: ${VL_CRITIQUE_DIMENSIONS.join("; ")}.`,
  "Answer in exactly this shape:",
  "DESCRIPTION: <2-3 sentences>",
  "CRITIQUE: <1-4 sentences naming what is visually wrong, or why the frame reads clean>",
].join(" ");

export const VL_PROMPT_CONTRACT = "2-3 description sentences + a design critique (hierarchy/contrast/emphasis/balance/whitespace/alignment) per stop still";

const CRITIQUE_MARKER = /\n?^CRITIQUE:\s*/im;

/**
 * Split one VL answer into { description, critique }. Degradation is
 * contractual: an answer without the CRITIQUE marker keeps its full text as
 * the description and yields a null critique (an old-model answer is never a
 * pack failure).
 */
export function splitVisionAnswer(answer) {
  const text = String(answer ?? "").trim();
  const match = text.match(CRITIQUE_MARKER);
  if (!match) {
    return { description: text.replace(/^DESCRIPTION:\s*/i, "").trim(), critique: null };
  }
  const description = text.slice(0, match.index).replace(/^DESCRIPTION:\s*/i, "").trim();
  const critique = text.slice(match.index + match[0].length).trim();
  return { description, critique: critique === "" ? null : critique };
}

function opencodeVersion() {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 30000 });
  const version = (result.stdout ?? "").trim().split("\n")[0] ?? "";
  return version !== "" ? version : null;
}

export function visionModeFromEnv() {
  const mode = process.env.LATTICE_VL_ENGINE;
  if (mode === "stub") return "stub";
  if (mode === "off") return "off";
  return "opencode";
}

/**
 * Vision engine factory. Returns { mode, identity, describe } where
 * `identity` is the deterministic provenance record and `describe({ image,
 * slideId, stopId, frame })` returns { description, critique } — the
 * description and the canvas-design-dimension critique (critique is null
 * when the model answer carries none). The real opencode engine degrades:
 * engine-level failures throw a structured error the pack turns into an
 * explicit "failed" vision section, never a crash.
 */
export async function createVisionEngine() {
  const mode = visionModeFromEnv();
  if (mode === "stub") {
    return {
      mode: "stub",
      identity: { engine: "stub" },
      async describe({ image, slideId, stopId, frame }) {
        const bytes = fsSync.existsSync(image) ? fsSync.statSync(image).size : 0;
        return {
          description: `[stub vision] slide "${slideId}" stop "${stopId}" frame ${frame}: deterministic stand-in visual description for tests (${bytes} bytes).`,
          critique: `[stub critique] slide "${slideId}" stop "${stopId}" frame ${frame}: deterministic stand-in design critique for tests — visual hierarchy puts the caption above the key number, alignment drifts on the right edge.`,
        };
      },
    };
  }
  if (mode === "off") {
    return {
      mode: "off",
      identity: { engine: "off" },
      async describe() {
        throw Object.assign(new Error("the vision engine is off (LATTICE_VL_ENGINE=off)"), { code: "vl-engine-off" });
      },
    };
  }
  const version = opencodeVersion();
  return {
    mode: "opencode",
    identity: { engine: "opencode-run", ...(version ? { engineVersion: version } : {}), model: VL_MODEL_ID },
    async describe({ image, slideId, stopId, frame }) {
      // Pinned invocation: prompt BEFORE -f (variadic --file would swallow a
      // trailing positional as a second attachment path).
      const result = spawnSync("opencode", ["run", "-m", VL_MODEL_ID, VL_PROMPT, "-f", image], {
        encoding: "utf8",
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const answer = (result.stdout ?? "").trim();
      if (result.error) {
        throw Object.assign(
          new Error(`opencode run failed to start for the ${slideId}/${stopId} still: ${result.error.message}`),
          { code: "vl-engine-failed" },
        );
      }
      if (answer === "" || /File not found:/i.test(answer)) {
        throw Object.assign(
          new Error(`the vision model returned no description for the ${slideId}/${stopId} still (exit ${result.status}): ${(result.stderr ?? "").slice(0, 400)}`),
          { code: "vl-engine-failed" },
        );
      }
      return splitVisionAnswer(answer);
    },
  };
}
