import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizePrFiles, readBounded } from './collectPrFiles.mjs';
import { evaluatePrFormat } from './evaluatePrFormat.mjs';
import { checkBodyLinks, fileAnchorHash, parseBodyAnchors } from './prFormatLinks.mjs';

const REPO = 'HarperFast/harper';
const NUMBER = 2338;
const HEAD = '609896d762efe2c9f529a0f9989ce0a53dd29b40';
const FILE = 'resources/auditStore.ts';
const HASH = 'db526bfa2603e0ee94ab17a9ea8c2b8bd02e1f626dd6907624cfe8508ad356ba';
const LINK = `https://github.com/${REPO}/pull/${NUMBER}/changes?w=1#diff-${HASH}R211`;
const PR_FILES = {
	version: 1,
	complete: true,
	files: [{ path: FILE, patchAvailable: true, ranges: { L: [[200, 220]], R: [[205, 266]] } }],
};
const body = ({ link = LINK, head = HEAD.slice(0, 12) } = {}) =>
	[
		`Audit retention now runs continuously${link ? ` in [the cleanup loop](${link})` : ''}.`,
		'',
		'## For the human reviewer',
		'',
		'No open judgment calls.',
		'',
		'## Verification',
		'',
		'Focused retention tests passed.',
		'',
		'Complexity: complicated',
		'',
		`<sub>Review-Coverage: authored=codex; ran=claude; rounds=1 @ ${head}</sub>`,
		'',
		`<sub>Human-Review-Need: 2 @ ${head}</sub>`,
	].join('\n');
const pr = (over = {}) => ({
	user: { login: 'kriszyp', type: 'User' },
	author_association: 'MEMBER',
	body: body(),
	additions: 160,
	deletions: 31,
	draft: false,
	head: { sha: HEAD },
	...over,
});

test('the remediated #2338 shape passes with a current line anchor', () => {
	assert.strictEqual(fileAnchorHash(FILE), HASH, "fixture pins GitHub's sha256(path) anchor contract");
	const result = evaluatePrFormat(pr(), { mode: 'enforce', repo: REPO, number: NUMBER, prFiles: PR_FILES });
	assert.strictEqual(result.pass, true);
	assert.strictEqual(result.compliant, true);
	assert.strictEqual(result.links.lineAnchored.length, 1);
});

