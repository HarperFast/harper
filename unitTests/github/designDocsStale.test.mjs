import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/design-docs-stale.yml'), 'utf8'));
const reportStep = workflow.jobs.report.steps.find((step) => step.id === 'stale');
const syncStep = workflow.jobs['sync-issue'].steps[0];
const MARKER = '<!-- design-docs-stale-report -->';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const DEADLINE = 60_000;
const REPORT = '## Dead references\n\n### `lib/DESIGN.md`\n\n- line 5: `$(touch pwned)` (symbol)\n';

const GH_STUB = `#!/usr/bin/env node
const { appendFileSync, copyFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const [command, sub] = args;
if (command === 'issue' && sub === 'list') {
	if (process.env.GH_LIST_FAILS) {
		process.stderr.write('HTTP 502\\n');
		process.exit(1);
	}
	process.stdout.write(process.env.GH_ISSUES);
} else if (command === 'label' && sub === 'create') {
	if (process.env.GH_LABEL_EXISTS) {
		process.stderr.write('label "design-docs" already exists\\n');
		process.exit(1);
	}
} else if (command === 'issue' && (sub === 'create' || sub === 'edit')) copyFileSync(args[args.indexOf('--body-file') + 1], process.env.GH_BODY);
else if (!(command === 'issue' && (sub === 'reopen' || sub === 'close'))) {
	process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
	process.exit(1);
}
`;

