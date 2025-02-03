require('../test_utils');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const { CachedResourceUsage, CPUMetrics } = require('../../resources/analytics');

describe('analytics', () => {
	describe('CachedResourceUsage', () => {
		let cru;
		beforeEach(() => {
			cru = new CachedResourceUsage(0);
		});

		afterEach(() => {
			sinon.restore();
		});

		describe('page faults', () => {
			it('diffs page faults between refreshes', () => {
				sinon.stub(process, 'resourceUsage').returns({
					majorPageFault: 1000,
					minorPageFault: 2000,
				});

				cru.priorResourceUsage = {
					majorPageFault: 100,
					minorPageFault: 200,
				}

				const pageFaults = cru.pageFaults();

				expect(pageFaults).to.have.property('major').equal(900);
				expect(pageFaults).to.have.property('minor').equal(1800);
			});

			it('uses current page faults as prior on refresh', () => {
				cru.resourceUsage = {
					majorPageFault: 100,
					minorPageFault: 200,
				};

				cru.refresh();

				expect(cru.priorResourceUsage).to.have.property('majorPageFault').equal(100);
				expect(cru.priorResourceUsage).to.have.property('minorPageFault').equal(200);
			});
		});

		describe('context switches', () => {
			it('diffs context switches between refreshes', () => {
				sinon.stub(process, 'resourceUsage').returns({
					voluntaryContextSwitches: 1000,
					involuntaryContextSwitches: 2000,
				});

				cru.priorResourceUsage = {
					voluntaryContextSwitches: 100,
					involuntaryContextSwitches: 200,
				}

				const pageFaults = cru.contextSwitches();

				expect(pageFaults).to.have.property('voluntary').equal(900);
				expect(pageFaults).to.have.property('involuntary').equal(1800);
			});

			it('uses current context switches as prior on refresh', () => {
				cru.resourceUsage = {
					voluntaryContextSwitches: 100,
					involuntaryContextSwitches: 200,
				};

				cru.refresh();

				expect(cru.priorResourceUsage).to.have.property('voluntaryContextSwitches').equal(100);
				expect(cru.priorResourceUsage).to.have.property('involuntaryContextSwitches').equal(200);
			});
		});
	});

	describe('CPUMetrics', () => {
		afterEach(() => {
			sinon.restore();
		});

		it('computes utilization based user + system over interval', () => {
			const startCPUUsageStub = sinon.stub(process, 'cpuUsage').returns({
				user: 100,
				system: 200,
			});
			const startTime = process.hrtime.bigint();
			const startTimeStub = sinon.stub(process.hrtime, 'bigint').returns(startTime);

			const cpu = new CPUMetrics();

			cpu.getCPUUsage(); // establish starting point
			startCPUUsageStub.restore();
			startTimeStub.restore();

			sinon.stub(process, 'cpuUsage').returns({
				user: 1000,
				system: 2000,
			});

			const endTime = startTime + 30000000n;
			sinon.stub(process.hrtime, 'bigint').returns(endTime);

			const end = cpu.getCPUUsage();

			expect(end).to.have.property('user').equal(1000);
			expect(end).to.have.property('system').equal(2000);
			expect(end).to.have.property('utilization').equal(0.1);
		});
	});
});
