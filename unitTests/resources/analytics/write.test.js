const chai = require('chai');
const expect = chai.expect;
const { diffResourceUsage, calculateCPUUtilization, getDirectorySizeAsync } = require('#src/resources/analytics/write');
const { writeFile, mkdtemp, rm, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

describe('diffResourceUsage', () => {
	it('diffs all counters', () => {
		const lastResourceUsage = {
			userCPUTime: 100,
			systemCPUTime: 200,
			minorPageFault: 300,
			majorPageFault: 400,
			fsRead: 500,
			fsWrite: 600,
			voluntaryContextSwitches: 700,
			involuntaryContextSwitches: 800,
		};

		const resourceUsage = {
			userCPUTime: 1000,
			systemCPUTime: 2000,
			minorPageFault: 3000,
			majorPageFault: 4000,
			fsRead: 5000,
			fsWrite: 6000,
			voluntaryContextSwitches: 7000,
			involuntaryContextSwitches: 8000,
		};

		const diffed = diffResourceUsage(lastResourceUsage, resourceUsage);

		expect(diffed).to.deep.equal({
			userCPUTime: 900,
			systemCPUTime: 1800,
			minorPageFault: 2700,
			majorPageFault: 3600,
			fsRead: 4500,
			fsWrite: 5400,
			voluntaryContextSwitches: 6300,
			involuntaryContextSwitches: 7200,
		});
	});

	it('treats missing params as zeroes', () => {
		const resourceUsage = {
			userCPUTime: 1000,
			systemCPUTime: 2000,
			minorPageFault: 3000,
			majorPageFault: 4000,
			fsRead: 5000,
			fsWrite: 6000,
			voluntaryContextSwitches: 7000,
			involuntaryContextSwitches: 8000,
		};

		const diffed = diffResourceUsage({}, resourceUsage);

		expect(diffed).to.deep.equal({
			...resourceUsage,
			userCPUTime: 1000,
			systemCPUTime: 2000,
		});
	});
});

describe('getDirectorySizeAsync', () => {
	let tmpDir;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'harper-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('sums file sizes in a flat directory', async () => {
		await writeFile(join(tmpDir, 'a.txt'), 'hello'); // 5 bytes
		await writeFile(join(tmpDir, 'b.txt'), 'world!'); // 6 bytes
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(11);
	});

	it('recurses into subdirectories', async () => {
		const sub = join(tmpDir, 'sub');
		await mkdir(sub);
		await writeFile(join(tmpDir, 'root.txt'), 'aaa'); // 3 bytes
		await writeFile(join(sub, 'nested.txt'), 'bbbbb'); // 5 bytes
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(8);
	});

	it('returns 0 for an empty directory', async () => {
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(0);
	});

	it('returns 0 for a nonexistent path', async () => {
		const size = await getDirectorySizeAsync(join(tmpDir, 'nope'));
		expect(size).to.equal(0);
	});
});

describe('calculateCPUUtilization', () => {
	it('computes utilization based on user + system over period', () => {
		const ru = {
			userCPUTime: 10000,
			systemCPUTime: 20000,
		};

		const cpuUtilization = calculateCPUUtilization(ru, 60000);

		expect(cpuUtilization).to.equal(0.5);
	});
});
