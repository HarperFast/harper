const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const outputDirectory = process.env.FULLTEXT_QUALIFICATION_OUTPUT;
assert(
	outputDirectory && path.isAbsolute(outputDirectory),
	'FULLTEXT_QUALIFICATION_OUTPUT must name a new absolute output directory'
);
fs.mkdirSync(outputDirectory, { recursive: false });
const repository = path.resolve(__dirname, '..');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const cells = [];
for (const width of [1, 32])
	for (const concurrency of [1, 4]) for (const writes of [0, 10]) cells.push({ width, concurrency, writes });
const relevanceControl = process.env.FULLTEXT_QUALIFICATION_RELEVANCE_CONTROL === '1';
const matrix = relevanceControl ? [0, 10].map((writes) => ({ width: 0, concurrency: 1, writes })) : cells;
const selected = process.env.FULLTEXT_QUALIFICATION_SMOKE === '1' ? matrix.slice(0, 1) : matrix;
const harnessSha256 = Object.fromEntries(
	['fulltext-qualification.cjs', 'run-fulltext-qualification.cjs'].map((file) => [
		file,
		createHash('sha256')
			.update(fs.readFileSync(path.join(__dirname, file)))
			.digest('hex'),
	])
);
const reports = [];
for (const cell of selected) {
	const name = `sort-${cell.width}-queries-${cell.concurrency}-writes-${cell.writes}`,
		output = path.join(outputDirectory, `${name}.json`);
	const child = spawnSync(
		process.execPath,
		[
			'--conditions=typestrip',
			path.join(repository, 'node_modules/mocha/bin/mocha.js'),
			'benchmarks/fulltext-qualification.cjs',
		],
		{
			cwd: repository,
			env: {
				...process.env,
				FULLTEXT_QUALIFICATION_WIDTH: String(cell.width),
				FULLTEXT_QUALIFICATION_CONCURRENCY: String(cell.concurrency),
				FULLTEXT_QUALIFICATION_WRITES: String(cell.writes),
				FULLTEXT_QUALIFICATION_CELL_REPORT: output,
			},
			encoding: 'utf8',
			timeout: Number(process.env.FULLTEXT_QUALIFICATION_DURATION_MS || 60000) + 180000,
			maxBuffer: 10 * 1024 * 1024,
		}
	);
	fs.writeFileSync(path.join(outputDirectory, `${name}.log`), `${child.stdout || ''}${child.stderr || ''}`);
	assert.ifError(child.error);
	assert.strictEqual(child.status, 0, `${name} failed; inspect its log`);
	reports.push(JSON.parse(fs.readFileSync(output, 'utf8')));
	console.log(`${name}: ${reports.at(-1).query.operationsPerSecond.toFixed(2)} queries/s`);
}
fs.writeFileSync(
	path.join(outputDirectory, 'report.json'),
	JSON.stringify(
		{ commit, harnessSha256, complete: true, relevanceControl, smoke: selected.length === 1, cells: reports },
		null,
		2
	) + '\n',
	{ flag: 'wx' }
);
