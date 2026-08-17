import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'build-tools/check-shrinkwrap-pins.mjs');
const dependencies = ['@harperfast/rocksdb-js', 'fastify', '@aws-sdk/client-s3'];
const alignedDependencies = {
	'@harperfast/extended-iterable': '1.0.3',
	'msgpackr': '2.0.5',
};

describe('shrinkwrap pin canaries', function () {
	it('keeps the checked canaries present and ranged in the real manifest', async function () {
		const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
		const fixture = await createFixture(manifest.dependencies);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails when a root encoder pin diverges from rocksdb-js', async function () {
		const fixture = await createFixture({
			'@harperfast/rocksdb-js': '2.7.1',
			'fastify': '^5.8.2',
			'@aws-sdk/client-s3': '^3.1012.0',
		});
		try {
			await writeFile(
				join(fixture.packageRoot, 'node_modules/@harperfast/rocksdb-js/package.json'),
				JSON.stringify({
					version: '1.0.0',
					dependencies: { ...alignedDependencies, msgpackr: '2.0.6' },
				})
			);
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /root msgpackr pin 2\.0\.5 does not match rocksdb-js 2\.0\.6/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails when a root encoder spec is not exact', async function () {
		const fixture = await createFixture({
			'@harperfast/rocksdb-js': '2.7.1',
			'fastify': '^5.8.2',
			'@aws-sdk/client-s3': '^3.1012.0',
			'msgpackr': '^2.0.5',
		});
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /root msgpackr spec must be exact, received \^2\.0\.5/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails when rocksdb-js installs a nested encoder instance', async function () {
		const fixture = await createFixture({
			'@harperfast/rocksdb-js': '2.7.1',
			'fastify': '^5.8.2',
			'@aws-sdk/client-s3': '^3.1012.0',
		});
		try {
			const nestedDir = join(fixture.packageRoot, 'node_modules/@harperfast/rocksdb-js/node_modules/msgpackr');
			await mkdir(nestedDir, { recursive: true });
			await writeFile(join(nestedDir, 'package.json'), JSON.stringify({ version: '2.0.5' }));
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /rocksdb-js loaded a nested msgpackr@2\.0\.5/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('does not misdiagnose an empty checked set as all-exact', async function () {
		const fixture = await createFixture({});
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.doesNotMatch(result.stderr, /every checked canary has an exact declared version/);
		} finally {
			await fixture.cleanup();
		}
	});

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

	it('retries a transient registry failure before evaluating the canary set', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{},
			false,
			'@aws-sdk/client-s3@^3.1012.0',
			1
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /registry query attempt 1\/3 failed/);
			const queries = (await readFile(fixture.queryLog, 'utf8')).split('\n');
			assert.strictEqual(queries.filter((query) => query === '@aws-sdk/client-s3@^3.1012.0').length, 2);
		} finally {
			await fixture.cleanup();
		}
	});

	it('accepts a proven canary after another registry query exhausts its retries', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{},
			false,
			'fastify@^5.8.2'
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			const queries = (await readFile(fixture.queryLog, 'utf8')).split('\n');
			assert.strictEqual(queries.filter((query) => query === 'fastify@^5.8.2').length, 3);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails with a retry-specific error when registry failures leave no proven canary', async function () {
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
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /::error title=Retry dependency canary check::/);
			assert.match(result.stderr, /after 3 registry query attempts/);
			assert.match(result.stderr, /Retry this job/);
			assert.match(result.stderr, /confirm the listed package ranges match published versions/);
			const queries = (await readFile(fixture.queryLog, 'utf8')).split('\n');
			assert.strictEqual(queries.filter((query) => query === '@aws-sdk/client-s3@^3.1012.0').length, 3);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails without retries when a registry query matches no published version', async function () {
		const fixture = await createFixture(
			{
				'@harperfast/rocksdb-js': '2.7.1',
				'fastify': '^5.8.2',
				'@aws-sdk/client-s3': '^3.1012.0',
			},
			{},
			false,
			'',
			3,
			'@aws-sdk/client-s3@^3.1012.0'
		);
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /matches no published version/);
			const queries = (await readFile(fixture.queryLog, 'utf8')).split('\n');
			assert.strictEqual(queries.filter((query) => query === '@aws-sdk/client-s3@^3.1012.0').length, 1);
		} finally {
			await fixture.cleanup();
		}
	});
});

async function createFixture(
	manifestDependencies,
	installedVersions = {},
	allRangeVersionsCurrent = false,
	failedRange = '',
	failedAttempts = 3,
	emptyRange = ''
) {
	const tempDir = await mkdtemp(join(tmpdir(), 'harper-shrinkwrap-canary-'));
	const packageRoot = join(tempDir, 'package');
	const binDir = join(tempDir, 'bin');
	const queryLog = join(tempDir, 'queries.log');
	await mkdir(packageRoot, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(queryLog, '');
	const packageDependencies = { ...alignedDependencies, ...manifestDependencies };
	await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ dependencies: packageDependencies }));
	await writeFile(
		join(packageRoot, 'npm-shrinkwrap.packed.json'),
		JSON.stringify({
			lockfileVersion: 3,
			packages: Object.fromEntries(
				dependencies.map((dependency) => [`node_modules/${dependency}`, { version: '1.0.0' }])
			),
		})
	);
	for (const dependency of [...dependencies, ...Object.keys(alignedDependencies)]) {
		const dependencyDir = join(packageRoot, 'node_modules', dependency);
		await mkdir(dependencyDir, { recursive: true });
		const dependencyManifest = {
			version:
				installedVersions[dependency] ??
				(dependency in alignedDependencies ? packageDependencies[dependency] : '1.0.0'),
		};
		if (dependency === '@harperfast/rocksdb-js') {
			dependencyManifest.dependencies = Object.fromEntries(
				Object.keys(alignedDependencies).map((dep) => [dep, packageDependencies[dep]])
			);
		}
		await writeFile(join(dependencyDir, 'package.json'), JSON.stringify(dependencyManifest));
	}
	await writeFile(
		join(binDir, 'npm'),
		`#!/bin/sh
printf '%s\\n' "$2" >> "$QUERY_LOG"
attempt=$(grep -Fxc "$2" "$QUERY_LOG")
if [ "$FAILED_RANGE" = "$2" ] && [ "$attempt" -le "$FAILED_ATTEMPTS" ]; then
  exit 1
fi
if [ "$EMPTY_RANGE" = "$2" ]; then
  printf '[]\\n'
  exit
fi
if [ "$ALL_RANGE_VERSIONS_CURRENT" = 1 ]; then
  printf '["1.0.0"]\\n'
  exit
fi
case "$2" in
  fastify@*) printf '["1.0.0"]\\n' ;;
  @aws-sdk/client-s3@*) printf '["1.0.0", "1.0.1"]\\n' ;;
  *) printf 'stub npm: unmodelled query %s\\n' "$2" >&2; exit 1 ;;
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
		failedAttempts,
		emptyRange,
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
			FAILED_ATTEMPTS: String(fixture.failedAttempts),
			EMPTY_RANGE: fixture.emptyRange,
		},
	});
}
