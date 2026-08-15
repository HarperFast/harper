import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'build-tools/check-shrinkwrap-pins.mjs');
const dependencies = ['@harperfast/rocksdb-js', 'fastify', '@aws-sdk/client-s3'];

describe('shrinkwrap pin canaries', function () {
	it('does not query exact versions while a ranged canary still discriminates', async function () {
		const fixture = await createFixture({
			'@harperfast/rocksdb-js': '2.7.1',
			'fastify': '^5.8.2',
			'@aws-sdk/client-s3': '^3.1012.0',
		});
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			const queries = await readFile(fixture.queryLog, 'utf8');
			assert.doesNotMatch(queries, /@harperfast\/rocksdb-js/);
			assert.match(queries, /@aws-sdk\/client-s3@\^3\.1012\.0/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('still compares exact pins with the installed dependency', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{ '@harperfast/rocksdb-js': '1.0.1' }
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /@harperfast\/rocksdb-js resolved to 1\.0\.1 but the packed shrinkwrap pins 1\.0\.0/);
			assert.doesNotMatch(await readFile(fixture.queryLog, 'utf8'), /@harperfast\/rocksdb-js/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails when every canary has an exact manifest version', async function () {
		const fixture = await createFixture(Object.fromEntries(dependencies.map((dependency) => [dependency, '1.0.0'])));
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /every checked canary has an exact declared version/);
			assert.strictEqual(await readFile(fixture.queryLog, 'utf8'), '');
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails when every ranged canary is pinned at its max-in-range version', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{},
			true
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(
				result.stderr,
				/every checked canary \(fastify, @aws-sdk\/client-s3\) is now pinned at the latest version/
			);
		} finally {
			await fixture.cleanup();
		}
	});

	it('warns when a registry failure leaves no discriminating ranged canary to verify', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{},
			true,
			'@aws-sdk/client-s3@^3.1012.0'
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /could not verify every ranged canary still discriminates/);
		} finally {
			await fixture.cleanup();
		}
	});
});

async function createFixture(
	manifestDependencies,
	installedVersions = {},
	allRangeVersionsCurrent = false,
	failedRange = ''
) {
	const tempDir = await mkdtemp(join(tmpdir(), 'harper-shrinkwrap-canary-'));
	const packageRoot = join(tempDir, 'package');
	const binDir = join(tempDir, 'bin');
	const queryLog = join(tempDir, 'queries.log');
	await mkdir(packageRoot, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(queryLog, '');
	await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ dependencies: manifestDependencies }));
	await writeFile(
		join(packageRoot, 'npm-shrinkwrap.packed.json'),
		JSON.stringify({
			lockfileVersion: 3,
			packages: Object.fromEntries(
				dependencies.map((dependency) => [`node_modules/${dependency}`, { version: '1.0.0' }])
			),
		})
	);
	for (const dependency of dependencies) {
		const dependencyDir = join(packageRoot, 'node_modules', dependency);
		await mkdir(dependencyDir, { recursive: true });
		await writeFile(
			join(dependencyDir, 'package.json'),
			JSON.stringify({ version: installedVersions[dependency] ?? '1.0.0' })
		);
	}
	await writeFile(
		join(binDir, 'npm'),
		`#!/bin/sh
printf '%s\\n' "$2" >> "$QUERY_LOG"
if [ "$FAILED_RANGE" = "$2" ]; then
  exit 1
fi
if [ "$ALL_RANGE_VERSIONS_CURRENT" = 1 ]; then
  printf '["1.0.0"]\\n'
  exit
fi
case "$2" in
  fastify@\^5.8.2) printf '["1.0.0"]\\n' ;;
  @aws-sdk/client-s3@\^3.1012.0) printf '["1.0.0", "1.0.1"]\\n' ;;
  *) exit 1 ;;
esac
`
	);
	await chmod(join(binDir, 'npm'), 0o755);
	return {
		binDir,
		packageRoot,
		queryLog,
		allRangeVersionsCurrent,
		failedRange,
		cleanup: () => rm(tempDir, { recursive: true, force: true }),
	};
}

function runCheck(fixture) {
	return spawnSync(process.execPath, [script, fixture.packageRoot], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fixture.binDir}:${process.env.PATH}`,
			QUERY_LOG: fixture.queryLog,
			ALL_RANGE_VERSIONS_CURRENT: fixture.allRangeVersionsCurrent ? '1' : '0',
			FAILED_RANGE: fixture.failedRange,
		},
	});
}
