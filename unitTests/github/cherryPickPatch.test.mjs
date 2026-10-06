import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Runs the shipped cherry-pick job's `run:` steps against a local origin, with `gh` and the
// sticky-comment helper stubbed, so a test sees exactly the branches and PRs a real run makes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const job = parse(readFileSync(join(root, '.github/workflows/cherry-pick-patch.yml'), 'utf8')).jobs['cherry-pick'];
const changeLanded = join(root, '.github/scripts/change-landed.sh');
const RELEASE = 'v5.3';
const PR_NUMBER = '7';
const DEADLINE = 60_000;
// #3038's shape: the second commit rewrites the line the first one changed, so replaying the first
// onto a release that already has both conflicts instead of applying empty.
const FIRST_FIX = { 5: 'first fix' };
const SECOND_FIX = { 5: 'second fix', 6: 'second fix, continued' };

describe('cherry-pick-patch.yml', function () {
	let fixture;

	beforeEach(function () {
		fixture = createFixture();
	});

	afterEach(function () {
		if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
		fixture = undefined;
	});

	function incidentPr() {
		fixture.prCommit(FIRST_FIX, 'First fix');
		fixture.prCommit(SECOND_FIX, 'Second fix');
		return fixture.squashMerge();
	}

	it('lands a squash-merged change the release branch lacks', function () {
		incidentPr();
		const run = fixture.runJob();
		assert.ok(run.ran.includes('Merge into release branch'), run.log);
		assert.strictEqual(fixture.releaseFile(), fixture.lines(SECOND_FIX), run.log);
		assert.deepStrictEqual(run.prCreates, []);
		assert.deepStrictEqual(fixture.cherryPickBranches(), []);
	});

	it('makes a second run for a landed change a no-op, and closes the conflict PR an earlier run left', function () {
		// #3067: one milestone change fires `demilestoned` and `milestoned`; the first run landed
		// the PR's commits and the second re-picked them onto the advanced release tip.
		incidentPr();
		fixture.runJob();
		const landedTip = fixture.releaseTip();
		const run = fixture.runJob({ openPr: '3067' });
		assert.strictEqual(run.outputs.no_op, 'true', run.log);
		assert.match(run.log, /already on v5\.3 — nothing to pick/);
		assert.deepStrictEqual(run.prCreates, [], run.log);
		assert.ok(run.gh.some(([command, sub, number]) => command === 'pr' && sub === 'close' && number === '3067'));
		assert.deepStrictEqual(fixture.cherryPickBranches(), []);
		assert.strictEqual(fixture.releaseTip(), landedTip);
		assert.match(run.stickies.at(-1), /already present/);
	});

	it('skips a change that reached the release branch as one squashed commit', function () {
		const squash = incidentPr();
		const backport = fixture.onRelease((git) => git('cherry-pick', squash));
		const run = fixture.runJob();
		assert.strictEqual(run.outputs.no_op, 'true', run.log);
		assert.deepStrictEqual(run.prCreates, []);
		assert.deepStrictEqual(fixture.cherryPickBranches(), []);
		assert.strictEqual(fixture.releaseTip(), backport);
	});

	it('picks the rest of a change the release branch has only part of', function () {
		incidentPr();
		fixture.onRelease((git) => git('cherry-pick', fixture.prCommits[0]));
		const run = fixture.runJob();
		assert.notStrictEqual(run.outputs.no_op, 'true', run.log);
		assert.strictEqual(run.outputs.conflicts, '', run.log);
		assert.strictEqual(fixture.releaseFile(), fixture.lines(SECOND_FIX), run.log);
	});

	it('picks again a change that landed and was then reverted', function () {
		incidentPr();
		fixture.runJob();
		fixture.onRelease((git) => git('revert', '--no-edit', 'HEAD', 'HEAD~1'));
		assert.strictEqual(fixture.releaseFile(), fixture.lines());
		const run = fixture.runJob();
		assert.notStrictEqual(run.outputs.no_op, 'true', run.log);
		assert.strictEqual(fixture.releaseFile(), fixture.lines(SECOND_FIX), run.log);
	});

	it('lands a change merged with a merge commit, whose PR head is already on main, then skips it', function () {
		fixture.prCommit(FIRST_FIX, 'First fix');
		fixture.prCommit(SECOND_FIX, 'Second fix');
		fixture.mergeCommit();
		const run = fixture.runJob();
		assert.strictEqual(run.outputs.pick_flags, '-m 1', run.log);
		assert.strictEqual(fixture.releaseFile(), fixture.lines(SECOND_FIX), run.log);
		const landedTip = fixture.releaseTip();
		const rerun = fixture.runJob();
		// The lone `-m 1` pick would also come out empty; the skip must come from the containment check.
		assert.match(rerun.log, /already on v5\.3 — nothing to pick/);
		assert.strictEqual(rerun.outputs.pick_flags, undefined, rerun.log);
		assert.strictEqual(fixture.releaseTip(), landedTip);
	});

	it('still opens the conflict PR when the release branch changed the same lines differently', function () {
		incidentPr();
		fixture.onRelease((git) => {
			fixture.writeLib(fixture.lines({ 5: 'release-only edit' }));
			git('commit', '-qam', 'Release-only edit');
		});
		const run = fixture.runJob();
		assert.notStrictEqual(run.outputs.conflicts, '', run.log);
		assert.ok(run.ran.includes('Report conflict'), run.log);
		assert.strictEqual(run.prCreates.length, 1, run.log);
		assert.deepStrictEqual(fixture.cherryPickBranches(), [`cherry-pick/${RELEASE}/pr-${PR_NUMBER}`]);
		const branchFile = fixture.git(fixture.origin, 'show', `cherry-pick/${RELEASE}/pr-${PR_NUMBER}:lib.txt`);
		assert.match(branchFile, /^<<<<<<< /m);
	});

	it('picks a landed change, as before, when the containment check cannot run', function () {
		incidentPr();
		fixture.runJob();
		const run = fixture.runJob({
			afterStash(temp) {
				const stub = join(temp, 'change-landed.sh');
				writeFileSync(stub, '#!/usr/bin/env bash\necho "::warning::check failed"\nexit 2\n');
				chmodSync(stub, 0o755);
			},
		});
		assert.match(run.log, /::warning::check failed/);
		assert.notStrictEqual(run.outputs.no_op, 'true', run.log);
		assert.notStrictEqual(run.outputs.conflicts, '', run.log);
	});

	it('holds a lone fallback merge commit even when the release branch has that commit', function () {
		// The PR head reached main directly, so the API's merge SHA is just its last commit. The
		// release has that commit but not the one before it; only a human can tell it is incomplete.
		fixture.prCommit({ 10: 'first file fix' }, 'First fix');
		fixture.prCommit({ 20: 'second file fix' }, 'Second fix');
		fixture.fastForward();
		fixture.onRelease((git) => {
			fixture.writeLib(fixture.lines({ 20: 'second file fix' }));
			git('commit', '-qam', 'Backport the second fix only');
		});
		const run = fixture.runJob();
		assert.notStrictEqual(run.outputs.no_op, 'true', run.log);
		assert.ok(run.ran.includes('Report held for review'), run.log);
		assert.match(run.stickies.at(-1), /held for review/);
	});

	describe('a PR whose merge of main resolved content of its own', function () {
		const RESOLVED = { 5: 'resolved' };

		beforeEach(function () {
			fixture.prCommit(FIRST_FIX, 'First fix');
			fixture.mainCommit({ 5: 'main edit' }, 'Main edit');
			fixture.mergeMainIntoPr(RESOLVED);
			fixture.squashMerge();
		});

		it('is a no-op when its whole net change, resolution included, is on the release branch', function () {
			fixture.onRelease((git) => {
				fixture.writeLib(fixture.lines(RESOLVED));
				git('commit', '-qam', 'Backport the resolved change');
			});
			const run = fixture.runJob();
			assert.strictEqual(run.outputs.no_op, 'true', run.log);
			assert.ok(run.ran.includes('Report no-op'), run.log);
			assert.deepStrictEqual(run.prCreates, []);
		});

		it('is held for review when the release branch lacks it', function () {
			const run = fixture.runJob();
			assert.notStrictEqual(run.outputs.no_op, 'true', run.log);
			assert.ok(run.ran.includes('Report held for review'), run.log);
			assert.strictEqual(run.prCreates.length, 1, run.log);
		});
	});
});

