import assert from 'node:assert';
import test from 'node:test';

import { evaluateCiCoverage } from './evaluateCiCoverage.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const AI_MARK = '\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)';
const base = (over = {}) => ({
	user: { login: 'someone', type: 'User' },
	author_association: 'MEMBER',
	body: 'plain description',
	additions: 40,
	deletions: 12,
	draft: false,
	changed_files: 3,
	head: { sha: HEAD },
	...over,
});
const pr = (over = {}) => {
	const built = base(over);
	return { ...built, body: `${built.body}${AI_MARK}` };
};
const human = base; // the same PR without a generator signature
// Enforcement counts the receipt-derived footer only; prose is reported, never enforced.
const covered = (ran, authored = 'claude') =>
	`<sub>Review-Coverage: authored=${authored}; ran=${ran}; rounds=1 @ ${HEAD.slice(0, 12)}</sub>`;

test('report mode is always green, but says what is missing', () => {
	const r = evaluateCiCoverage(pr());
	assert.strictEqual(r.pass, true);
	assert.strictEqual(r.compliant, false);
	assert.match(r.summary, /0 cross-model reviews reported/);
});

test('enforce mode fails a member non-trivial PR reporting under the threshold', () => {
	assert.strictEqual(evaluateCiCoverage(pr(), { mode: 'enforce' }).pass, false);
	const one = pr({ body: covered('codex') });
	assert.strictEqual(evaluateCiCoverage(one, { mode: 'enforce' }).pass, false);
	const two = pr({ body: covered('codex,gemini') });
	const r = evaluateCiCoverage(two, { mode: 'enforce' });
	assert.strictEqual(r.pass, true);
	assert.deepStrictEqual(r.families, ['google', 'openai']);
});

test('enforce mode exempts exactly what the gate exempts, plus drafts', () => {
	for (const [label, over] of [
		['bot', { user: { login: 'renovate[bot]', type: 'Bot' } }],
		['non-member', { author_association: 'CONTRIBUTOR' }],
		['collaborator', { author_association: 'COLLABORATOR' }],
		['mannequin', { author_association: 'MANNEQUIN' }],
		['trivial', { additions: 1, deletions: 1 }],
		['draft', { draft: true }],
	]) {
		const r = evaluateCiCoverage(pr(over), { mode: 'enforce' });
		assert.strictEqual(r.pass, true, `${label} must not fail enforce mode`);
		assert.ok(r.exempt, `${label} must be reported as exempt`);
	}
});

test('invalid or missing size fields are NOT trivially exempt', () => {
	const cases = [pr(), pr({ additions: null, deletions: null }), pr({ additions: '', deletions: '' })];
	delete cases[0].additions;
	delete cases[0].deletions;
	for (const candidate of cases) {
		const r = evaluateCiCoverage(candidate, { mode: 'enforce' });
		assert.strictEqual(r.pass, false, 'invalid additions/deletions must not read as a ≤2-line change');
	}
});

test('a missing or unknown author association does not exempt the PR', () => {
	const missing = pr();
	delete missing.author_association;
	assert.strictEqual(evaluateCiCoverage(missing, { mode: 'enforce' }).pass, false);
	assert.strictEqual(evaluateCiCoverage(pr({ author_association: 'UNKNOWN' }), { mode: 'enforce' }).pass, false);
});

test('the footer note distinguishes current, stale, and absent', () => {
	const at = (sha, score = 2) => pr({ body: `x\n<sub>Human-Review-Need: ${score} @ ${sha}</sub>` });
	assert.match(evaluateCiCoverage(at(HEAD.slice(0, 12))).detail, /Human-Review-Need: 2 @ head/);
	assert.match(evaluateCiCoverage(at(HEAD.slice(0, 12).toUpperCase())).detail, /Human-Review-Need: 2 @ head/);
	assert.match(evaluateCiCoverage(at(HEAD.slice(0, 12), 12)).detail, /Need: 12 @ head/);
	assert.match(evaluateCiCoverage(at('999999999999')).detail, /footer is stale/);
	assert.match(evaluateCiCoverage(pr({ body: 'Human-Review-Need: 3' })).detail, /Need: 3 @ unpinned sha/);
	assert.match(
		evaluateCiCoverage(pr({ body: `Human-Review-Need: 2 @ 999999999999\nHuman-Review-Need: 4 @ ${HEAD.slice(0, 12)}` }))
			.detail,
		/Need: 4 @ head/
	);
	assert.match(
		evaluateCiCoverage(pr({ body: `Human-Review-Need: 1 Human-Review-Need: 2 @ ${HEAD.slice(0, 12)}` })).detail,
		/Need: 2 @ head/
	);
	assert.match(evaluateCiCoverage(pr()).detail, /no Human-Review-Need footer/);
});

