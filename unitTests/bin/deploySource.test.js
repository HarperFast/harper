'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { declaredDeploySource } = require('#src/bin/deploySource');

describe('what a deploy declares about where it came from (harper#3061)', () => {
	let checkout;
	const git = (...args) =>
		execFileSync(
			'git',
			['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
			{ cwd: checkout, encoding: 'utf8' }
		).trim();

	before(() => {
		checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-source-'));
		git('init', '-q');
		fs.writeFileSync(path.join(checkout, 'config.yaml'), 'rest: true\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
	});
	after(() => checkout && fs.rmSync(checkout, { recursive: true, force: true }));

	it("names a directory deploy's commit, and whether the tree had changes it does not hold", () => {
		assert.deepStrictEqual(declaredDeploySource({ directory: checkout }, {}), {
			sha: git('rev-parse', 'HEAD'),
			dirty: false,
		});
		fs.writeFileSync(path.join(checkout, 'resources.js'), '');
		try {
			assert.strictEqual(declaredDeploySource({ directory: checkout }, {}).dirty, true);
		} finally {
			fs.rmSync(path.join(checkout, 'resources.js'));
		}
	});

	it('names the GitHub Actions run, and the checkout commit over GITHUB_SHA', () => {
		const env = {
			GITHUB_ACTIONS: 'true',
			GITHUB_REPOSITORY: 'HarperFast/my-app',
			GITHUB_SHA: 'f'.repeat(40),
			GITHUB_REF: 'refs/heads/main',
			GITHUB_WORKFLOW_REF: 'HarperFast/my-app/.github/workflows/deploy.yaml@refs/heads/main',
			GITHUB_RUN_ID: '99',
			GITHUB_RUN_ATTEMPT: '1',
			GITHUB_ACTOR: 'octocat',
		};
		assert.deepStrictEqual(declaredDeploySource({}, env), {
			repository: 'HarperFast/my-app',
			sha: 'f'.repeat(40),
			ref: 'refs/heads/main',
			workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yaml@refs/heads/main',
			run_id: '99',
			run_attempt: '1',
			actor: 'octocat',
		});
		assert.strictEqual(declaredDeploySource({ directory: checkout }, env).sha, git('rev-parse', 'HEAD'));
	});

	it('declares nothing outside a checkout and outside CI', () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-source-none-'));
		try {
			assert.strictEqual(declaredDeploySource({ directory: outside }, {}), undefined);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