describe('change-landed.sh', function () {
	let dir;
	let env;
	const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: DEADLINE }).trim();
	const landed = (target, base, head) =>
		spawnSync('bash', [changeLanded, target, base, head], { cwd: dir, env, encoding: 'utf8', timeout: DEADLINE });

	beforeEach(function () {
		dir = mkdtempSync(join(tmpdir(), 'change-landed-'));
		env = isolatedGitEnv(dir);
		git('init', '-q');
		git('config', 'user.name', 'Author');
		git('config', 'user.email', 'author@example.com');
		writeFileSync(join(dir, 'text.txt'), 'text\n');
		writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
		writeFileSync(join(dir, 'run.sh'), 'echo run\n');
		writeFileSync(join(dir, 'gone.txt'), 'to be deleted\n');
		writeFileSync(join(dir, 'moved.txt'), Array.from({ length: 20 }, (_, index) => `moved ${index}\n`).join(''));
		git('add', '.');
		git('commit', '-qm', 'Base');
	});

	afterEach(function () {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	const changes = {
		'an executable bit': () => {
			chmodSync(join(dir, 'run.sh'), 0o755);
			git('add', 'run.sh');
		},
		'binary content': () => {
			writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
			git('add', 'blob.bin');
		},
		'a deletion': () => git('rm', '-q', 'gone.txt'),
		'a rename': () => git('mv', 'moved.txt', 'renamed.txt'),
		'a new file': () => {
			writeFileSync(join(dir, 'new.txt'), 'new\n');
			git('add', 'new.txt');
		},
	};

	for (const [kind, change] of Object.entries(changes)) {
		it(`tells ${kind} the target has from one it lacks`, function () {
			const base = git('rev-parse', 'HEAD');
			change();
			git('commit', '-qm', kind);
			const head = git('rev-parse', 'HEAD');
			git('checkout', '-qb', 'target', base);
			writeFileSync(join(dir, 'text.txt'), 'an unrelated release edit\n');
			git('commit', '-qam', 'Unrelated release edit');
			const without = landed('target', base, head);
			assert.strictEqual(without.status, 1, without.stdout + without.stderr);
			git('cherry-pick', head);
			const withChange = landed('target', base, head);
			assert.strictEqual(withChange.status, 0, withChange.stdout + withChange.stderr);
		});
	}

	it('reports a check that cannot run with a warning and exit 2', function () {
		const result = landed('refs/heads/no-such-branch', 'HEAD', 'HEAD');
		assert.strictEqual(result.status, 2, result.stderr);
		assert.match(result.stdout, /^::warning::/m);
	});
});

