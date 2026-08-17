import assert from 'node:assert';
import test from 'node:test';

import { evaluateCiCoverage } from './ci-review-coverage.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const pr = (over = {}) => ({
	user: { login: 'someone', type: 'User' },
	author_association: 'MEMBER',
	body: 'plain description',
	additions: 40,
	deletions: 12,
	draft: false,
	head: { sha: HEAD },
	...over,
});

test('report mode is always green, but says what is missing', () => {
	const r = evaluateCiCoverage(pr());
	assert.strictEqual(r.pass, true);
	assert.strictEqual(r.compliant, false);
	assert.match(r.summary, /no cross-model reviews reported/);
});

test('enforce mode fails a member non-trivial PR reporting under the threshold', () => {
	assert.strictEqual(evaluateCiCoverage(pr(), { mode: 'enforce' }).pass, false);
	const one = pr({ body: '## Review coverage\n- Codex: clean' });
	assert.strictEqual(evaluateCiCoverage(one, { mode: 'enforce' }).pass, false);
	const two = pr({ body: '## Review coverage\n- Codex: clean\n- Gemini: 1 finding, fixed' });
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
	assert.match(evaluateCiCoverage(at('999999999999')).detail, /STALE/);
	assert.match(evaluateCiCoverage(pr()).detail, /no Human-Review-Need footer/);
});

test('required is tunable', () => {
	const one = pr({ body: '## Review coverage\n- Codex: clean' });
	assert.strictEqual(evaluateCiCoverage(one, { mode: 'enforce', required: 1 }).pass, true);
});

// ---- exit codes, through the real CLI entry ----

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('./ci-review-coverage.mjs', import.meta.url));
const runResult = (payload, ...args) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'rc-'));
	const file = path.join(dir, 'event.json');
	if (payload !== null) writeFileSync(file, JSON.stringify(payload));
	try {
		return spawnSync(process.execPath, [SCRIPT, '--event', file, ...args], { encoding: 'utf8' });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
const run = (payload, ...args) => runResult(payload, ...args).status ?? 1;

test('exit codes: report never reds, enforce reds on policy AND on plumbing', () => {
	const compliant = { pull_request: pr({ body: '## Review coverage\n- Codex: ran\n- Gemini: ran' }) };
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
	symlinkSync(fileURLToPath(new URL('./reviewGate.mjs', import.meta.url)), path.join(dir, 'reviewGate.mjs'));
	writeFileSync(file, JSON.stringify({ pull_request: pr() }));
	try {
		const output = execFileSync(process.execPath, ['--preserve-symlinks-main', link, '--event', file], {
			encoding: 'utf8',
		});
		assert.match(output, /review-coverage \[report\]/);
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
			env: { ...process.env, GITHUB_STEP_SUMMARY: dir },
		});
		assert.strictEqual(report.status, 0);
		assert.match(report.stderr, /could not write the step summary/);
		assert.match(report.stderr, /::warning::no cross-model reviews reported/);

		const compliant = { pull_request: pr({ body: '## Review coverage\n- Codex: ran\n- Gemini: ran' }) };
		writeFileSync(file, JSON.stringify(compliant));
		const enforce = spawnSync(process.execPath, [SCRIPT, '--event', file, '--mode', 'enforce'], {
			encoding: 'utf8',
			env: { ...process.env, GITHUB_STEP_SUMMARY: dir },
		});
		assert.strictEqual(enforce.status, 0);
		assert.match(enforce.stderr, /could not write the step summary/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
