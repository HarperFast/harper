import assert from 'node:assert';
import test from 'node:test';

import {
	autoDraftBody,
	autoDraftSummary,
	evaluateReviewGate,
	gateMarker,
	gateReviewBody,
	generatorFamily,
	hasGateMarker,
	isTrivialChange,
	reportedCrossModelReviews,
	reviewHasFindings,
	COVERAGE_REQUIRED,
	structuredCoverage,
} from './reviewGate.mjs';

// ---- coverage parsing ----

test('a Review coverage section counts distinct families', () => {
	const body = [
		'Fixes the thing.',
		'## Review coverage',
		'- Codex (gpt-5): 3 findings, all addressed',
		'- Gemini: 1 finding, by-design',
		'## Verification',
		'- unit tests',
	].join('\n');
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.count, 2);
	assert.deepStrictEqual(r.families, ['google', 'openai']);
});

test('same family twice is one reviewer', () => {
	const body = '## Review coverage\n- codex round 1\n- gpt-5 round 2 (delta)';
	assert.strictEqual(reportedCrossModelReviews(body).count, 1);
});

test('a failed leg does not count', () => {
	const body = '## Review coverage\n- Codex: 2 findings fixed\n- Gemini: FAILED — auth error';
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.count, 1);
	assert.deepStrictEqual(r.families, ['openai']);
});

test('a leg that ran with zero findings counts — "none found" is not a negation', () => {
	const body = '## Review coverage\n- Codex: 2 findings, fixed\n- Gemini: none found.';
	assert.strictEqual(reportedCrossModelReviews(body).count, 2);
});

test('negation is segment-scoped: a mixed line counts the leg that ran', () => {
	const body = '## Review coverage\n- Codex: clean, Gemini: failed';
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.count, 1);
	assert.deepStrictEqual(r.families, ['openai']);
	assert.strictEqual(reportedCrossModelReviews('## Review coverage\n- Gemini: error').count, 0);
	assert.strictEqual(
		reportedCrossModelReviews('## Review coverage\n- Gemini: no errors found.').count,
		1,
		'"no errors found" is a leg that RAN clean'
	);
});

test('an h1 Review coverage heading parses too', () => {
	assert.strictEqual(reportedCrossModelReviews('# Review coverage\n- Codex ran\n- Gemini ran').count, 2);
});

test('the section ends at the next same-level heading', () => {
	const body = '## Review coverage\n- Codex ran\n## Notes\nGemini is mentioned here but not as coverage';
	assert.strictEqual(reportedCrossModelReviews(body).count, 1);
});

test('ordinary prose after the final coverage section does not count', () => {
	const body = '## Review coverage\n- Codex ran\n\nCross-model telemetry also touches the grok path.';
	const result = reportedCrossModelReviews(body);
	assert.strictEqual(result.count, 1);
	assert.deepStrictEqual(result.families, ['openai']);
});

test('independent-review lines count outside a coverage section', () => {
	const body = 'independent-review: codex — 4 findings, 4 fixed, 0 open';
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.count, 1);
	assert.deepStrictEqual(r.families, ['openai']);
});

test('a failed independent-review line does not count', () => {
	assert.strictEqual(reportedCrossModelReviews('independent-review: FAILED — prepush-review.mjs unavailable').count, 0);
});

test('cross-model prose lines count, negated ones do not', () => {
	assert.strictEqual(reportedCrossModelReviews('Cross-model reviews: Codex and Gemini, both clean.').count, 2);
	assert.strictEqual(reportedCrossModelReviews('No cross-model review was run (codex, gemini unavailable).').count, 0);
});

test('model names in ordinary prose do not count', () => {
	const body = 'This PR migrates our Gemini API client and adds Codex-style completions.';
	assert.strictEqual(reportedCrossModelReviews(body).count, 0);
});

test('the generating model family is excluded from coverage', () => {
	const body = [
		'## Review coverage',
		'- Claude Opus (generating model): self-review',
		'- Codex: 2 findings',
		'',
		'🤖 Generated with [Claude Code](https://claude.com/claude-code)',
	].join('\n');
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.generator, 'anthropic');
	assert.strictEqual(r.count, 1);
	assert.deepStrictEqual(r.families, ['openai']);
});

