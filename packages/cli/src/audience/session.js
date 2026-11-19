// lattice.audience-session.v1 — session artifact + deterministic convergence
// state machine (design §4, §6). The artifact is the repo's memory of one
// rehearsal: per-round reviews (findings/verdicts/scores), improvement refs,
// and the final conclusion. Stored at .lattice/audience-sessions/<deck>/.
//
// evaluateConvergence is a PURE function of the recorded rounds (acceptance
// §12.3): given the same rounds it recomputes the same outcome. Rules:
//   escalated  — the latest round contains a product-level finding
//                (operation "PRD-draft"): the loop suspends pending human
//                approval of the PRD revision draft.
//   converged  — every finding of the previous round is voted resolved and
//                the latest round introduces zero new findings at blocking
//                severity (default: every severity — "no new findings
//                ≥ minor").
//   plateau    — the last two round transitions both made no measurable
//                improvement (needs ≥3 rounds; no previous findings resolved
//                AND no drop in blocking-finding count): exit with the
//                residual list.
//   ongoing    — otherwise the loop continues (hard cap 3 rounds is
//                reported separately as capReached).

import fsSync from "node:fs";
import path from "node:path";

export const SESSION_SCHEMA = "lattice.audience-session.v1";
export const SESSIONS_DIR = path.join(".lattice", "audience-sessions");

const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

export function findingsOfRound(round) {
  return (round?.reviews ?? []).flatMap((review) => review.findings ?? []);
}

/**
 * Verdicts collected from a round's reviews. Verdict ids are namespaced by
 * the review's position in the round (reviews[i].verdicts vote on
 * reviews[i]'s own round-(n-1) findings) because two personas may both use
 * bare "F1"-style ids that would otherwise collide.
 */
export function verdictsOfRound(round) {
  const verdicts = [];
  (round?.reviews ?? []).forEach((review, reviewIndex) => {
    for (const verdict of review.verdicts ?? []) {
      verdicts.push({ ...verdict, reviewIndex });
    }
  });
  return verdicts;
}

function verdictKey(reviewIndex, findingId) {
  return `${reviewIndex}:${findingId}`;
}

function blocking(findings, blockRank) {
  return findings.filter((finding) => (SEVERITY_RANK[finding.severity] ?? 1) >= blockRank);
}

/**
 * Previous-round findings matched with this round's verdicts by review
 * position + finding id: reviews[i] of round n vote on reviews[i] of
 * round n-1 (persona i's own findings), so bare "F1"-style ids across two
 * personas never collide.
 */
function resolvedKeys(round) {
  const keys = new Set();
  // Only review-level verdicts participate in matching: reviews[i] of round
  // n vote on reviews[i] of round n-1. A round-level `verdicts` array, when
  // present, is an informational mirror (append writes it from the reviews)
  // and carries no review position, so it never matches.
  (round?.reviews ?? []).forEach((review, reviewIndex) => {
    for (const verdict of review.verdicts ?? []) {
      if (verdict.resolved === true) keys.add(verdictKey(reviewIndex, verdict.findingId));
    }
  });
  return keys;
}

/**
 * Round-over-round improvement: the round resolved at least one previous
 * finding, or the count of blocking findings strictly dropped.
 */
export function roundImprovement(rounds, index, blockRank) {
  if (index <= 0) return null;
  const previous = rounds[index - 1];
  const current = rounds[index];
  const resolved = resolvedKeys(current);
  let resolvedCount = 0;
  (previous.reviews ?? []).forEach((review, reviewIndex) => {
    for (const finding of review.findings ?? []) {
      if (resolved.has(verdictKey(reviewIndex, finding.id))) resolvedCount += 1;
    }
  });
  const previousBlocking = blocking(findingsOfRound(previous), blockRank).length;
  const currentBlocking = blocking(findingsOfRound(current), blockRank).length;
  return {
    resolvedPrevious: resolvedCount,
    previousBlocking,
    currentBlocking,
    improved: resolvedCount > 0 || currentBlocking < previousBlocking,
  };
}

/**
 * Pure convergence determination. `blockSeverity` is the minimum severity
 * that blocks convergence (default "low" = any new finding blocks, per the
 * design's "无新发现 ≥ minor").
 */
