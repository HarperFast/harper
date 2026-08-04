const assert = require('node:assert');
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

		it('ends a deploy when its owner thread exits', () => {
			let endCount = 0;
			deployLifecycle.on('deploy:end', () => endCount++);
			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'dead-deploy',
				ownerThreadId: 41,
			});

			deployLifecycle._reclaimOwner(41);

			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
			assert.equal(endCount, 1);
		});

		it('waits for the dead owner process group before ending its deploy', async () => {
			let releaseTermination;
			const termination = new Promise((resolve) => {
				releaseTermination = resolve;
			});
			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'terminating-deploy',
				ownerThreadId: 41,
			});

			const reclaim = deployLifecycle._reclaimOwnerAfterTermination(41, () => termination);
			await Promise.resolve();
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);
			deployLifecycle._handle({
				name: 'bar',
				phase: 'start',
				deploymentId: 'late-deploy',
				ownerThreadId: 41,
			});
			assert.equal(deployLifecycle.isDeployInFlight('bar'), false, 'late starts from the dead owner stay ignored');

			releaseTermination();
			await reclaim;
			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
		});

		it('continues reclaiming when one component deploy:end listener throws', () => {
			const originalError = console.error;
			const received = [];
			deployLifecycle.on('deploy:end', (name) => {
				if (name === 'foo') throw new Error('consumer failed');
			});
			deployLifecycle.on('deploy:end', (name) => received.push(name));
			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'foo-deploy',
				ownerThreadId: 41,
			});
			deployLifecycle._handle({
				name: 'bar',
				phase: 'start',
				deploymentId: 'bar-deploy',
				ownerThreadId: 41,
			});

			try {
				console.error = () => {};
				deployLifecycle._reclaimOwner(41);
			} finally {
				console.error = originalError;
			}

			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
			assert.equal(deployLifecycle.isDeployInFlight('bar'), false);
			assert.deepEqual(received, ['foo', 'bar']);
		});

		it('continues deploy:start emission when one listener throws', () => {
			const originalError = console.error;
			const received = [];
			deployLifecycle.on('deploy:start', () => {
				throw new Error('consumer failed');
			});
			deployLifecycle.on('deploy:start', (name) => received.push(name));

			try {
				console.error = () => {};
				deployLifecycle._handle({
					name: 'foo',
					phase: 'start',
					deploymentId: 'start-listener-deploy',
					ownerThreadId: 42,
				});
			} finally {
				console.error = originalError;
			}

			assert.deepEqual(received, ['foo']);
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);
		});

		it('ignores parent and current-thread exit notifications', async () => {
			let waited = false;
			await deployLifecycle._reclaimOwnerAfterTermination(0, async () => {
				waited = true;
			});
			assert.equal(waited, false);
		});

		it('keeps an overlapping live-owner deploy active and ignores late starts from a dead owner', () => {
			let endCount = 0;
			deployLifecycle.on('deploy:end', () => endCount++);
			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'dead-deploy',
				ownerThreadId: 41,
			});
			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'live-deploy',
				ownerThreadId: 42,
			});

			deployLifecycle._reclaimOwner(41);
			assert.equal(deployLifecycle.isDeployInFlight('foo'), true);
			assert.equal(endCount, 0);

			deployLifecycle._handle({
				name: 'foo',
				phase: 'start',
				deploymentId: 'late-deploy',
				ownerThreadId: 41,
			});
			deployLifecycle._handle({
				name: 'foo',
				phase: 'end',
				deploymentId: 'live-deploy',
				ownerThreadId: 42,
			});

			assert.equal(deployLifecycle.isDeployInFlight('foo'), false);
			assert.equal(endCount, 1);
		});
	});
});