function isolatedGitEnv(dir) {
	const gitconfig = join(dir, '.gitconfig-test');
	writeFileSync(
		gitconfig,
		'[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n'
	);
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: '1',
	};
}

function createFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'cherry-pick-patch-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const env = isolatedGitEnv(dir);
	env.PATH = `${bin}:${process.env.PATH}`;
	writeStub(
		join(bin, 'gh'),
		`const { appendFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const [command, sub] = args;
if (command === 'api' && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(sub) && args[2] === '--jq') {
	process.stdout.write(execFileSync('jq', ['-c', args[3], process.env.GH_PR_JSON]));
} else if (command === 'pr' && sub === 'list') {
	process.stdout.write(process.env.GH_OPEN_PR ?? '');
} else if (command === 'pr' && sub === 'create') {
	process.stdout.write('https://github.com/test/repo/pull/100\\n');
} else if (!(command === 'pr' && ['edit', 'close'].includes(sub))) {
	process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
	process.exit(1);
}
`
	);
	const stickyStub = join(dir, 'upsert-sticky-comment.js');
	writeFileSync(
		stickyStub,
		`require('node:fs').appendFileSync(process.env.STICKY_LOG, JSON.stringify(process.argv[4]) + '\\n');\n`
	);

	const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: DEADLINE }).trim();
	const origin = join(dir, 'origin.git');
	const seed = join(dir, 'seed');
	git(dir, 'init', '-q', '--bare', origin);
	git(dir, 'init', '-q', seed);
	git(seed, 'config', 'user.name', 'Author');
	git(seed, 'config', 'user.email', 'author@example.com');
	git(seed, 'remote', 'add', 'origin', origin);
	const seedGit = (...args) => git(seed, ...args);

	const lines = (overrides = {}) =>
		Array.from({ length: 40 }, (_, index) => overrides[index + 1] ?? `line ${index + 1}`).join('\n') + '\n';
	const writeLib = (content) => writeFileSync(join(seed, 'lib.txt'), content);
	const commitLib = (overrides, message) => {
		writeLib(lines(overrides));
		seedGit('commit', '-qam', message);
		return seedGit('rev-parse', 'HEAD');
	};

	writeLib(lines());
	seedGit('add', 'lib.txt');
	seedGit('commit', '-qm', 'Base');
	seedGit('branch', RELEASE);
	// main moves on after the release cut, away from the lines the PRs touch
	let mainState = { 35: 'main-only change' };
	commitLib(mainState, 'Main-only change');
	seedGit('branch', 'feature');
	let featureState = { ...mainState };
	const prCommits = [];

	let prJson;
	const publish = (mergeSha) => {
		seedGit('push', '-q', '--force', 'origin', 'main', RELEASE, `feature:refs/pull/${PR_NUMBER}/head`);
		prJson = join(dir, 'pr.json');
		writeFileSync(
			prJson,
			JSON.stringify({
				title: 'Fix the thing',
				head: { sha: seedGit('rev-parse', 'feature') },
				base: { sha: seedGit('merge-base', 'main', 'feature') },
				merge_commit_sha: mergeSha,
				merged: true,
				state: 'closed',
			})
		);
		return mergeSha;
	};
	const onBranch = (branch, change) => {
		seedGit('checkout', '-q', branch);
		const result = change();
		seedGit('checkout', '-q', 'main');
		return result;
	};

	return {
		dir,
		origin,
		prCommits,
		lines,
		writeLib,
		git,
		prCommit(overrides, message) {
			featureState = { ...featureState, ...overrides };
			prCommits.push(onBranch('feature', () => commitLib(featureState, message)));
		},
		mainCommit(overrides, message) {
			mainState = { ...mainState, ...overrides };
			commitLib(mainState, message);
		},
		mergeMainIntoPr(resolution) {
			featureState = { ...mainState, ...resolution };
			onBranch('feature', () => {
				spawnSync('git', ['merge', '-q', 'main'], { cwd: seed, env, timeout: DEADLINE });
				writeLib(lines(featureState));
				seedGit('commit', '-qam', 'Merge main, resolving the conflict by hand');
			});
		},
		squashMerge() {
			seedGit('merge', '-q', '--squash', 'feature');
			seedGit('commit', '-qm', `Fix the thing (#${PR_NUMBER})`);
			return publish(seedGit('rev-parse', 'HEAD'));
		},
		mergeCommit() {
			seedGit('merge', '-q', '--no-ff', '-m', `Merge pull request #${PR_NUMBER}`, 'feature');
			return publish(seedGit('rev-parse', 'HEAD'));
		},
		fastForward() {
			seedGit('merge', '-q', '--ff-only', 'feature');
			return publish(seedGit('rev-parse', 'HEAD'));
		},
		onRelease(change) {
			seedGit('fetch', '-q', 'origin', `+${RELEASE}:${RELEASE}`);
			return onBranch(RELEASE, () => {
				change(seedGit);
				seedGit('push', '-q', 'origin', RELEASE);
				return seedGit('rev-parse', 'HEAD');
			});
		},
		releaseFile: () => git(origin, 'show', `${RELEASE}:lib.txt`) + '\n',
		releaseTip: () => git(origin, 'rev-parse', RELEASE),
		cherryPickBranches: () =>
			git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cherry-pick/').split('\n').filter(Boolean),
		runJob(options = {}) {
			return runJob({ dir, env, origin, prJson, stickyStub, git, ...options });
		},
	};
}