test('prose coverage is reported but never enforceable', () => {
	const prose = pr({ body: '## Review coverage\n- Codex: clean\n- Gemini: clean' });
	assert.strictEqual(evaluateCiCoverage(prose).count, 2, 'still counted in the report');
	const enforced = evaluateCiCoverage(prose, { mode: 'enforce' });
	assert.strictEqual(enforced.pass, false);
	assert.match(enforced.detail, /coverage is prose-only/);
});

test('a fenced example of a coverage section cannot satisfy the gate', () => {
	// A PR documenting this convention was counting its own example as two families.
	const body = [
		'Documenting the field:',
		'',
		'```',
		'## Review coverage',
		'- Codex: clean',
		'- Gemini: clean',
		'```',
		'',
		covered('codex'),
	].join('\n');
	const r = evaluateCiCoverage(pr({ body }), { mode: 'enforce' });
	assert.strictEqual(r.count, 1, 'the fenced example contributes nothing');
	assert.strictEqual(r.pass, false);
});

test('required is tunable', () => {
	const one = pr({ body: covered('codex') });
	assert.strictEqual(evaluateCiCoverage(one, { mode: 'enforce', required: 1 }).pass, true);
	const two = pr({ body: covered('codex,gemini') });
	const result = evaluateCiCoverage(two, { mode: 'enforce', required: 3 });
	assert.strictEqual(result.pass, false);
	assert.match(result.summary, /^2 cross-model reviews reported .*policy asks for 3$/);
});

test('enforcement targets AI-authored PRs, detected by field or by generator signature', () => {
	assert.strictEqual(evaluateCiCoverage(human(), { mode: 'enforce' }).pass, true, 'a human PR is reported, not gated');
	assert.match(evaluateCiCoverage(human(), { mode: 'enforce' }).exempt, /not AI-authored/);
	for (const body of [
		'x\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)',
		'x\n\nGenerated by Codex',
		'x\n<sub>Review-Coverage: authored=claude; ran=none; rounds=1 @ abcdef123456</sub>',
		'x\nComplexity: medium',
		'x\n<sub>Human-Review-Need: 3 @ abcdef123456</sub>',
	]) {
		const r = evaluateCiCoverage(human({ body }), { mode: 'enforce' });
		assert.strictEqual(r.aiAuthored, true, `should read as AI-authored: ${body}`);
		assert.strictEqual(r.pass, false, `should be gated: ${body}`);
	}
});

test('a fenced example of the markers does not make a PR AI-authored', () => {
	const body = ['Documenting the footer:', '', '```', 'Complexity: easy', 'Generated with Claude Code', '```'].join(
		'\n'
	);
	assert.strictEqual(evaluateCiCoverage(human({ body }), { mode: 'enforce' }).aiAuthored, false);
});

test('Complexity: easy waives the second leg on a small diff, but only with one leg reported', () => {
	const easy = (over) => pr({ body: `${covered('codex')}\n\nComplexity: easy`, ...over });
	const waived = evaluateCiCoverage(easy(), { mode: 'enforce' });
	assert.strictEqual(waived.pass, true);
	assert.match(waived.exempt, /Complexity: easy on a 52-line diff/);

	const none = pr({ body: 'no reviews at all\n\nComplexity: easy' });
	assert.strictEqual(
		evaluateCiCoverage(none, { mode: 'enforce' }).pass,
		false,
		'zero legs is not a narrow diff, it is no review'
	);
});

test('the easy waiver is refused when the diff contradicts the claim', () => {
	const big = pr({ body: `${covered('codex')}\n\nComplexity: easy`, additions: 800, deletions: 35 });
	const r = evaluateCiCoverage(big, { mode: 'enforce' });
	assert.strictEqual(r.pass, false);
	assert.match(r.detail, /does not waive here — 835 changed lines exceeds 150/);

	const wide = pr({ body: `${covered('codex')}\n\nComplexity: easy`, changed_files: 40 });
	assert.strictEqual(evaluateCiCoverage(wide, { mode: 'enforce' }).pass, false);

	const unsized = pr({
		body: `${covered('codex')}\n\nComplexity: easy`,
		additions: null,
		deletions: null,
	});
	assert.strictEqual(
		evaluateCiCoverage(unsized, { mode: 'enforce' }).pass,
		false,
		'an unmeasurable diff cannot corroborate easy'
	);
});