test('generatorFamily stays empty when a line names several models', () => {
	assert.strictEqual(generatorFamily('Generated with Claude and reviewed by Codex'), '');
	assert.strictEqual(generatorFamily('🤖 Generated with [Claude Code](x)'), 'anthropic');
	assert.strictEqual(generatorFamily('no marker here'), '');
});

// ---- findings / triviality ----

test('reviewHasFindings maps verdicts per policy', () => {
	assert.strictEqual(reviewHasFindings('LGTM', []), false);
	assert.strictEqual(reviewHasFindings('', [{}]), false); // unparseable verdict fails open
	assert.strictEqual(reviewHasFindings('CHANGES', []), true);
	assert.strictEqual(reviewHasFindings('BLOCK', []), true);
	assert.strictEqual(reviewHasFindings('COMMENTS', []), false); // comments verdict with nothing anchored
	assert.strictEqual(reviewHasFindings('COMMENTS', [{ path: 'a', body: 'b' }]), true);
});

test('isTrivialChange is the one-line threshold', () => {
	assert.strictEqual(isTrivialChange(1, 1), true);
	assert.strictEqual(isTrivialChange(2, 0), true);
	assert.strictEqual(isTrivialChange(2, 1), false);
	assert.strictEqual(isTrivialChange(0, 0), true);
});

// ---- the whole decision ----

const base = {
	verdict: 'CHANGES',
	comments: [{ path: 'x', body: 'y' }],
	author: 'someone',
	user: 'kriszyp',
	isDraft: false,
	isMember: true,
	prBody: 'plain description',
	additions: 40,
	deletions: 12,
};

test('findings + member + no reported coverage → gate', () => {
	const d = evaluateReviewGate(base);
	assert.strictEqual(d.gate, true);
	assert.strictEqual(d.coverage, 0);
});

test('clean review never gates, regardless of coverage', () => {
	assert.strictEqual(evaluateReviewGate({ ...base, verdict: 'LGTM' }).gate, false);
});

test('non-member author never gates', () => {
	assert.strictEqual(evaluateReviewGate({ ...base, isMember: false }).gate, false);
});

test('bot author never gates', () => {
	assert.strictEqual(evaluateReviewGate({ ...base, author: 'renovate[bot]' }).gate, false);
	assert.strictEqual(evaluateReviewGate({ ...base, author: 'app/dependabot' }).gate, false);
});

test('own PR / self-review never gates', () => {
	assert.strictEqual(evaluateReviewGate({ ...base, author: 'KrisZyp' }).gate, false);
	assert.strictEqual(evaluateReviewGate({ ...base, isDraft: true }).gate, false);
});

test('trivial change never gates', () => {
	assert.strictEqual(evaluateReviewGate({ ...base, additions: 1, deletions: 1 }).gate, false);
});

test('two reported cross-model reviews lift the gate', () => {
	const prBody = '## Review coverage\n- Codex: clean\n- Gemini: 1 finding, fixed';
	const d = evaluateReviewGate({ ...base, prBody });
	assert.strictEqual(d.gate, false);
	assert.strictEqual(d.coverage, 2);
});

test('one reported review still gates', () => {
	const prBody = '## Review coverage\n- Codex: clean';
	const d = evaluateReviewGate({ ...base, prBody });
	assert.strictEqual(d.gate, true);
	assert.strictEqual(d.coverage, 1);
});

// ---- gate review body / marker ----

test('gate body carries preamble, review, signature, and marker', () => {
	const body = gateReviewBody({
		reviewBody: 'verdict: CHANGES\nfindings...',
		agent: 'codex',
		headSha: 'abcdef1234567890',
		coverage: 1,
	});
	assert.ok(body.startsWith('**Automated gate'));
	assert.ok(body.includes('only one cross-model review'));
	assert.ok(body.includes('verdict: CHANGES'));
	assert.ok(body.includes('— codex review, submitted by the dispatch review gate'));
	assert.ok(hasGateMarker(body));
	assert.ok(body.includes(gateMarker('abcdef1234567890')));
});

test('marker detection ignores unrelated bodies and matches per-head when asked', () => {
	assert.strictEqual(hasGateMarker('a normal review body'), false);
	const body = `x\n${gateMarker('abcdef1234567890')}`;
	assert.strictEqual(hasGateMarker(body), true);
	assert.strictEqual(hasGateMarker(body, 'abcdef1234567890'), true);
	assert.strictEqual(hasGateMarker(body, '9999999999999999'), false);
});

