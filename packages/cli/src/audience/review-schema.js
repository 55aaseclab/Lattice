// lattice.audience-review.v1 — strict, dependency-free schema validation for
// persona review outputs (design §6). Every persona JSON must pass this gate
// before it enters a session round; the agent-layer review runner retries
// malformed model output against the error paths (≤2 retries).

import { REVIEW_DIMENSIONS, REVIEW_SEVERITIES, REVIEW_OPERATIONS } from "./personas.js";

export const REVIEW_SCHEMA = "lattice.audience-review.v1";

const FRAME_ADDRESS_KEYS = new Set(["slideId", "localFrame"]);
const SCORE_KEYS = new Set(["accuracy", "clarity", "pacing", "structure", "audio"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(errors, path, message) {
  errors.push({ path, message });
}

function requireString(errors, container, key, path) {
  const value = container?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(errors, path, `${key} must be a non-empty string, got ${JSON.stringify(value ?? null)}`);
    return false;
  }
  return true;
}

function checkEnum(errors, container, key, allowed, path) {
  const value = container?.[key];
  if (!allowed.includes(value)) {
    fail(errors, path, `${key} must be one of ${allowed.join("|")}, got ${JSON.stringify(value ?? null)}`);
    return false;
  }
  return true;
}

function validateFinding(errors, finding, index) {
  const path = `findings[${index}]`;
  if (!isPlainObject(finding)) {
    fail(errors, path, "must be an object");
    return;
  }
  requireString(errors, finding, "id", `${path}.id`);
  if (finding.frameAddress !== undefined) {
    const address = finding.frameAddress;
    if (!isPlainObject(address)) {
      fail(errors, `${path}.frameAddress`, "must be an object { slideId, localFrame }");
    } else {
      for (const key of Object.keys(address)) {
        if (!FRAME_ADDRESS_KEYS.has(key)) fail(errors, `${path}.frameAddress.${key}`, `unknown key (allowed: ${[...FRAME_ADDRESS_KEYS].join(", ")})`);
      }
      requireString(errors, address, "slideId", `${path}.frameAddress.slideId`);
      const localFrame = address.localFrame;
      if (!Number.isInteger(localFrame) || localFrame < 0) {
        fail(errors, `${path}.frameAddress.localFrame`, `must be a non-negative integer, got ${JSON.stringify(localFrame ?? null)}`);
      }
    }
  }
  checkEnum(errors, finding, "dimension", REVIEW_DIMENSIONS, `${path}.dimension`);
  checkEnum(errors, finding, "severity", REVIEW_SEVERITIES, `${path}.severity`);
  requireString(errors, finding, "evidence", `${path}.evidence`);
  requireString(errors, finding, "comment", `${path}.comment`);
  checkEnum(errors, finding, "operation", REVIEW_OPERATIONS, `${path}.operation`);
}

export function validateAudienceReview(review) {
  const errors = [];
  if (!isPlainObject(review)) {
    return { ok: false, errors: [{ path: "", message: "review must be a JSON object" }] };
  }
  if (review.schema !== REVIEW_SCHEMA) {
    fail(errors, "schema", `must be ${JSON.stringify(REVIEW_SCHEMA)}, got ${JSON.stringify(review.schema ?? null)}`);
  }
  requireString(errors, review, "persona", "persona");
  requireString(errors, review, "packHash", "packHash");
  requireString(errors, review, "model", "model");
  if (!Array.isArray(review.findings)) {
    fail(errors, "findings", "must be an array");
  } else {
    const seenIds = new Set();
    review.findings.forEach((finding, index) => {
      validateFinding(errors, finding, index);
      if (isPlainObject(finding) && typeof finding.id === "string" && finding.id !== "") {
        if (seenIds.has(finding.id)) fail(errors, `findings[${index}].id`, `duplicate finding id "${finding.id}"`);
        seenIds.add(finding.id);
      }
    });
  }
  if (review.verdicts !== undefined) {
    if (!Array.isArray(review.verdicts)) {
      fail(errors, "verdicts", "must be an array when present");
    } else {
      review.verdicts.forEach((verdict, index) => {
        if (!isPlainObject(verdict)) {
          fail(errors, `verdicts[${index}]`, "must be an object { findingId, resolved }");
          return;
        }
        requireString(errors, verdict, "findingId", `verdicts[${index}].findingId`);
        if (typeof verdict.resolved !== "boolean") {
          fail(errors, `verdicts[${index}].resolved`, `must be a boolean, got ${JSON.stringify(verdict.resolved ?? null)}`);
        }
      });
    }
  }
  if (review.scores !== undefined) {
    if (!isPlainObject(review.scores)) {
      fail(errors, "scores", "must be an object when present");
    } else {
      for (const key of Object.keys(review.scores)) {
        if (!SCORE_KEYS.has(key)) {
          fail(errors, `scores.${key}`, `unknown score dimension (allowed: ${[...SCORE_KEYS].join(", ")})`);
          continue;
        }
        const value = review.scores[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
          fail(errors, `scores.${key}`, `must be a finite number in [0, 5], got ${JSON.stringify(value ?? null)}`);
        }
      }
    }
  }
  for (const key of Object.keys(review)) {
    if (!["schema", "persona", "packHash", "model", "findings", "verdicts", "scores"].includes(key)) {
      fail(errors, key, "unknown top-level key (strict schema)");
    }
  }
  return { ok: errors.length === 0, errors };
}