function runJob({ dir, env, origin, prJson, stickyStub, git, openPr, afterStash }) {
	const run = mkdtempSync(join(dir, 'run-'));
	const work = join(run, 'work');
	const temp = join(run, 'temp');
	mkdirSync(temp);
	git(run, 'clone', '-q', origin, work);
	const ghLog = join(run, 'gh.log');
	const stickyLog = join(run, 'sticky.log');
	const outputs = {};
	const ran = [];
	let log = '';
	let failed = false;
	let first = true;
	for (const [index, step] of job.steps.entries()) {
		if (step.uses || !stepCondition(step.if, outputs, failed)) continue;
		// The real checkout is of main, which tracks .github/scripts; the fixture's main does not.
		if (first) cpSync(join(root, '.github/scripts'), join(work, '.github/scripts'), { recursive: true });
		const outputFile = join(run, `output-${index}`);
		writeFileSync(outputFile, '');
		const stepEnv = {
			...env,
			GITHUB_OUTPUT: outputFile,
			GITHUB_REPOSITORY: 'test/repo',
			GITHUB_SERVER_URL: 'https://github.com',
			GITHUB_RUN_ID: '1',
			RUNNER_TEMP: temp,
			PR_NUMBER,
			GH_LOG: ghLog,
			GH_PR_JSON: prJson,
			STICKY_LOG: stickyLog,
		};
		if (openPr) stepEnv.GH_OPEN_PR = openPr;
		for (const [key, value] of Object.entries({ ...job.env, ...step.env })) {
			stepEnv[key] = expand(String(value), outputs);
		}
		const script = join(run, `step-${index}.sh`);
		writeFileSync(script, expand(step.run, outputs));
		const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
			cwd: work,
			env: stepEnv,
			encoding: 'utf8',
			timeout: DEADLINE,
		});
		ran.push(step.name);
		log += `\n── ${step.name} (exit ${result.status})\n${result.stdout}${result.stderr}`;
		if (result.status !== 0) failed = true;
		if (step.id) Object.assign(outputs, readOutputs(outputFile));
		if (first) {
			rmSync(join(work, '.github'), { recursive: true, force: true });
			cpSync(stickyStub, join(temp, 'upsert-sticky-comment.js'));
			afterStash?.(temp);
			first = false;
		}
	}
	assert.ok(!failed, log);
	const readLog = (file) =>
		existsSync(file)
			? readFileSync(file, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const gh = readLog(ghLog);
	return {
		ran,
		outputs,
		log,
		gh,
		prCreates: gh.filter(([command, sub]) => command === 'pr' && sub === 'create'),
		stickies: readLog(stickyLog),
	};
}

