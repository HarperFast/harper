import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { constants } from 'node:os';
import { partitionSuites } from './typeStripSuites.mts';

const require = createRequire(import.meta.url);
const { loadOptions } = require('mocha/lib/cli/options.cjs');
const collectFiles = require('mocha/lib/cli/collect-files.cjs');
const args = process.argv.slice(2);
if (args.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg)))
	process.exit(
		spawnSync(process.execPath, [require.resolve('mocha/bin/mocha.js'), ...args], { stdio: 'inherit', timeout: 30000 })
			.status ?? 1
	);
const sourceOnly = args.includes('--source-only');
const list = args.includes('--list');
const options = loadOptions(args.filter((arg) => arg !== '--source-only' && arg !== '--list'));
options.ignore ??= [];
if (options.watch) throw new Error('Use ordinary mocha for watch mode; this launcher runs a fixed selection.');
if (options.parallel)
	throw new Error('Use ordinary mocha for parallel mode; this launcher records each lane in one process.');
if (!options._.length) {
	options._ = ['unitTests/**/*test.*js'];
	options.ignore.push('unitTests/apiTests/**/*', 'unitTests/dataLayer/harperBridge/**/*', 'unitTests/resources/**/*');
}
const { files, unmatchedFiles }: { files: string[]; unmatchedFiles: unknown[] } = collectFiles({
	...options,
	spec: options._,
	file: options.file || [],
});
if (unmatchedFiles.length) throw new Error(`Missing --file inputs: ${JSON.stringify(unmatchedFiles)}`);
const lanes = partitionSuites(files);
if (sourceOnly && options.file?.some((file: string) => lanes.compiled.includes(resolve(file))))
	throw new Error('Compiled --file setup cannot run in a source-only selection; use ordinary mocha.');
if (!sourceOnly && options.file?.length && lanes.compiled.length) {
	lanes.compiled = [...new Set(files)];
	lanes.source = [];
}
if (list) {
	console.log(JSON.stringify(lanes, null, 2));
} else {
	const selected: [string, string[]][] = sourceOnly ? [['source', lanes.source]] : Object.entries(lanes);
	if (!selected.some(([, paths]) => paths.length))
		throw new Error('No source-compatible files selected; use ordinary mocha for compiled suites.');
	if (selected.some(([mode, paths]) => mode === 'compiled' && paths.length)) {
		if (require.resolve('#src/utility/hdbTerms').endsWith('.ts'))
			throw new Error('Unset the ambient typestrip condition; the launcher selects the runtime for each lane.');
		try {
			require.resolve('#js/utility/hdbTerms');
		} catch {
			throw new Error('The compiled lane needs a build. Run npm run build, or select --source-only.');
		}
		if (
			selected.filter(([, paths]) => paths.length).length > 1 &&
			options['reporter-option']?.some((option) => /^(?:output|reporterOutput)=/.test(option))
		)
			throw new Error('Run lanes separately when writing reporter output files.');
	}
	const root = resolve('unitTests/envDir');
	mkdirSync(root, { recursive: true });
	const directory = mkdtempSync(join(root, 'runtime-'));
	let interrupted: NodeJS.Signals | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	const forward = (signal: NodeJS.Signals) => {
		interrupted = signal;
		child?.kill(signal);
	};
	const onTerm = () => forward('SIGTERM');
	const onHangup = () => forward('SIGHUP');
	const onInterrupt = () => forward('SIGINT');
	process.on('SIGTERM', onTerm);
	process.on('SIGHUP', onHangup);
	process.on('SIGINT', onInterrupt);
	try {
		let total = 0;
		for (const [mode, paths] of selected) {
			if (!paths.length || interrupted) continue;
			console.log(`Unit runtime: ${mode}, ${paths.length} files`);
			const config = join(directory, `${mode}.json`);
			const results = join(directory, `${mode}-results.json`);
			const resolvedOptions = {
				...options,
				'_': undefined,
				'spec': paths,
				'file': undefined,
				'fail-zero': false,
				'node-option': options['node-option']?.filter((option) => option !== 'conditions=typestrip'),
			};
			writeFileSync(config, JSON.stringify(resolvedOptions));
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HARPER_UNIT_RESULTS: results,
				HARPER_UNIT_SELECTION_CONFIG: config,
			};
			delete env.MOCHA_OPTIONS;
			if (mode === 'source') env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --conditions=typestrip`.trim();
			// Mocha's --timeout and the enclosing CI/test invocation own execution deadlines.
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
				child = spawn(process.execPath, [require.resolve('mocha/bin/mocha.js'), '--config', config, '--no-package'], {
					stdio: 'inherit',
					env,
				});
				child.once('error', reject);
				child.once('close', (code, signal) => done({ code, signal }));
			});
			child = undefined;
			if (result.signal || result.code === null) {
				process.exitCode = 1;
				break;
			}
			if (result.code) process.exitCode = result.code;
			try {
				const data = JSON.parse(readFileSync(results, 'utf8'));
				total += data.total;
				const missing = paths.filter((file) => !data.files.includes(file));
				if (missing.length) throw new Error(`Selected files did not execute: ${missing.join(', ')}`);
			} catch (error) {
				console.error(`Unit runtime ${mode} did not complete Mocha: ${error.message}`);
				process.exitCode = 1;
			}
		}
		if (options['fail-zero'] && !total) process.exitCode = 1;
		if (interrupted) process.exitCode = 128 + constants.signals[interrupted];
	} finally {
		process.off('SIGTERM', onTerm);
		process.off('SIGHUP', onHangup);
		process.off('SIGINT', onInterrupt);
		rmSync(directory, { recursive: true, force: true });
	}
}