test('the manifest defaults match the evaluator constants', () => {
	const manifest = readFileSync(fileURLToPath(new URL('./action.yml', import.meta.url)), 'utf8');
	assert.match(manifest, new RegExp(`easy_max_lines:[\\s\\S]*?default: '${EASY_MAX_LINES}'`));
	assert.match(manifest, new RegExp(`easy_max_files:[\\s\\S]*?default: '${EASY_MAX_FILES}'`));
});

test('two live footers are both scored on the last one', () => {
	const stale = pr({
		body: [covered('codex,gemini'), '', 'Re-reviewed after the fix.', '', covered('codex')].join('\n'),
	});
	const staleResult = evaluateCiCoverage(stale, { mode: 'enforce' });
	assert.strictEqual(staleResult.count, 1, 'the later footer is the PR"s coverage');
	assert.strictEqual(staleResult.pass, false);
	assert.match(staleResult.summary, /policy asks for 2/);

	const fixed = pr({
		body: [covered('codex'), '', 'Re-reviewed after the fix.', '', covered('codex,gemini')].join('\n'),
	});
	const fixedResult = evaluateCiCoverage(fixed, { mode: 'enforce' });
	assert.strictEqual(fixedResult.count, 2);
	assert.strictEqual(fixedResult.pass, true);
});

test('a footer that names no authoring family cannot be counted', () => {
	// Without `authored=` the parser cannot exclude the authoring model, so `ran=claude,codex`
	// on a Claude-authored PR would score two outside families.
	const body = '<sub>Review-Coverage: ran=claude,codex; rounds=1 @ abcdef123456</sub>\nComplexity: medium';
	const r = evaluateCiCoverage(pr({ body }), { mode: 'enforce' });
	assert.strictEqual(r.pass, false);
	assert.match(r.detail, /names no `authored=` family/);
});

test('the last Complexity field wins, like the coverage footer', () => {
	// Round one graded easy, round two withdrew it; the waiver must not survive the withdrawal.
	const body = [
		covered('codex'),
		'Complexity: easy',
		'',
		'On review this is harder than it looked.',
		'',
		'Complexity: complicated',
	].join('\n');
	assert.strictEqual(evaluateCiCoverage(pr({ body }), { mode: 'enforce' }).pass, false);
});

test('an algorithmic complexity note does not make a PR AI-authored', () => {
	const body = 'Rewrites the index scan.\n\nComplexity: O(n log n) rather than O(n^2).';
	const r = evaluateCiCoverage(human({ body }), { mode: 'enforce' });
	assert.strictEqual(r.aiAuthored, false);
	assert.strictEqual(r.pass, true);
});

test('the easy waiver drops one leg, not all but one', () => {
	const easy = pr({ body: `${covered('codex')}\n\nComplexity: easy` });
	assert.strictEqual(evaluateCiCoverage(easy, { mode: 'enforce', required: 2 }).pass, true);
	assert.strictEqual(
		evaluateCiCoverage(easy, { mode: 'enforce', required: 3 }).pass,
		false,
		'required 3 still needs 2'
	);
	const two = pr({ body: `${covered('codex,gemini')}\n\nComplexity: easy` });
	assert.strictEqual(evaluateCiCoverage(two, { mode: 'enforce', required: 3 }).pass, true);
});

test('fences the format checker recognises are blanked here too', () => {
	for (const fence of ['~~~', '````']) {
		const body = ['Documenting:', '', fence, covered('codex,gemini'), fence].join('\n');
		const r = evaluateCiCoverage(human({ body }), { mode: 'enforce' });
		assert.strictEqual(r.aiAuthored, false, `${fence} block must not read as live`);
	}
	// CRLF is what GitHub's web editor writes.
	const crlf = ['Documenting:', '', '```', covered('codex,gemini'), '```'].join('\r\n');
	assert.strictEqual(evaluateCiCoverage(human({ body: crlf }), { mode: 'enforce' }).aiAuthored, false);
});

