import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseOptions, printHelp, cellEnvironment, formatResult } from './fulltext-options.mts';
const options = parseOptions('concurrency');
if (options.help) {
	printHelp('concurrency');
	process.exit(0);
}
const outputDirectory = options.output;
fs.mkdirSync(outputDirectory, { mode: 0o700 });
const repository = path.resolve(import.meta.dirname, '..');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const selected = [];
for (const width of options.relevanceControl ? [0] : options.widths)
	for (const concurrency of options.clients)
		for (const writes of options.writes) selected.push({ width, concurrency, writes });
const harnessSha256 = Object.fromEntries(
	['fulltext-qualification.cjs', 'run-fulltext-qualification.mts', 'fulltext-options.mts'].map((file) => [
		file,
		createHash('sha256')
			.update(fs.readFileSync(path.join(import.meta.dirname, file)))
			.digest('hex'),
	])
);
const reports = [];
for (const cell of selected) {
	const name = `sort-${cell.width}-queries-${cell.concurrency}-writes-${cell.writes}`,
		output = path.join(outputDirectory, `${name}.json`);
	const child = spawnSync(
		process.execPath,
		[path.join(repository, 'node_modules/mocha/bin/mocha.js'), 'benchmarks/fulltext-qualification.cjs'],
		{
			cwd: repository,
			env: cellEnvironment(options, { ...cell, output }),
			encoding: 'utf8',
			timeout: options.duration + 180000,
			killSignal: 'SIGKILL',
			maxBuffer: 10 * 1024 * 1024,
		}
	);
	fs.writeFileSync(path.join(outputDirectory, `${name}.log`), `${child.stdout || ''}${child.stderr || ''}`);
	assert.ifError(child.error);
	assert.strictEqual(child.status, 0, `${name} failed; inspect its log`);
	reports.push(JSON.parse(fs.readFileSync(output, 'utf8')));
	const report = reports.at(-1);
	console.log(
		formatResult('FULLTEXT_CONCURRENCY_RESULT', {
			scale: options.scale,
			clauses: cell.width,
			clients: cell.concurrency,
			writes_per_sec: cell.writes,
			duration_ms: options.duration,
			freshness: options.freshness,
			samples: report.query.samples.length,
			query_ops: report.query.operationsPerSecond,
			write_ops: report.writes.operationsPerSecond,
			p95_ms: report.query.p95Milliseconds,
		})
	);
}
fs.writeFileSync(
	path.join(outputDirectory, 'report.json'),
	JSON.stringify({ commit, harnessSha256, options, complete: true, cells: reports }, null, 2) + '\n',
	{ flag: 'wx' }
);

console.log(`Reports: ${outputDirectory}`);