// Runs a step the way GitHub runs `shell: bash`: `bash --noprofile --norc -eo pipefail {0}`.
function runScript(step, { cwd, env, expectFailure = false }) {
	assert.strictEqual(step.shell, 'bash', `${step.name} must set shell: bash to get pipefail`);
	const file = join(cwd, '..', `step-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(file, step.run);
	const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
		cwd,
		env,
		encoding: 'utf8',
		timeout: DEADLINE,
	});
	if (expectFailure) assert.notStrictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
	else assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
	return result;
}

function readOutputs(file) {
	const outputs = {};
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const heredoc = /^([\w-]+)<<(.+)$/.exec(lines[i]);
		if (!heredoc) continue;
		const end = lines.indexOf(heredoc[2], i + 1);
		outputs[heredoc[1]] = lines.slice(i + 1, end).join('\n');
		i = end;
	}
	return outputs;
}

describe('design-docs-stale.yml', function () {
	let dir;
	beforeEach(function () {
		dir = mkdtempSync(join(tmpdir(), 'design-docs-stale-'));
	});
	afterEach(function () {
		rmSync(dir, { recursive: true, force: true });
	});

	describe('report job', function () {
		function checkout(files) {
			const work = join(dir, 'work');
			for (const [file, content] of Object.entries(files)) {
				mkdirSync(join(work, file, '..'), { recursive: true });
				writeFileSync(join(work, file), content);
			}
			cpSync(join(ROOT, 'build-tools/check-design-docs.mjs'), join(work, 'build-tools/check-design-docs.mjs'));
			cpSync(join(ROOT, 'build-tools/outline.mjs'), join(work, 'build-tools/outline.mjs'));
			symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'));
			const config = join(dir, 'gitconfig');
			writeFileSync(
				config,
				'[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[user]\n\tname = Test\n\temail = test@example.com\n'
			);
			const env = {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
				GIT_CONFIG_GLOBAL: config,
				GIT_CONFIG_NOSYSTEM: '1',
			};
			const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', timeout: DEADLINE });
			writeFileSync(join(work, '.gitignore'), 'node_modules\n');
			git('init', '-q');
			git('add', '-A');
			git('commit', '-q', '-m', 'checkout');
			return { work, env, git };
		}
		function runReport(work, env) {
			const output = join(dir, 'output');
			const summary = join(dir, 'summary');
			writeFileSync(output, '');
			writeFileSync(summary, '');
			runScript(reportStep, { cwd: work, env: { ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
			return { report: readOutputs(output).report, summary: readFileSync(summary, 'utf8') };
		}
		const INDEX = '- [Note](lib/DESIGN.md#note) — one line.\n';

		it('passes the report to the sync job as an output and shows it in the summary', function () {
			const { work, env, git } = checkout({
				'DESIGN.md': INDEX,
				'lib/DESIGN.md': '## Note\n\nCalls `retiredHelper()`.\n',
				'lib/old.ts': 'export function retiredHelper() {}\n',
			});
			git('rm', '-q', 'lib/old.ts');
			git('commit', '-q', '-m', 'retire');
			const { report, summary } = runReport(work, env);
			assert.match(report, /^## Dead references\n/);
			assert.match(report, /- line 3: `retiredHelper\(\)` \(symbol\)/);
			assert.strictEqual(summary, `${report}\n`);
		});

		it('passes an empty report for a clean tree', function () {
			const { work, env } = checkout({ 'DESIGN.md': INDEX, 'lib/DESIGN.md': '## Note\n\nNothing stale.\n' });
			const { report, summary } = runReport(work, env);
			assert.strictEqual(report, '');
			assert.strictEqual(summary, 'No stale references, nothing over ceiling.\n');
		});
	});

	describe('sync-issue job', function () {
		before(function () {
			if (spawnSync('jq', ['--version']).status === 0) return;
			if (process.env.CI) throw new Error('the sync-issue test needs jq');
			this.skip();
		});

		it('is the only job that can write issues, and never runs for a pull request', function () {
			assert.deepStrictEqual(workflow.permissions, { contents: 'read' });
			assert.strictEqual(workflow.jobs.report.permissions, undefined);
			assert.deepStrictEqual(workflow.jobs['sync-issue'].permissions, { issues: 'write' });
			assert.strictEqual(workflow.jobs['sync-issue'].if, "github.event_name != 'pull_request'");
		});

		function sync({ report, issues = [], labelExists = false, listFails = false }) {
			const bin = join(dir, 'bin');
			const work = join(dir, 'work');
			mkdirSync(bin, { recursive: true });
			mkdirSync(work, { recursive: true });
			writeFileSync(join(bin, 'gh'), GH_STUB);
			chmodSync(join(bin, 'gh'), 0o755);
			const log = join(dir, 'gh.log');
			const body = join(dir, 'body.md');
			rmSync(log, { force: true });
			rmSync(body, { force: true });
			const env = {
				PATH: `${bin}:${process.env.PATH}`,
				HOME: dir,
				GH_LOG: log,
				GH_BODY: body,
				GH_ISSUES: JSON.stringify(issues),
				REPORT: report,
				SHA,
			};
			if (labelExists) env.GH_LABEL_EXISTS = '1';
			if (listFails) env.GH_LIST_FAILS = '1';
			runScript(syncStep, { cwd: work, env, expectFailure: listFails });
			const calls = readFileSync(log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter(([command, sub]) => !(command === 'label' || sub === 'list'));
			assert.ok(!existsSync(join(work, 'pwned')), 'the report is data, never shell');
			return { calls, body: existsSync(body) ? readFileSync(body, 'utf8') : undefined };
		}
		const issue = (number, state, body = `${MARKER}\nold report`) => ({ number, state, body });

		it('creates the issue when none carries the marker', function () {
			const { calls, body } = sync({
				report: REPORT,
				issues: [issue(3, 'OPEN', 'a person filed this with the label')],
			});
			assert.deepStrictEqual(calls, [
				[
					'issue',
					'create',
					'--title',
					'Design docs: stale references and files over ceiling',
					'--label',
					'design-docs',
					'--body-file',
					'body.md',
				],
			]);
			assert.ok(body.startsWith(`${MARKER}\nWeekly \`npm run check:design-docs -- --stale\` on 012345678.`), body);
			assert.ok(body.endsWith(`\n\n${REPORT}\n`), body);
		});

		it('reopens and updates the newest marker issue', function () {
			const { calls } = sync({ report: REPORT, issues: [issue(9, 'CLOSED'), issue(5, 'CLOSED')], labelExists: true });
			assert.deepStrictEqual(calls, [
				['issue', 'reopen', '9'],
				['issue', 'edit', '9', '--body-file', 'body.md'],
			]);
		});

		it('updates an open marker issue in place', function () {
			assert.deepStrictEqual(sync({ report: REPORT, issues: [issue(9, 'OPEN')] }).calls, [
				['issue', 'edit', '9', '--body-file', 'body.md'],
			]);
		});

		it('stops without creating an issue when the lookup fails', function () {
			assert.deepStrictEqual(sync({ report: REPORT, listFails: true }).calls, []);
		});

		it('closes the open issue once the report is clean, and leaves a closed one alone', function () {
			assert.deepStrictEqual(sync({ report: '', issues: [issue(9, 'OPEN')] }).calls, [
				['issue', 'close', '9', '--comment', 'The design-doc report is clean as of 012345678.'],
			]);
			assert.deepStrictEqual(sync({ report: '', issues: [issue(9, 'CLOSED')] }).calls, []);
			assert.deepStrictEqual(sync({ report: '', issues: [] }).calls, []);
		});
	});
});