test('both easy caps fail closed on a missing measurement', () => {
	// An absent changed_files used to skip its clause entirely, so a 100-line, 60-file change waived.
	for (const files of [undefined, null, 0, 'many']) {
		const uncounted = pr({ body: `${covered('codex')}\n\nComplexity: easy`, changed_files: files });
		assert.strictEqual(
			evaluateCiCoverage(uncounted, { mode: 'enforce' }).pass,
			false,
			`changed_files=${files} must not waive`
		);
	}
});

test('the easy thresholds are tunable', () => {
	const big = pr({ body: `${covered('codex')}\n\nComplexity: easy`, additions: 300, deletions: 0 });
	assert.strictEqual(evaluateCiCoverage(big, { mode: 'enforce', easy: { maxLines: 400 } }).pass, true);
});

test('medium and complicated never waive', () => {
	for (const grade of ['medium', 'complicated', 'moderate']) {
		const p = pr({ body: `${covered('codex')}\n\nComplexity: ${grade}` });
		assert.strictEqual(evaluateCiCoverage(p, { mode: 'enforce' }).pass, false, `${grade} must not waive`);
	}
});

// ---- exit codes, through the real CLI entry ----

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizePrFiles } from './collectPrFiles.mjs';
import { EASY_MAX_FILES, EASY_MAX_LINES } from './prExemption.mjs';