test('autoDraftBody mirrors the worker park body from TL;DR or the fallback', () => {
	assert.strictEqual(autoDraftSummary('## TL;DR: fixes the wedge\n\nrest', 'codex', 'CHANGES'), 'fixes the wedge');
	assert.strictEqual(autoDraftBody('no tldr here', 'codex', 'CHANGES'), '🤖 Dispatch codex review (verdict CHANGES).');
	assert.strictEqual(autoDraftBody('no tldr here', 'agy', ''), '🤖 Dispatch agy review (verdict ?).');
});

const FIELD = (segments) => `<sub>Review-Coverage: ${segments}</sub>`;

test('the structured Review-Coverage field is preferred over prose, and counts only ran=', () => {
	const body = ['## Summary', 'A fix.', '', 'Complexity: medium', '',
		FIELD('authored=claude; ran=codex,gemini; adjudicated=domain; blocked=cursor-grok(auth); declined=cursor-composer; rounds=2 @ abcdef123456'),
		'', '<sub>Human-Review-Need: 3 @ abcdef123456</sub>', '',
		'🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\n');
	const r = reportedCrossModelReviews(body);
	assert.strictEqual(r.count, 2);
	assert.deepStrictEqual(r.families, ['google', 'openai']);
	assert.strictEqual(r.rounds, 2);
	assert.strictEqual(r.structured, true);
	// This is the regression that made the field necessary to teach here at all: with only the
	// prose reader, a description carrying the new footer and NO `## Review coverage` section
	// counted 0 and warned as under-reported on every compliant PR.
	assert.ok(r.count >= COVERAGE_REQUIRED);
});

test('a blocked or declined lens is never counted as coverage', () => {
	assert.strictEqual(reportedCrossModelReviews(FIELD('authored=claude; ran=none; blocked=codex(auth),gemini(not-installed); rounds=1')).count, 0);
	assert.strictEqual(reportedCrossModelReviews(FIELD('authored=claude; ran=none; declined=cursor-grok,cursor-composer; rounds=1')).count, 0);
	// ran=none is an explicit report of zero outside coverage, not a missing field.
	assert.strictEqual(structuredCoverage(FIELD('authored=claude; ran=none; rounds=1')).count, 0);
	assert.strictEqual(structuredCoverage('## Summary\nno field here'), null);
});

test('one Cursor leg is one family, not two', () => {
	// familiesIn('cursor-grok') matches BOTH /grok|xai/ -> xai and /composer|cursor/ -> cursor, so
	// reusing the prose matcher would report 2 families for a single leg and inflate the count the
	// gate acts on. The structured path maps leg names through a table for exactly this reason.
	const r = structuredCoverage(FIELD('authored=claude; ran=cursor-grok; rounds=1'));
	assert.deepStrictEqual(r.families, ['xai']);
	assert.strictEqual(r.count, 1);
	assert.deepStrictEqual(structuredCoverage(FIELD('authored=claude; ran=cursor-grok,cursor-composer; rounds=1')).families, ['cursor', 'xai']);
});

test('the authoring family never counts, and the adjudicator is excluded by the producer', () => {
	// domain is the Harper adjudicator and is Claude by construction; it is reported under
	// adjudicated=, never ran=, so a Claude-authored PR cannot reach 2 on its own legs.
	const r = structuredCoverage(FIELD('authored=claude; ran=codex; adjudicated=domain; rounds=1'));
	assert.deepStrictEqual(r.families, ['openai']);
	// Defense in depth: an anthropic leg wrongly placed in ran= by a future producer is dropped.
	assert.deepStrictEqual(structuredCoverage(FIELD('authored=claude; ran=codex,claude; rounds=1')).families, ['openai']);
	// A codex-authored change gets its Claude leg back as genuine outside coverage.
	assert.deepStrictEqual(structuredCoverage(FIELD('authored=codex; ran=claude,gemini; rounds=1')).families, ['anthropic', 'google']);
});

test('a fenced example of the field cannot satisfy the gate', () => {
	const body = ['## Summary', 'Documents the field:', '```',
		'Review-Coverage: authored=claude; ran=codex,gemini; rounds=9', '```', '',
		'🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\n');
	assert.strictEqual(structuredCoverage(body), null);
	// Falls through to the prose reader, which finds no coverage section either.
	assert.strictEqual(reportedCrossModelReviews(body).count, 0);
});