export function evaluateConvergence(rounds, { blockSeverity = "low", maxRounds = 3 } = {}) {
  const blockRank = SEVERITY_RANK[blockSeverity] ?? 1;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { outcome: "not-started", canExit: false, capReached: false, residual: [], rationale: "no rounds recorded" };
  }
  const last = rounds[rounds.length - 1];
  const lastFindings = findingsOfRound(last);
  const productFindings = lastFindings.filter((finding) => finding.operation === "PRD-draft");
  if (productFindings.length > 0) {
    return {
      outcome: "escalated",
      canExit: false,
      capReached: rounds.length >= maxRounds,
      residual: [],
      productFindings: productFindings.map((finding) => finding.id),
      rationale: `product-level finding(s) ${productFindings.map((finding) => finding.id).join(", ")} require a PRD revision draft; loop suspended pending human approval`,
    };
  }

  const newBlocking = blocking(lastFindings, blockRank);
  const previous = rounds.length >= 2 ? rounds[rounds.length - 2] : null;
  const resolved = resolvedKeys(last);
  let previousFindingsCount = 0;
  let previousAllResolved = true;
  (previous?.reviews ?? []).forEach((review, reviewIndex) => {
    for (const finding of review.findings ?? []) {
      previousFindingsCount += 1;
      if (!resolved.has(verdictKey(reviewIndex, finding.id))) previousAllResolved = false;
    }
  });

  if (previousAllResolved && newBlocking.length === 0) {
    return {
      outcome: "converged",
      canExit: true,
      capReached: rounds.length >= maxRounds,
      residual: [],
      rationale: previousFindingsCount === 0
        ? `round ${last.n} introduced no blocking findings`
        : `all ${previousFindingsCount} finding(s) of round ${previous.n} voted resolved and round ${last.n} introduced no blocking findings`,
    };
  }

  const lastImprovement = roundImprovement(rounds, rounds.length - 1, blockRank);
  const priorImprovement = rounds.length >= 3 ? roundImprovement(rounds, rounds.length - 2, blockRank) : null;
  const stalledTwice = rounds.length >= 3 && lastImprovement?.improved === false && priorImprovement?.improved === false;
  if (stalledTwice) {
    return {
      outcome: "plateau",
      canExit: true,
      capReached: rounds.length >= maxRounds,
      residual: residualFindings(rounds, blockRank),
      rationale: `rounds ${rounds[rounds.length - 2].n} and ${last.n} both made no measurable improvement; exiting with the residual list`,
    };
  }

  return {
    outcome: "ongoing",
    canExit: false,
    capReached: rounds.length >= maxRounds,
    residual: residualFindings(rounds, blockRank),
    rationale: previousFindingsCount === 0
      ? `round ${last.n} introduced ${newBlocking.length} blocking finding(s); next round reviews them`
      : `round ${last.n} still has unresolved or new blocking findings`,
  };
}

/**
 * Findings never voted resolved by any later round (matched by review
 * position + finding id, so identical bare ids across personas stay
 * distinct).
 */
export function residualFindings(rounds, blockRank = SEVERITY_RANK.low) {
  const resolved = new Set();
  for (const round of rounds) {
    for (const key of resolvedKeys(round)) resolved.add(key);
  }
  const residual = [];
  const seen = new Set();
  for (const round of rounds) {
    (round.reviews ?? []).forEach((review, reviewIndex) => {
      for (const finding of review.findings ?? []) {
        const key = verdictKey(reviewIndex, finding.id);
        if (resolved.has(key) || seen.has(key)) continue;
        seen.add(key);
        residual.push({
          id: `${review.persona ?? `review-${reviewIndex}`}:${finding.id}`,
          round: round.n,
          severity: finding.severity,
          dimension: finding.dimension,
          comment: finding.comment,
          operation: finding.operation,
          evidence: finding.evidence ?? "",
          frameAddress: finding.frameAddress ?? null,
        });
      }
    });
  }
  return residual;
}

// ---- artifact I/O ------------------------------------------------------------

export function sessionsDirPath(cwd) {
  return path.resolve(cwd, SESSIONS_DIR);
}

export function deckSessionsDir(cwd, deckId) {
  return path.join(sessionsDirPath(cwd), deckId);
}

export function sessionFiles(cwd, deckId) {
  const dir = deckSessionsDir(cwd, deckId);
  if (!fsSync.existsSync(dir)) return [];
  return fsSync.readdirSync(dir)
    .filter((name) => /^session-\d+\.json$/.test(name))
    .sort();
}

export function latestSessionPath(cwd, deckId) {
  const files = sessionFiles(cwd, deckId);
  return files.length ? path.join(deckSessionsDir(cwd, deckId), files[files.length - 1]) : null;
}

export function readSession(sessionPath) {
  const raw = JSON.parse(fsSync.readFileSync(sessionPath, "utf8"));
  const errors = validateSessionArtifact(raw);
  if (!errors.ok) {
    throw Object.assign(new Error(`invalid session artifact ${sessionPath}: ${errors.errors.join("; ")}`), { code: "invalid-session" });
  }
  return raw;
}

export function validateSessionArtifact(session) {
  const errors = [];
  if (!session || typeof session !== "object" || Array.isArray(session)) return { ok: false, errors: ["session must be an object"] };
  if (session.schema !== SESSION_SCHEMA) errors.push(`schema must be ${SESSION_SCHEMA}`);
  if (typeof session.deck !== "string" || session.deck === "") errors.push("deck must be a non-empty string");
  if (!Array.isArray(session.packHashes)) errors.push("packHashes must be an array");
  if (!Array.isArray(session.rounds)) errors.push("rounds must be an array");
  session.rounds?.forEach((round, index) => {
    if (!round || typeof round !== "object") {
      errors.push(`rounds[${index}] must be an object`);
      return;
    }
    if (!Number.isInteger(round.n) || round.n < 1) errors.push(`rounds[${index}].n must be a positive integer`);
    if (!Array.isArray(round.reviews)) errors.push(`rounds[${index}].reviews must be an array`);
    if (round.improvements !== undefined && !Array.isArray(round.improvements)) errors.push(`rounds[${index}].improvements must be an array when present`);
  });
  return { ok: errors.length === 0, errors };
}

export function nextSessionPath(cwd, deckId) {
  const files = sessionFiles(cwd, deckId);
  const next = files.length + 1;
  return path.join(deckSessionsDir(cwd, deckId), `session-${String(next).padStart(3, "0")}.json`);
}

export function writeSession(cwd, deckId, session) {
  const sessionPath = nextSessionPath(cwd, deckId);
  fsSync.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fsSync.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return sessionPath;
}
