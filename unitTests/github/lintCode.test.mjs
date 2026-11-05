import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/lint-code.yaml'), 'utf8'));
const step = workflow.jobs.runLinter.steps.find((candidate) => candidate.name === 'Check design docs');
const BEFORE = '0123456789abcdef0123456789abcdef01234567';

describe('lint-code.yaml design-docs step', function () {
	let dir;
	beforeEach(function () {
		dir = mkdtempSync(join(tmpdir(), 'lint-code-'));
		for (const command of ['npm', 'git']) {
			const stub = join(dir, command);
			writeFileSync(stub, `#!/bin/sh\necho "${command} $*" >> "${join(dir, 'calls')}"\n`);
			chmodSync(stub, 0o755);
		}
	});
	afterEach(function () {
		rmSync(dir, { recursive: true, force: true });
	});

	// Runs the step the way GitHub runs a `run:` with no `shell:` on Linux: `bash -e {0}`.
	const callsFor = (env) => {
		const script = join(dir, 'step.sh');
		writeFileSync(script, step.run);
		const result = spawnSync('bash', ['--noprofile', '--norc', '-e', script], {
			cwd: dir,
			env: { PATH: `${dir}${delimiter}${process.env.PATH}`, ...env },
			encoding: 'utf8',
			timeout: 60_000,
		});
		assert.strictEqual(result.status, 0, result.stderr);
		return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
	};

	it('compares a pull request with its base and holds it to the floor rule', function () {
		assert.deepStrictEqual(callsFor({ EVENT: 'pull_request', BEFORE: '' }), [
			'npm run check:design-docs -- --base HEAD^1',
		]);
	});

	it('compares a push with the tip it replaced and skips the floor rule', function () {
		assert.deepStrictEqual(callsFor({ EVENT: 'push', BEFORE }), [
			`git fetch --no-tags --depth=1 origin ${BEFORE}`,
			`npm run check:design-docs -- --base ${BEFORE} --push`,
		]);
	});

	it('checks the tree alone for a new branch and a scheduled run', function () {
		assert.deepStrictEqual(callsFor({ EVENT: 'push', BEFORE: '0'.repeat(40) }), ['npm run check:design-docs --']);
		rmSync(join(dir, 'calls'));
		assert.deepStrictEqual(callsFor({ EVENT: 'schedule', BEFORE: '' }), ['npm run check:design-docs --']);
	});
});
