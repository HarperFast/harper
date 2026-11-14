import assert from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseOptions, printHelp, formatResult } from './fulltext-options.mts';
const options = parseOptions('cost');
if (options.help) {
	printHelp('cost');
	process.exit(0);
}
mkdirSync(options.output, { mode: 0o700 });
const repository = resolve(import.meta.dirname, '..');
const reportPath = resolve(options.output, 'native.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const harnessSha256 = Object.fromEntries(
	['fulltext-sort-cost.cjs', 'run-fulltext-sort-cost.mts', 'fulltext-options.mts'].map((name) => [
		name,
		createHash('sha256')
			.update(readFileSync(resolve(import.meta.dirname, name)))
			.digest('hex'),
	])
);
const child = spawnSync(
	process.execPath,
	[resolve(repository, 'node_modules/mocha/bin/mocha.js'), 'benchmarks/fulltext-sort-cost.cjs'],
	{
		cwd: repository,
		env: {
			...process.env,
			FULLTEXT_SORT_COST_REPORT: reportPath,
			FULLTEXT_COST_WARMUPS: String(options.warmups),
			FULLTEXT_COST_SAMPLES: String(options.samples),
		},
		encoding: 'utf8',
		timeout: 300000,
		killSignal: 'SIGKILL',
		maxBuffer: 10 * 1024 * 1024,
	}
);
writeFileSync(resolve(options.output, 'run.log'), `${child.stdout || ''}${child.stderr || ''}`);
assert.ifError(child.error);
assert.strictEqual(
	child.status,
	0,
	`Native cost failed (${child.signal || child.status}); inspect ${options.output}/run.log`
);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
report.options = options;
report.commit = commit;
report.harnessSha256 = harnessSha256;
writeFileSync(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
for (const cell of report.nativeQueryCases)
	console.log(
		formatResult('FULLTEXT_NATIVE_COST_RESULT', {
			scale: options.scale,
			case: cell.name,
			rows: report.native.rows,
			samples: cell.milliseconds.length,
			p50_ms: cell.p50Milliseconds,
			p95_ms: cell.p95Milliseconds,
			max_ms: cell.maxMilliseconds,
		})
	);
console.log(`Reports: ${options.output}`);