test('ordinary prose and inline examples do not trigger AI-shape fields', () => {
	const humanBody = [
		`This lowers algorithmic complexity: fewer branches; the \`Human-Review-Need:\` field is unchanged. [Code](${LINK})`,
		'',
		'## Verification',
		'',
		'Focused test passed.',
	].join('\n');
	const result = evaluatePrFormat(pr({ body: humanBody }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, true);
	assert.strictEqual(result.compliant, true);
});

test('the motivating same-head link removal fails independently of footer freshness', () => {
	const result = evaluatePrFormat(pr({ body: body({ link: '' }) }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, false);
	assert.match(result.problems.join('\n'), /no line-anchored PR-diff link/);
	assert.ok(pr().head.sha.startsWith(HEAD.slice(0, 12)), 'fixture footers remain pinned to the same head');
});

test('drafts report defects but stay green; ready PRs fail enforce mode', () => {
	const broken = { body: 'Summary only.', draft: true };
	const draft = evaluatePrFormat(pr(broken), { mode: 'enforce', repo: REPO, number: NUMBER });
	assert.strictEqual(draft.pass, true);
	assert.strictEqual(draft.compliant, false);
	assert.strictEqual(
		evaluatePrFormat(pr({ ...broken, draft: false }), { mode: 'enforce', repo: REPO, number: NUMBER }).pass,
		false
	);
});

test('bot, external, and trivial PRs are exempt before PR-files access', () => {
	for (const candidate of [
		pr({ user: { login: 'renovate[bot]', type: 'Bot' } }),
		pr({ author_association: 'CONTRIBUTOR' }),
		pr({ additions: 1, deletions: 1 }),
	]) {
		const result = evaluatePrFormat(candidate, { mode: 'enforce', repo: REPO, number: NUMBER });
		assert.strictEqual(result.pass, true);
		assert.ok(result.exempt);
	}
});

test('every live anchor must target this PR and a current hunk line', () => {
	const foreign = body().replace(`/pull/${NUMBER}/`, '/pull/999/');
	assert.match(
		evaluatePrFormat(pr({ body: foreign }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		}).problems.join('\n'),
		/points at HarperFast\/harper#999/
	);
	const drifted = body().replace('R211', 'R400');
	assert.match(
		evaluatePrFormat(pr({ body: drifted }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		}).problems.join('\n'),
		/not in a current diff hunk/
	);
});

test('fenced examples do not satisfy the line-link requirement', () => {
	const fenced = body({ link: '' }).replace(
		'Audit retention now runs continuously.',
		`Audit retention now runs continuously.\n\n\`\`\`md\n${LINK}\n\`\`\``
	);
	assert.strictEqual(parseBodyAnchors(fenced).length, 0);
});

test('inline-code and HTML-comment links do not satisfy the line-link requirement', () => {
	for (const hidden of [`\`${LINK}\``, `<!-- ${LINK} -->`]) {
		const result = evaluatePrFormat(
			pr({ body: body({ link: '' }).replace('continuously.', `continuously. ${hidden}`) }),
			{
				mode: 'enforce',
				repo: REPO,
				number: NUMBER,
				prFiles: PR_FILES,
			}
		);
		assert.match(result.problems.join('\n'), /no line-anchored PR-diff link/);
	}
});

test('a stray backtick cannot hide later Markdown blocks', () => {
	const humanBody = [
		`Refactors the \` operator handling. [Code](${LINK})`,
		'',
		'## Verification',
		'',
		'Ran `npm run test:unit`.',
	].join('\n');
	const result = evaluatePrFormat(pr({ body: humanBody }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, true);
});

test('nested-list and list-continuation links remain visible', () => {
	for (const evidence of [
		`- Ran focused tests:\n    - [cleanup loop](${LINK})`,
		`- Ran focused tests:\n    [cleanup loop](${LINK})`,
	]) {
		const humanBody = ['Summary.', '', '## Verification', '', evidence].join('\n');
		const result = evaluatePrFormat(pr({ body: humanBody }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		});
		assert.strictEqual(result.pass, true, evidence);
	}
});

test('an unterminated fence reports its cause', () => {
	const result = evaluatePrFormat(pr({ body: `${body()}\n\n\`\`\`md\nexample` }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /unterminated fenced code block/);
});

test('an unterminated HTML comment reports its cause', () => {
	const result = evaluatePrFormat(pr({ body: `${body()}\n\n<!-- unfinished` }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /unterminated HTML comment/);
});

test('comment and fenced-code tokens do not consume one another', () => {
	for (const suffix of ['<!-- ```suggestion\nold code\n``` -->', '```md\n<!-- unfinished\n```']) {
		const result = evaluatePrFormat(pr({ body: `${body()}\n\n${suffix}` }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		});
		assert.strictEqual(result.pass, true, suffix);
	}
});

test('indented-code links do not satisfy the line-link requirement', () => {
	const indented = body({ link: '' }).replace('continuously.', `continuously.\n\n    ${LINK}`);
	const result = evaluatePrFormat(pr({ body: indented }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /no line-anchored PR-diff link/);
});

test('older files URLs and per-commit paths use the same anchor contract', () => {
	const url = `https://github.com/${REPO}/pull/${NUMBER}/files/abc123?w=1#diff-${HASH}R211-R220`;
	const result = checkBodyLinks({ body: url, prFiles: PR_FILES, repo: REPO, number: NUMBER });
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.lineAnchored[0].line, 211);
});

test('every recognized PR-diff link needs a line anchor', () => {
	const fileOnly = `https://github.com/${REPO}/pull/${NUMBER}/changes#diff-${HASH}`;
	const result = evaluatePrFormat(pr({ body: `${body()}\n\nSee also ${fileOnly}.` }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /PR-diff link has no line anchor/);
});

test('partial or non-resolving anchor URLs are not accepted', () => {
	for (const malformed of [LINK.replace('/changes?', '/changes-bogus?'), `${LINK}evil`])
		assert.strictEqual(parseBodyAnchors(malformed).length, 0);
});

test('PR-files normalization implements unified-diff count semantics', () => {
	const normalized = normalizePrFiles([
		[
			{ filename: 'new.js', patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' },
			{ filename: 'edit.js', patch: '@@ -8 +10 @@\n-old\n+new' },
			{ filename: 'binary.dat' },
		],
	]);
	assert.deepStrictEqual(normalized.files[0].ranges, { L: [], R: [[1, 3]] });
	assert.deepStrictEqual(normalized.files[1].ranges, { L: [[8, 8]], R: [[10, 10]] });
	assert.strictEqual(normalized.files[2].patchAvailable, false);
});

test('an omitted patch or incomplete file list is explicitly unverifiable', () => {
	const unavailable = {
		version: 1,
		complete: true,
		files: [{ path: FILE, patchAvailable: false, ranges: { L: [], R: [] } }],
	};
	assert.strictEqual(
		checkBodyLinks({ body: LINK, prFiles: unavailable, repo: REPO, number: NUMBER }).unverifiable,
		true
	);
	assert.strictEqual(
		checkBodyLinks({ body: LINK, prFiles: { version: 1, complete: false, files: [] }, repo: REPO, number: NUMBER })
			.unverifiable,
		true
	);
	const missing = checkBodyLinks({ body: LINK, prFiles: null, repo: REPO, number: NUMBER });
	assert.strictEqual(missing.unverifiable, true);
	assert.doesNotMatch(missing.problems.map(({ message }) => message).join('\n'), /does not match a file/);
});

test('PR-files input is rejected while streaming beyond the byte cap', async () => {
	await assert.rejects(readBounded(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), 10), /exceeds 10 bytes/);
});

test('AI fields require the complete ordered body shape', () => {
	const broken = body()
		.replace('## For the human reviewer', '## Notes')
		.replace('Complexity: complicated', 'Complexity: enormous')
		.concat('\nReview-Coverage: duplicate malformed field');
	const result = evaluatePrFormat(pr({ body: broken }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /For the human reviewer/);
	assert.match(result.problems.join('\n'), /valid Complexity/);
	assert.match(result.problems.join('\n'), /pinned Review-Coverage footer \(found 2 field\(s\), 1 valid\)/);
});

test('AI field recognition is case-consistent', () => {
	const lower = body()
		.replace('Complexity:', 'complexity:')
		.replace('Review-Coverage:', 'review-coverage:')
		.replace('Human-Review-Need:', 'human-review-need:');
	const result = evaluatePrFormat(pr({ body: lower }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, true);
});

test('ordinary leading whitespace is allowed on Complexity', () => {
	const result = evaluatePrFormat(pr({ body: body().replace('Complexity:', ' Complexity:') }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, true);
});

test('AI footers must be pinned to the current head', () => {
	const result = evaluatePrFormat(pr({ body: body({ head: 'deadbeef1234' }) }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.match(result.problems.join('\n'), /Review-Coverage footer is not pinned to the current head/);
	assert.match(result.problems.join('\n'), /Human-Review-Need footer is not pinned to the current head/);
});

test('footer text cannot satisfy an empty Verification section', () => {
	const broken = body().replace('Focused retention tests passed.\n\n', '');
	assert.match(
		evaluatePrFormat(pr({ body: broken }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		}).problems.join('\n'),
		/Verification needs executed evidence/
	);
});

test('HTML-only content cannot satisfy Verification', () => {
	const broken = body().replace('Focused retention tests passed.', '<br>');
	assert.match(
		evaluatePrFormat(pr({ body: broken }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		}).problems.join('\n'),
		/Verification needs executed evidence/
	);
});

test('a lowercase AI field ends an empty Verification section', () => {
	const broken = body().replace('Focused retention tests passed.\n\nComplexity:', 'complexity:');
	assert.match(
		evaluatePrFormat(pr({ body: broken }), {
			mode: 'enforce',
			repo: REPO,
			number: NUMBER,
			prFiles: PR_FILES,
		}).problems.join('\n'),
		/Verification needs executed evidence/
	);
});

test('a superseded run is neutral even in enforce mode', () => {
	const result = evaluatePrFormat(pr({ body: '' }), {
		mode: 'enforce',
		repo: REPO,
		number: NUMBER,
		superseded: true,
	});
	assert.strictEqual(result.pass, true);
	assert.match(result.exempt, /superseded/);
});

test('body parsing is bounded at GitHub description size', () => {
	const result = evaluatePrFormat(pr({ body: `${body()}${'x'.repeat(65_536)}` }), {
		mode: 'report',
		repo: REPO,
		number: NUMBER,
		prFiles: PR_FILES,
	});
	assert.strictEqual(result.pass, true);
	assert.match(result.problems.join('\n'), /exceeds 65536 characters/);
});

test('the report workflow keeps the existing check identity and gates PR-files collection', () => {
	const workflow = readFileSync(fileURLToPath(new URL('../../workflows/review-coverage.yml', import.meta.url)), 'utf8');
	assert.match(workflow, /jobs:\n\s+coverage:\n\s+runs-on:/);
	assert.doesNotMatch(workflow, /\n\s+name:\s+report/);
	assert.match(workflow, /author_association == 'MEMBER'/);
	assert.match(workflow, /continue-on-error: true/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /format_mode: report/);
	assert.strictEqual(workflow.match(/live_head=\$\(gh api/g)?.length, 2, 'head is checked before and after collection');
	assert.match(workflow, /pr_files_superseded:/);
});
