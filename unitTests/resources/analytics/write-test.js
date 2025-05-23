require('../../test_utils');
const chai = require('chai');
const expect = chai.expect;
const { diffResourceUsage, calculateCPUUtilization } = require('../../../resources/analytics/write');

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
			// Node returns microseconds for these values but diffResourceUsage normalizes them
			userCPUTime: 1000000,
			systemCPUTime: 2000000,
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
			// Node returns microseconds for these values but diffResourceUsage normalizes them
			userCPUTime: 1000000,
			systemCPUTime: 2000000,
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
		})
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
