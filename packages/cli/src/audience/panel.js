// AI audience v1.2 — the "观众席" (audience seats) panel data for the scoped
// video workbench (PRD M11 §挂载). Deterministic read-only aggregation of the
// deck's recorded rehearsal sessions (.lattice/audience-sessions/<deck>/):
// session history, current (residual) findings, verdict status, and the
// per-round score curve. Pure library code over the session artifacts — the
// workbench route serves it as JSON with the API's no-store discipline, and
// the deck scope is enforced by the caller (one deck id per route hit).

import path from "node:path";
import {
  deckSessionsDir,
  evaluateConvergence,
  findingsOfRound,
  readSession,
  residualFindings,
  roundImprovement,
  sessionFiles,
  verdictsOfRound,
} from "./session.js";

export const AUDIENCE_PANEL_SCHEMA = "lattice.audience-panel.v1";

/** Latest-round findings with persona attribution (what the panel lists). */
function findingsSummary(round) {
  return (round?.reviews ?? []).map((review, reviewIndex) => ({
    persona: review.persona ?? `review-${reviewIndex}`,
    findings: (review.findings ?? []).map((finding) => ({
      id: `${review.persona ?? `review-${reviewIndex}`}:${finding.id}`,
      frameAddress: finding.frameAddress ?? null,
      dimension: finding.dimension,
      severity: finding.severity,
      evidence: finding.evidence ?? "",
      comment: finding.comment,
      operation: finding.operation,
    })),
    scores: review.scores ?? null,
  }));
}

function summarizeSession(cwd, deckId, fileName) {
  const sessionPath = path.join(deckSessionsDir(cwd, deckId), fileName);
  let session;
  try {
    session = readSession(sessionPath);
  } catch {
    // Unreadable artifacts are skipped: the panel is a convenience surface,
    // never a validation authority (same stance as the portal review view).
    return null;
  }
  const rounds = session.rounds.map((round, index) => {
    const verdicts = verdictsOfRound(round);
    return {
      n: round.n,
      ...(round.packHash ? { packHash: round.packHash } : {}),
      findingsCount: findingsOfRound(round).length,
      verdicts: {
        total: verdicts.length,
        resolved: verdicts.filter((verdict) => verdict.resolved === true).length,
        persists: verdicts.filter((verdict) => verdict.resolved === false).length,
      },
      improvements: (round.improvements ?? []).length,
      improvement: roundImprovement(session.rounds, index),
      reviews: findingsSummary(round),
    };
  });
  return {
    file: `.lattice/audience-sessions/${deckId}/${fileName}`,
    packHashes: session.packHashes ?? [],
    rounds,
    convergence: evaluateConvergence(session.rounds),
    residual: residualFindings(session.rounds),
    conclusion: session.conclusion ?? null,
  };
}

/**
 * Build the audience panel payload for one deck: every recorded session
 * (newest first) with rounds, residual findings, verdict status, and scores.
 * Returns the empty-but-valid shape when the deck has no sessions yet.
 */
export function buildAudiencePanelData(cwd, deckId) {
  const files = sessionFiles(cwd, deckId).reverse(); // newest first
  const sessions = files
    .map((fileName) => summarizeSession(cwd, deckId, fileName))
    .filter(Boolean);
  return {
    schema: AUDIENCE_PANEL_SCHEMA,
    deck: deckId,
    sessions,
    latest: sessions[0] ?? null,
  };
}