// GitHub's expression syntax, limited to the forms this job uses; anything else fails the test
// rather than being guessed at.
function expand(text, outputs) {
	return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression) => {
		const output = /^steps\.pick\.outputs\.(\w+)$/.exec(expression);
		if (output) return outputs[output[1]] ?? '';
		if (expression === 'matrix.release') return RELEASE;
		if (expression === 'secrets.GITHUB_TOKEN') return 'test-token';
		throw new Error(`unsupported expression: ${expression}`);
	});
}

function stepCondition(condition, outputs, failed) {
	if (condition === undefined) return !failed;
	let checksStatus = false;
	let result = true;
	for (const term of condition.split('&&').map((part) => part.trim())) {
		if (term === 'failure()') {
			checksStatus = true;
			result &&= failed;
			continue;
		}
		const comparison = /^steps\.pick\.outputs\.(\w+) (==|!=) '([^']*)'$/.exec(term);
		if (!comparison) throw new Error(`unsupported if: ${condition}`);
		const value = outputs[comparison[1]] ?? '';
		result &&= comparison[2] === '==' ? value === comparison[3] : value !== comparison[3];
	}
	return checksStatus ? result : result && !failed;
}

function readOutputs(file) {
	const outputs = {};
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let index = 0; index < lines.length; index++) {
		const heredoc = /^(\w+)<<(.+)$/.exec(lines[index]);
		if (heredoc) {
			const end = lines.indexOf(heredoc[2], index + 1);
			if (end < 0) throw new Error(`output ${heredoc[1]} has no closing ${heredoc[2]}`);
			outputs[heredoc[1]] = lines.slice(index + 1, end).join('\n');
			index = end;
			continue;
		}
		const separator = lines[index].indexOf('=');
		if (separator > 0) outputs[lines[index].slice(0, separator)] = lines[index].slice(separator + 1);
	}
	return outputs;
}

function writeStub(path, source) {
	writeFileSync(path, `#!/usr/bin/env node\n${source}`);
	chmodSync(path, 0o755);
}
