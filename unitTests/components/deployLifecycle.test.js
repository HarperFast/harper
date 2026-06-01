const assert = require('node:assert/strict');
const { deployLifecycle, _resetForTests } = require('#src/components/deployLifecycle');

describe('deployLifecycle', () => {
	afterEach(() => {
		_resetForTests();
	});

	describe('isDeployInFlight', () => {
		it('returns false when nothing is deploying', () => {
			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
		});

		it('flips true between start and end events', () => {
			deployLifecycle._handle({ name: 'foo', phase: 'start' });
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);
			deployLifecycle._handle({ name: 'foo', phase: 'end' });
			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
		});

		it('tracks overlapping deploys independently', () => {
			deployLifecycle._handle({ name: 'foo', phase: 'start' });
			deployLifecycle._handle({ name: 'bar', phase: 'start' });
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);
			assert.equal(deployLifecycle.isDeployInFlight('bar'), true);
			deployLifecycle._handle({ name: 'foo', phase: 'end' });
			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
			assert.equal(deployLifecycle.isDeployInFlight('bar'), true, 'ending foo must not end bar');
		});
	});

	describe('event emission', () => {
		it('emits deploy:start when a start event is processed', () => {
			let received;
			deployLifecycle.on('deploy:start', (name) => {
				received = name;
			});
			deployLifecycle._handle({ name: 'foo', phase: 'start' });
			assert.equal(received, 'foo');
		});

		it('emits deploy:end when the matching end event clears the refcount', () => {
			let received;
			deployLifecycle.on('deploy:end', (name) => {
				received = name;
			});
			deployLifecycle._handle({ name: 'foo', phase: 'start' });
			deployLifecycle._handle({ name: 'foo', phase: 'end' });
			assert.equal(received, 'foo');
		});

		it('only fires deploy:start once for the 0→1 transition under overlap', () => {
			const startSpy = require('sinon').spy();
			const endSpy = require('sinon').spy();
			deployLifecycle.on('deploy:start', startSpy);
			deployLifecycle.on('deploy:end', endSpy);

			deployLifecycle._handle({ name: 'foo', phase: 'start' });
			deployLifecycle._handle({ name: 'foo', phase: 'start' }); // overlapping deploy
			assert.equal(startSpy.callCount, 1, '0→1 fires deploy:start; 1→2 is silent');

			deployLifecycle._handle({ name: 'foo', phase: 'end' });
			assert.equal(endSpy.callCount, 0, 'first end must NOT fire deploy:end while second deploy is still in flight');
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);

			deployLifecycle._handle({ name: 'foo', phase: 'end' });
			assert.equal(endSpy.callCount, 1, 'second end (refcount 1→0) fires deploy:end');
			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
		});

		it('an unmatched deploy:end is a safe no-op', () => {
			const endSpy = require('sinon').spy();
			deployLifecycle.on('deploy:end', endSpy);
			deployLifecycle._handle({ name: 'never-started', phase: 'end' });
			assert.equal(endSpy.callCount, 0);
			assert.equal(deployLifecycle.isDeployInFlight('never-started'), false);
		});
	});
});