const SCRIPT = fileURLToPath(new URL('./ci-review-coverage.mjs', import.meta.url));
const COLLECTOR = fileURLToPath(new URL('./collectPrFiles.mjs', import.meta.url));
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.GITHUB_ENV;
delete CLEAN_ENV.GITHUB_OUTPUT;
delete CLEAN_ENV.GITHUB_STEP_SUMMARY;
const runResult = (payload, ...args) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-'));
	const file = path.join(dir, 'event.json');
	if (payload !== null) writeFileSync(file, JSON.stringify(payload));
	try {
		return spawnSync(process.execPath, [SCRIPT, '--event', file, ...args], { encoding: 'utf8', env: CLEAN_ENV });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
const run = (payload, ...args) => runResult(payload, ...args).status ?? 1;

test('exit codes: report never reds, enforce reds on policy AND on plumbing', () => {
	const compliant = { pull_request: pr({ body: covered('codex,gemini') }) };
	const bare = { pull_request: pr() };
	assert.strictEqual(run(compliant, '--mode', 'enforce'), 0);
	assert.strictEqual(run(bare, '--mode', 'report'), 0);
	assert.strictEqual(run(bare, '--mode', 'enforce'), 1);
	assert.strictEqual(run({ nope: true }, '--mode', 'report'), 0, 'plumbing failure stays green in report mode');
	assert.strictEqual(run({ nope: true }, '--mode', 'enforce'), 1, 'enforce mode fails closed on plumbing');
	assert.strictEqual(run(bare, '--mode', 'enfroce'), 1, "a typo'd mode is loud, not silently report");
	assert.strictEqual(run(bare, '--mode', 'enforce', '--required', '0'), 0, 'zero is a valid threshold');
	const invalidReport = runResult(bare, '--mode', 'report', '--required', 'tow');
	assert.strictEqual(invalidReport.status, 0, 'report mode stays green on bad input');
	assert.match(invalidReport.stderr, /invalid required 'tow'/);
	const invalidEnforce = runResult(bare, '--mode', 'enforce', '--required', 'tow');
	assert.strictEqual(invalidEnforce.status, 1, 'enforce mode fails closed on bad input');
	assert.match(invalidEnforce.stderr, /invalid required 'tow'/);
});

test('the CLI runs through a symlinked entrypoint', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-link-'));
	const link = path.join(dir, 'ci-review-coverage.mjs');
	const file = path.join(dir, 'event.json');
	symlinkSync(SCRIPT, link);
	symlinkSync(
		fileURLToPath(new URL('./evaluateCiCoverage.mjs', import.meta.url)),
		path.join(dir, 'evaluateCiCoverage.mjs')
	);
	symlinkSync(
		fileURLToPath(new URL('./evaluatePrFormat.mjs', import.meta.url)),
		path.join(dir, 'evaluatePrFormat.mjs')
	);
	symlinkSync(COLLECTOR, path.join(dir, 'collectPrFiles.mjs'));
	symlinkSync(fileURLToPath(new URL('./prExemption.mjs', import.meta.url)), path.join(dir, 'prExemption.mjs'));
	symlinkSync(fileURLToPath(new URL('./prFormatLinks.mjs', import.meta.url)), path.join(dir, 'prFormatLinks.mjs'));
	symlinkSync(fileURLToPath(new URL('./reviewGate.mjs', import.meta.url)), path.join(dir, 'reviewGate.mjs'));
	writeFileSync(file, JSON.stringify({ pull_request: pr() }));
	try {
		const output = execFileSync(process.execPath, ['--preserve-symlinks-main', link, '--event', file], {
			encoding: 'utf8',
			env: CLEAN_ENV,
		});
		assert.match(output, /review-coverage \[report\]/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the JavaScript action uses a pinned runtime and receives action inputs', () => {
	const manifest = readFileSync(fileURLToPath(new URL('./action.yml', import.meta.url)), 'utf8');
	assert.match(manifest, /runs:\n\s+using: node24\n\s+main: ci-review-coverage\.mjs/);
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-action-'));
	const file = path.join(dir, 'event.json');
	writeFileSync(file, JSON.stringify({ pull_request: pr({ body: covered('codex,gemini') }) }));
	try {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: 'utf8',
			env: {
				...CLEAN_ENV,
				GITHUB_EVENT_PATH: file,
				INPUT_MODE: 'enforce',
				INPUT_REQUIRED: '3',
			},
		});
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /2 cross-model reviews reported .*policy asks for 3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the easy-waiver caps reach the evaluator through action inputs', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-easy-'));
	const file = path.join(dir, 'event.json');
	const body = `${covered('codex')}\n\nComplexity: easy`;
	writeFileSync(file, JSON.stringify({ pull_request: pr({ body, additions: 300, deletions: 0 }) }));
	try {
		const withEnv = (env) =>
			spawnSync(process.execPath, [SCRIPT], {
				encoding: 'utf8',
				env: { ...CLEAN_ENV, GITHUB_EVENT_PATH: file, INPUT_MODE: 'enforce', ...env },
			});
		assert.strictEqual(withEnv({}).status, 1, 'the default 150-line cap refuses a 300-line easy claim');
		assert.strictEqual(withEnv({ INPUT_EASY_MAX_LINES: '400' }).status, 0, 'a raised cap reaches the evaluator');
		// Zero disables the waiver rather than erroring.
		const off = withEnv({ INPUT_EASY_MAX_LINES: '0' });
		assert.strictEqual(off.status, 1);
		assert.doesNotMatch(off.stderr, /invalid easy-max-lines/);
		assert.match(withEnv({ INPUT_EASY_MAX_LINES: '-1' }).stderr, /invalid easy-max-lines/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('format mode off never reads a PR-files artifact', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-off-'));
	const file = path.join(dir, 'event.json');
	writeFileSync(file, JSON.stringify({ pull_request: pr() }));
	try {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: 'utf8',
			env: {
				...CLEAN_ENV,
				GITHUB_EVENT_PATH: file,
				INPUT_FORMAT_MODE: 'off',
				INPUT_PR_FILES_READY: 'true',
				INPUT_PR_FILES: path.join(dir, 'missing.json'),
			},
		});
		assert.strictEqual(result.status, 0);
		assert.doesNotMatch(result.stderr, /missing\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a superseded action run does not read or warn about PR-files evidence', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-superseded-'));
	const file = path.join(dir, 'event.json');
	writeFileSync(file, JSON.stringify({ pull_request: pr() }));
	try {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: 'utf8',
			env: {
				...CLEAN_ENV,
				GITHUB_EVENT_PATH: file,
				INPUT_FORMAT_MODE: 'enforce',
				INPUT_PR_FILES_SUPERSEDED: 'true',
				INPUT_PR_FILES_READY: 'true',
				INPUT_PR_FILES: path.join(dir, 'missing.json'),
			},
		});
		assert.strictEqual(result.status, 0);
		assert.match(result.stdout, /exempt: superseded by a newer PR head/);
		assert.doesNotMatch(result.stderr, /PR-files/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an oversized normalized PR-files artifact is bounded before parsing', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-large-'));
	const event = path.join(dir, 'event.json');
	const prFiles = path.join(dir, 'pr-files.json');
	writeFileSync(event, JSON.stringify({ pull_request: pr() }));
	writeFileSync(prFiles, Buffer.alloc(4 * 1024 * 1024 + 1));
	try {
		const execute = (formatMode) =>
			spawnSync(process.execPath, [SCRIPT], {
				encoding: 'utf8',
				env: {
					...CLEAN_ENV,
					GITHUB_EVENT_PATH: event,
					INPUT_FORMAT_MODE: formatMode,
					INPUT_PR_FILES_READY: 'true',
					INPUT_PR_FILES: prFiles,
				},
			});
		const report = execute('report');
		assert.strictEqual(report.status, 0);
		assert.match(report.stderr, /artifact exceeds 4194304 bytes/);
		assert.match(report.stdout, /review-coverage \[report\]/, 'artifact failures must not suppress coverage output');
		const enforce = execute('enforce');
		assert.strictEqual(enforce.status, 1);
		assert.match(enforce.stderr, /PR-files evidence is unavailable/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the action consumes a produced PR-files artifact end to end', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-artifact-'));
	const event = path.join(dir, 'event.json');
	const prFiles = path.join(dir, 'pr-files.json');
	const hash = 'db526bfa2603e0ee94ab17a9ea8c2b8bd02e1f626dd6907624cfe8508ad356ba';
	const link = `https://github.com/HarperFast/harper/pull/2338/changes?w=1#diff-${hash}R211`;
	writeFileSync(
		event,
		JSON.stringify({
			number: 2338,
			repository: { full_name: 'HarperFast/harper' },
			pull_request: pr({ body: `Summary with [current code](${link}).\n\n## Verification\n\nFocused test passed.` }),
		})
	);
	writeFileSync(
		prFiles,
		JSON.stringify(normalizePrFiles([[{ filename: 'resources/auditStore.ts', patch: '@@ -200,21 +205,62 @@' }]]))
	);
	try {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: 'utf8',
			env: {
				...CLEAN_ENV,
				GITHUB_EVENT_PATH: event,
				INPUT_FORMAT_MODE: 'report',
				INPUT_PR_FILES_READY: 'true',
				INPUT_PR_FILES: prFiles,
			},
		});
		assert.strictEqual(result.status, 0);
		assert.match(result.stdout, /pr-format \[report\]: compliant/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the collector CLI writes a normalized stdin artifact', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-collector-'));
	const output = path.join(dir, 'pr-files.json');
	try {
		const result = spawnSync(process.execPath, [COLLECTOR, output], {
			encoding: 'utf8',
			input: JSON.stringify([[{ filename: 'new.js', patch: '@@ -0,0 +1,2 @@\n+a\n+b' }]]),
		});
		assert.strictEqual(result.status, 0);
		assert.deepStrictEqual(JSON.parse(readFileSync(output, 'utf8')).files[0].ranges, { L: [], R: [[1, 2]] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a schema-invalid artifact becomes unavailable evidence without hiding coverage', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-schema-'));
	const event = path.join(dir, 'event.json');
	const prFiles = path.join(dir, 'pr-files.json');
	writeFileSync(event, JSON.stringify({ pull_request: pr() }));
	writeFileSync(prFiles, JSON.stringify({ version: 1, complete: true, files: {} }));
	try {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: 'utf8',
			env: {
				...CLEAN_ENV,
				GITHUB_EVENT_PATH: event,
				INPUT_FORMAT_MODE: 'report',
				INPUT_PR_FILES_READY: 'true',
				INPUT_PR_FILES: prFiles,
			},
		});
		assert.strictEqual(result.status, 0);
		assert.match(result.stdout, /review-coverage \[report\]/);
		assert.match(result.stderr, /invalid normalized PR-files artifact/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a step-summary write failure does not change the coverage verdict', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-summary-'));
	const file = path.join(dir, 'event.json');
	writeFileSync(file, JSON.stringify({ pull_request: pr() }));
	try {
		const report = spawnSync(process.execPath, [SCRIPT, '--event', file], {
			encoding: 'utf8',
			env: { ...CLEAN_ENV, GITHUB_STEP_SUMMARY: dir },
		});
		assert.strictEqual(report.status, 0);
		assert.match(report.stderr, /could not write the step summary/);
		assert.match(report.stderr, /::warning::0 cross-model reviews reported/);

		const compliant = { pull_request: pr({ body: covered('codex,gemini') }) };
		writeFileSync(file, JSON.stringify(compliant));
		const enforce = spawnSync(process.execPath, [SCRIPT, '--event', file, '--mode', 'enforce'], {
			encoding: 'utf8',
			env: { ...CLEAN_ENV, GITHUB_STEP_SUMMARY: dir },
		});
		assert.strictEqual(enforce.status, 0);
		assert.match(enforce.stderr, /could not write the step summary/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
