// PUBLIC COPY for the review-coverage CI action. Canonical runtime copy lives in
// HarperFast/dispatch dispatch/lib/reviewGate.mjs (the server gate imports it) — keep
// these byte-identical below this header block.
// Human-review gate decision logic. Policy of record: skills/pr-shepherd/SKILL.md,
// "Human-review gate". Plain .mjs so shepherd/sync.mjs can import it under plain node.

// Coverage counts FAMILIES, not model names: "codex + gpt-5" is one reviewer twice.
const FAMILIES = [
	[/\b(?:codex|gpt-?\d[\w.-]*|o[34](?:-mini)?|openai)\b/i, 'openai'],
	[/\bgemini\b/i, 'google'],
	[/\b(?:grok|xai)\b/i, 'xai'],
	[/\b(?:claude|opus|sonnet|haiku|fable|anthropic)\b/i, 'anthropic'],
	[/\b(?:composer|cursor)\b/i, 'cursor'],
	[/\bqwen\b/i, 'qwen'],
	[/\bdeepseek\b/i, 'deepseek'],
	[/\bkimi\b/i, 'kimi'],
	[/\bglm\b/i, 'glm'],
	[/\bmistral\b/i, 'mistral'],
	[/\bllama\b/i, 'meta'],
];

const familiesIn = (text) => FAMILIES.filter(([re]) => re.test(text)).map(([, fam]) => fam);

