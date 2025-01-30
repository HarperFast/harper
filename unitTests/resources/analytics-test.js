require('../test_utils');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const { CachedResourceUsage } = require('../../resources/analytics');

describe('CachedResourceUsage', () => {
	let cru;
	beforeEach(() => {
		cru = new CachedResourceUsage(0);
	});

	afterEach(() => {
		sinon.reset();
	})

	describe('page faults', () => {
		it('Diffs page faults between refreshes', () => {
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

		it('Uses current page faults as prior on refresh', () => {
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
		it('Diffs context switches between refreshes', () => {
			sinon.stub(process, 'resourceUsage').returns({
				voluntaryContextSwitches:   1000,
				involuntaryContextSwitches: 2000,
			});

			cru.priorResourceUsage = {
				voluntaryContextSwitches:   100,
				involuntaryContextSwitches: 200,
			}

			const pageFaults = cru.contextSwitches();

			expect(pageFaults).to.have.property('voluntary').equal(900);
			expect(pageFaults).to.have.property('involuntary').equal(1800);
		});

		it('Uses current context switches as prior on refresh', () => {
			cru.resourceUsage = {
				voluntaryContextSwitches:   100,
				involuntaryContextSwitches: 200,
			};

			cru.refresh();

			expect(cru.priorResourceUsage).to.have.property('voluntaryContextSwitches').equal(100);
			expect(cru.priorResourceUsage).to.have.property('involuntaryContextSwitches').equal(200);
		});
	});
})
