import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { duration: 70_000, indexes: 4, pairs: 2, interval: 60_000, maxIndexLag: 0, output: undefined };
const bounds = {
	duration: [100, 3_600_000],
	indexes: [1, 16],
	pairs: [1, 10],
	interval: [1000, 2_147_483_647],
	maxIndexLag: [0, 60_000],
};
for (let i = 2; i < process.argv.length; i += 2) {
	if (!process.argv[i].startsWith('--')) throw new Error('Benchmark options must use --name value');
	const name = process.argv[i].slice(2);
	const value = process.argv[i + 1];
	if (!Object.hasOwn(options, name) || value === undefined)
		throw new Error(
			'Use --duration milliseconds --indexes 1..16 --pairs 1..10 --interval milliseconds --maxIndexLag milliseconds --output directory'
		);
	if (name === 'output') options.output = resolve(value);
	else {
		const number = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < bounds[name][0] || number > bounds[name][1])
			throw new Error(`Invalid --${name}: expected integer ${bounds[name].join('..')}`);
		options[name] = number;
	}
}
if (!options.output) throw new Error('An explicit --output directory is required');
if (existsSync(options.output) && readdirSync(options.output).length)
	throw new Error('Use a fresh or empty --output directory to preserve prior qualification evidence');
mkdirSync(options.output, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const source = {
	head: git('rev-parse', 'HEAD'),
	dirty: Boolean(git('status', '--porcelain')),
	trackedDiffSha256: await trackedDiffFingerprint(),
};
async function trackedDiffFingerprint() {
	const hash = createHash('sha256');
	const child = spawn('git', ['diff', 'HEAD', '--', '.'], { cwd: repository, stdio: ['ignore', 'pipe', 'inherit'] });
	const completed = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Git fingerprint failed: ${signal ?? code}`));
		});
	});
	child.stdout.pipe(hash);
	await completed;
	return hash.digest('hex');
}

const fingerprintFiles = [
	'benchmarks/fulltext-analytics.mjs',
	'benchmarks/fulltext-analytics.bench.js',
	'resources/analytics/fullTextTelemetry.ts',
	'resources/analytics/fullTextTelemetryRuntime.ts',
	'config/fullTextTelemetryConfiguration.ts',
	'dist/resources/analytics/fullTextTelemetry.js',
	'dist/resources/analytics/fullTextTelemetryRuntime.js',
	'dist/resources/analytics/write.js',
	'dist/resources/indexes/fullTextNativeBinding.js',
];
source.fileSha256 = Object.fromEntries(
	fingerprintFiles.map((file) => [
		file,
		createHash('sha256')
			.update(readFileSync(join(repository, file)))
			.digest('hex'),
	])
);
writeFileSync(
	join(options.output, 'manifest.json'),
	JSON.stringify(
		{ options, source, node: process.version, platform: process.platform, architecture: process.arch },
		null,
		2
	)
);

async function spawnMocha(profile, pair) {
	const directory = join(options.output, `pair-${pair}-${profile}`);
	mkdirSync(directory, { recursive: true });
	const configuration = { ...options, profile, pair, output: directory, source };
	writeFileSync(join(directory, 'manifest.json'), JSON.stringify(configuration, null, 2));
	const log = createWriteStream(join(directory, 'child.log'));
	const childEnv = {
		...process.env,
		FULLTEXT_ANALYTICS_BENCHMARK: JSON.stringify(configuration),
		HARPER_STORAGE_ENGINE: 'rocksdb',
	};
	for (const key of ['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG']) delete childEnv[key];
	const child = spawn(
		process.execPath,
		[
			join(repository, 'node_modules/mocha/bin/mocha.js'),
			'benchmarks/fulltext-analytics.bench.js',
			'--timeout',
			String(options.duration + 120_000),
			'--forbid-pending',
			'--fail-zero',
		],
		{ cwd: repository, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const MAX_LOG_BYTES = 2 * 1024 * 1024;
	let logBytes = 0;
	let droppedLogBytes = 0;
	let logError;
	log.once('error', (error) => {
		logError = error.code ?? error.message;
		child.kill('SIGTERM');
	});
	function capture(chunk) {
		const retained = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - logBytes));
		if (retained.length && !log.destroyed) log.write(retained);
		logBytes += retained.length;
		droppedLogBytes += chunk.length - retained.length;
	}
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	let timedOut = false;
	let killTimer;
	let spawnError;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
		killTimer = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
	}, options.duration + 120_000);
	const result = await new Promise((resolveChild) => {
		child.on('error', (error) => {
			spawnError ??= error.message;
		});
		child.once('close', (code, signal) => resolveChild({ code, signal, spawnError }));
	}).finally(() => {
		clearTimeout(timer);
		clearTimeout(killTimer);
	});
	await new Promise((resolveLog) => (log.destroyed ? resolveLog() : log.end(resolveLog)));
	writeFileSync(
		join(directory, 'launcher-result.json'),
		JSON.stringify(
			{ ...result, timedOut, logError, logBytes, droppedLogBytes, maximumLogBytes: MAX_LOG_BYTES },
			null,
			2
		)
	);
	if (result.code !== 0 || spawnError || timedOut || logError || !existsSync(join(directory, 'result.json')))
		throw new Error(`${profile} pair ${pair} failed; retained ${directory}`);
	return JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
}

const results = [];
for (let pair = 1; pair <= options.pairs; pair++) {
	const profiles = pair % 2 ? ['disabled', 'enabled'] : ['enabled', 'disabled'];
	for (const profile of profiles) {
		process.stdout.write(`Pair ${pair}/${options.pairs}: ${profile}\n`);
		results.push(await spawnMocha(profile, pair));
		writeFileSync(join(options.output, 'results.json'), JSON.stringify(results, null, 2));
	}
}
const comparisons = Array.from({ length: options.pairs }, (_, index) => {
	const disabled = results.find((result) => result.pair === index + 1 && result.profile === 'disabled');
	const enabled = results.find((result) => result.pair === index + 1 && result.profile === 'enabled');
	return {
		pair: index + 1,
		throughputRatioEnabledToDisabled: enabled.queriesPerSecond / disabled.queriesPerSecond,
		p99RatioEnabledToDisabled: enabled.latencyMilliseconds.p99 / disabled.latencyMilliseconds.p99,
		cpuMicrosecondsPerQueryDisabled: (disabled.cpu.user + disabled.cpu.system) / disabled.correctQueries,
		cpuMicrosecondsPerQueryEnabled: (enabled.cpu.user + enabled.cpu.system) / enabled.correctQueries,
		enabledExportedRows: enabled.fullTextRowsExported,
		qualificationSufficient: enabled.qualificationSufficient && disabled.qualificationSufficient,
	};
});
writeFileSync(join(options.output, 'comparison.json'), JSON.stringify(comparisons, null, 2));
process.stdout.write(`${JSON.stringify(comparisons, null, 2)}\nArtifacts: ${options.output}\n`);