// A segment that names a model but says the leg did NOT produce a review must not count.
// Scoped to comma/semicolon segments, not whole lines: "- Codex: clean, Gemini: failed"
// must count codex. "none" is deliberately absent ("- Gemini: none found." RAN), and
// "error(s)" negates only when not itself negated ("no errors found" also RAN).
const NEGATED =
	/\bfail(?:ed|ure)?\b|\bdid n[o']t run\b|\bskipped\b|\bunavailable\b|\bno usable output\b|\btimed? ?out\b|(?<!\bno )(?<!\bzero )(?<!\bwithout )\berrors?\b|\berrored\b|\bnot run\b|\bpending\b/i;

/** The model family that authored the change itself, when the body declares it (agent PRs
 *  end with a generated-by marker; HEG's Review coverage names the generating model). A
 *  self-family review is not cross-model, so it never counts toward coverage. */
export function generatorFamily(body) {
	for (const line of String(body ?? '').split('\n')) {
		if (!/generated (?:with|by)|generating model/i.test(line)) continue;
		const fams = familiesIn(line);
		if (fams.length === 1) return fams[0];
	}
	return '';
}

/** Count the DISTINCT outside-model review families the PR description reports as having
 *  run. The failure direction is asymmetric: an undercount GATES a compliant PR (the gate
 *  fires on count < 2), so negation filtering stays narrow and anything phrased per the
 *  conventions below must parse. Free-prose interpretation is not attempted — the remedy
 *  for unrecognized phrasing is the `## Review coverage` convention the gate's preamble
 *  teaches, and a wrongly-gated PR self-heals through the recheck once adopted.
 *
 *  Scanned surfaces:
 *   - the `## Review coverage` section (harper-engineering-guidelines step 14)
 *   - `independent-review: <reviewer> — ...` lines (dev-agent step 5)
 *   - lines mentioning "cross-model" alongside model names
 *  Lines reporting a failed/skipped leg are ignored, as is the generating model's family. */
export function reportedCrossModelReviews(body) {
	const text = String(body ?? '');
	const own = generatorFamily(text);
	const families = new Set();
	const harvest = (line) => {
		// "No cross-model review was run (codex, gemini unavailable)" negates the whole
		// line; per-segment negation handles mixed lines like "Codex: clean, Gemini: failed"
		if (/\bno\b[^.]*\bcross[- ]model|\bwithout\b[^.]*\bcross[- ]model/i.test(line)) return;
		for (const seg of String(line).split(/[,;·|]/)) {
			if (NEGATED.test(seg)) continue;
			for (const fam of familiesIn(seg)) if (fam !== own) families.add(fam);
		}
	};

	const lines = text.split('\n');
	let inCoverage = false;
	let coverageLevel = 0;
	for (const line of lines) {
		const heading = line.match(/^(#{1,4})\s+(.*)/);
		if (heading) {
			if (inCoverage && heading[1].length <= coverageLevel) inCoverage = false;
			if (/review coverage/i.test(heading[2])) {
				inCoverage = true;
				coverageLevel = heading[1].length;
				continue;
			}
		}
		if (inCoverage) harvest(line);
		else if (/^\s*(?:[-*>]\s*)?independent-review\s*:/i.test(line)) harvest(line);
		else if (/cross[- ]model/i.test(line)) harvest(line);
	}
	return { count: families.size, families: [...families].sort(), generator: own };
}

/** "Found findings" per the policy. LGTM (or an unparseable verdict — fail open) is clean;
 *  CHANGES/BLOCK always count; COMMENT(S) counts only when the review anchored at least one
 *  finding — a comments-verdict with nothing to anchor fails open to human review. */
export function reviewHasFindings(verdict, comments) {
	const v = String(verdict ?? '').toUpperCase();
	if (!v || v === 'LGTM') return false;
	if (v === 'CHANGES' || v === 'BLOCK') return true;
	return Array.isArray(comments) && comments.length > 0;
}

/** The gate's triviality exemption: up to 2 changed lines, so a one-line EDIT (1 add +
 *  1 del) is exempt along with pure one-liners. Wider than HEG's literal "more than one
 *  line", deliberately — the failure direction is human review, not a block. */
export function isTrivialChange(additions, deletions) {
	return (Number(additions) || 0) + (Number(deletions) || 0) <= 2;
}

export const COVERAGE_REQUIRED = 2;

/** The whole decision, given everything already fetched. Returns { gate, why, coverage }.
 *  Order mirrors the policy: clean review → no gate; non-member author → no gate (always
 *  human review); trivial → no gate; otherwise gate iff reported coverage < 2. */
export function evaluateReviewGate({
	verdict,
	comments,
	author,
	user,
	isDraft,
	isMember,
	prBody,
	additions,
	deletions,
}) {
	const a = String(author ?? '');
	if (isDraft || !a || a.toLowerCase() === String(user ?? '').toLowerCase())
		return { gate: false, why: 'self-review / own PR', coverage: -1 };
	if (/\[bot\]$|^app\//.test(a)) return { gate: false, why: 'bot author', coverage: -1 };
	if (!reviewHasFindings(verdict, comments)) return { gate: false, why: 'clean review', coverage: -1 };
	if (!isMember) return { gate: false, why: 'author is not an org member — always human review', coverage: -1 };
	if (isTrivialChange(additions, deletions)) return { gate: false, why: 'trivial change', coverage: -1 };
	const { count, families } = reportedCrossModelReviews(prBody);
	if (count >= COVERAGE_REQUIRED)
		return { gate: false, why: `coverage reported (${families.join(', ')})`, coverage: count };
	return { gate: true, why: `findings + ${count}/${COVERAGE_REQUIRED} cross-model reviews reported`, coverage: count };
}

// The marker is the durable dedupe key: recognising our own gate reviews on GitHub is what
// keeps submission idempotent when local state is lost mid-write.
export const GATE_MARKER_PREFIX = '<!-- dispatch-review-gate';
export const gateMarker = (sha) => `${GATE_MARKER_PREFIX} @ ${String(sha ?? '').slice(0, 12)} -->`;
export const hasGateMarker = (body, sha = '') =>
	String(body ?? '').includes(sha ? gateMarker(sha) : GATE_MARKER_PREFIX);

/** The auto-draft pending review's body, as runReviewTask parks it. ONE definition: the
 *  worker uses it to park, and the gate uses it to recognise an UNEDITED parked draft as
 *  its own before daring to submit it (any mismatch = a human touched it = decline). */
export function autoDraftSummary(reviewBody, agent, verdict) {
	return (
		(String(reviewBody ?? '').match(/TL;DR[:\s]*([\s\S]{0,700}?)(?=\n\n|\n#)/i) || [])[1]?.trim() ||
		`Dispatch ${agent} review (verdict ${verdict || '?'}).`
	);
}
export const autoDraftBody = (reviewBody, agent, verdict) => `🤖 ${autoDraftSummary(reviewBody, agent, verdict)}`;

/** The submitted REQUEST_CHANGES body: gating preamble, then the review itself. */
export function gateReviewBody({ reviewBody, agent, headSha, coverage }) {
	const preamble = [
		'**Automated gate — not yet queued for human review.**',
		'',
		`This PR's AI review found issues, and the PR description reports ${coverage === 1 ? 'only one cross-model review' : 'no cross-model reviews'}.`,
		`Per team policy, a substantive PR with AI-review findings is queued for human review only after at least ${COVERAGE_REQUIRED} cross-model reviews have been run, their findings addressed, and the coverage reported in the PR description (\`## Review coverage\` naming each model — see harper-engineering-guidelines).`,
		'The findings below count as one of the two: address them, run a second outside-model review, update the description, and the gate lifts automatically on the next pass.',
		'',
		'---',
		'',
	].join('\n');
	const signature = `\n\n— ${agent || 'fleet'} review, submitted by the dispatch review gate\n${gateMarker(headSha)}`;
	return preamble + String(reviewBody ?? '').trim() + signature;
}
