'use strict';

const assert = require('node:assert');
const { restartEachPeer } = require('#src/bin/restart');

const TIMING = {
	attempts: 3,
	retryDelayMs: 5,
	dispatchTimeoutMs: 1000,
	pollIntervalMs: 1,
	pollTimeoutMs: 1000,
	jobDeadlineMs: 500,
};
const CLOSED_FIRST = (operation) =>
	`The connection to wss://peer:9933 closed (1006) before ${operation} was answered; its outcome there is unknown`;
const BACK_PRESSURE = 'ServerError: Outstanding write transactions have too long a queue, please try again later';

describe('a rolling restart of each peer', function () {
	this.timeout(10000);
	let previousServer;
	let sent;
	let dispatchAnswers;
	let pollAnswers;

	const peers = ['peer-a', 'peer-b', 'peer-c'].map((name) => ({ name }));
	const request = { operation: 'restart_service', service: 'http', replicated: false };

	beforeEach(() => {
		previousServer = global.server;
		sent = [];
		dispatchAnswers = {};
		pollAnswers = {};
		global.server = {
			replication: {
				async sendOperationToNode(node, operation, options) {
					sent.push({ node: node.name, operation: operation.operation, options });
					const answers = operation.operation === 'get_job' ? pollAnswers : dispatchAnswers;
					const answer = answers[node.name]?.length
						? answers[node.name].shift()
						: operation.operation === 'get_job'
							? { results: [{ status: 'COMPLETE', message: `restarted ${node.name}` }] }
							: { job_id: `job-${node.name}` };
					if (answer instanceof Error) throw answer;
					return answer;
				},
			},
		};
	});
	afterEach(() => {
		global.server = previousServer;
	});

	const restarted = (name) => ({ node: name, message: `restarted ${name}` });

	it('completes when every peer restarted, one at a time', async () => {
		assert.deepStrictEqual(await restartEachPeer(peers, request, TIMING), {
			replicated: peers.map(({ name }) => restarted(name)),
		});
		assert.ok(
			sent.every(({ options }) => options.timeoutMs > 0),
			'every request to a peer is bounded'
		);
	});

	it('fails naming a peer that could not be asked to restart, after restarting the others', async () => {
		dispatchAnswers['peer-b'] = [new Error('Error: connect ECONNREFUSED 10.0.0.2:9933')];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.match(
				error.message,
				/did not complete on 1 of 3 peer node\(s\): peer-b \(Error: connect ECONNREFUSED 10.0.0.2:9933\)/
			);
			assert.deepStrictEqual(error.result, {
				replicated: [
					restarted('peer-a'),
					{ node: 'peer-b', error: 'Error: connect ECONNREFUSED 10.0.0.2:9933' },
					restarted('peer-c'),
				],
			});
			return true;
		});
	});

	it('retries a peer that refused for write back-pressure after the other peers', async () => {
		dispatchAnswers['peer-a'] = [new Error(BACK_PRESSURE)];
		assert.deepStrictEqual(await restartEachPeer(peers, request, TIMING), {
			replicated: [restarted('peer-b'), restarted('peer-c'), restarted('peer-a')],
		});
	});

	it('also retries the 5.3 wording of the back-pressure refusal', async () => {
		dispatchAnswers['peer-a'] = [
			new Error('HdbError: Outstanding write transactions have too long of queue, please try again later'),
		];
		assert.deepStrictEqual((await restartEachPeer(peers, request, TIMING)).replicated.at(-1), restarted('peer-a'));
	});

	it('gives up on a peer that keeps refusing for back-pressure', async () => {
		dispatchAnswers['peer-a'] = [new Error(BACK_PRESSURE), new Error(BACK_PRESSURE), new Error(BACK_PRESSURE)];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.match(error.message, /1 of 3 peer node\(s\): peer-a \(ServerError: Outstanding write/);
			assert.deepStrictEqual(error.result.replicated.at(-1), { node: 'peer-a', error: BACK_PRESSURE });
			return true;
		});
		assert.strictEqual(sent.filter((s) => s.node === 'peer-a' && s.operation === 'restart_service').length, 3);
	});

	it('does not retry any other refusal', async () => {
		dispatchAnswers['peer-a'] = [new Error('Error: Unauthorized')];
		await assert.rejects(restartEachPeer(peers, request, TIMING), /peer-a \(Error: Unauthorized\)/);
		assert.strictEqual(sent.filter((s) => s.node === 'peer-a').length, 1);
	});

	it('keeps polling through a dropped connection while the peer restarts', async () => {
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			pollAnswers['peer-a'] = [
				new Error(CLOSED_FIRST('get_job')),
				new Error('Client network socket disconnected before secure TLS connection was established'),
				{ results: [{ status: 'IN_PROGRESS' }] },
			];
			assert.deepStrictEqual(await restartEachPeer(peers, request, TIMING), {
				replicated: peers.map(({ name }) => restarted(name)),
			});
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepStrictEqual(unhandled, []);
	});

	it('polls one request at a time', async () => {
		let inFlight = 0;
		const send = global.server.replication.sendOperationToNode;
		global.server.replication.sendOperationToNode = async (...args) => {
			assert.strictEqual(++inFlight, 1);
			await new Promise((resolve) => setTimeout(resolve, 5));
			try {
				return await send(...args);
			} finally {
				inFlight--;
			}
		};
		pollAnswers['peer-a'] = [{ results: [{ status: 'IN_PROGRESS' }] }, { results: [{ status: 'IN_PROGRESS' }] }];
		await restartEachPeer(peers, request, TIMING);
	});

	it('halts at a peer whose restart failed and names the peers it skipped', async () => {
		pollAnswers['peer-a'] = [{ results: [{ status: 'ERROR', message: 'workers did not start' }] }];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.match(error.message, /3 of 3 peer node\(s\): peer-a \(workers did not start\); peer-b \(skipped/);
			assert.deepStrictEqual(error.result.replicated, [
				{ node: 'peer-a', error: 'workers did not start' },
				{ node: 'peer-b', error: 'skipped: the restart of peer-a did not complete' },
				{ node: 'peer-c', error: 'skipped: the restart of peer-a did not complete' },
			]);
			return true;
		});
		assert.deepStrictEqual(
			sent.filter((s) => s.operation === 'restart_service').map((s) => s.node),
			['peer-a']
		);
	});

	it('skips a peer waiting for its back-pressure retry once the roll halts', async () => {
		dispatchAnswers['peer-a'] = [new Error(BACK_PRESSURE)];
		pollAnswers['peer-c'] = [{ results: [{ status: 'ERROR', message: 'workers did not start' }] }];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.deepStrictEqual(error.result.replicated, [
				restarted('peer-b'),
				{ node: 'peer-c', error: 'workers did not start' },
				{ node: 'peer-a', error: 'skipped: the restart of peer-c did not complete' },
			]);
			return true;
		});
	});

	it('halts at a peer whose restart job never finishes', async () => {
		pollAnswers['peer-a'] = Array.from({ length: 100000 }, () => ({ results: [{ status: 'IN_PROGRESS' }] }));
		await assert.rejects(restartEachPeer(peers, request, { ...TIMING, jobDeadlineMs: 50 }), (error) => {
			assert.match(error.result.replicated[0].error, /Timed out waiting for restart job job-peer-a/);
			assert.strictEqual(error.result.replicated.length, 3);
			return true;
		});
	});

	it('halts at a peer that no longer has its restart job', async () => {
		pollAnswers['peer-a'] = [{ results: [] }];
		await assert.rejects(
			restartEachPeer(peers, request, TIMING),
			/peer-a \(its restart job job-peer-a was not found\)/
		);
	});

	it('halts at a peer whose session closed with its request pending', async () => {
		dispatchAnswers['peer-a'] = [new Error('Connection closed  1006')];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.deepStrictEqual(
				error.result.replicated.map(({ node }) => node),
				['peer-a', 'peer-b', 'peer-c']
			);
			return true;
		});
		assert.deepStrictEqual(
			sent.map((s) => s.node),
			['peer-a']
		);
	});

	it('halts at a peer whose restart may have started, since its outcome is unknown', async () => {
		dispatchAnswers['peer-a'] = [new Error(CLOSED_FIRST('restart_service'))];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.deepStrictEqual(
				error.result.replicated.map(({ node, error }) => [node, error.startsWith('skipped') ? 'skipped' : 'failed']),
				[
					['peer-a', 'failed'],
					['peer-b', 'skipped'],
					['peer-c', 'skipped'],
				]
			);
			return true;
		});
		assert.deepStrictEqual(
			sent.map((s) => s.node),
			['peer-a']
		);
	});

	it('halts at a peer that answered without a job id', async () => {
		dispatchAnswers['peer-a'] = [undefined];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.deepStrictEqual(error.result.replicated[0], {
				node: 'peer-a',
				error: 'it answered without a restart job id',
			});
			assert.match(error.result.replicated[1].error, /^skipped/);
			return true;
		});
	});

	it('halts at a peer whose restart job failed without a message', async () => {
		pollAnswers['peer-a'] = [{ results: [{ status: 'ERROR' }] }];
		await assert.rejects(restartEachPeer(peers, request, TIMING), /peer-a \(its restart job job-peer-a failed\)/);
	});

	it('halts at a peer whose restart job reports a status it does not know', async () => {
		pollAnswers['peer-a'] = [{ results: [{}] }];
		await assert.rejects(
			restartEachPeer(peers, request, TIMING),
			/peer-a \(its restart job job-peer-a reported status undefined\)/
		);
	});

	it('reports the last poll failure when a peer never answers in time', async () => {
		pollAnswers['peer-a'] = Array.from({ length: 100000 }, () => new Error(CLOSED_FIRST('get_job')));
		await assert.rejects(restartEachPeer(peers, request, { ...TIMING, jobDeadlineMs: 50 }), (error) => {
			assert.match(error.result.replicated[0].error, /Timed out .*; the last poll failed: The connection to/);
			return true;
		});
	});

	it('halts at a peer whose connection failed after the request may have been sent', async () => {
		dispatchAnswers['peer-a'] = [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.match(error.result.replicated[1].error, /^skipped/);
			return true;
		});
	});

	it('moves on from a peer it could not connect to', async () => {
		dispatchAnswers['peer-a'] = [
			Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:9933'), { code: 'ECONNREFUSED' }),
		];
		await assert.rejects(restartEachPeer(peers, request, TIMING), (error) => {
			assert.deepStrictEqual(error.result.replicated.slice(1), [restarted('peer-b'), restarted('peer-c')]);
			return true;
		});
	});

	it('does not blame the network for a timeout once the peer answered again', async () => {
		pollAnswers['peer-a'] = [
			new Error(CLOSED_FIRST('get_job')),
			...Array.from({ length: 100000 }, () => ({ results: [{ status: 'IN_PROGRESS' }] })),
		];
		await assert.rejects(restartEachPeer(peers, request, { ...TIMING, jobDeadlineMs: 50 }), (error) => {
			assert.strictEqual(error.result.replicated[0].error, 'Timed out waiting for restart job job-peer-a to complete');
			return true;
		});
	});
});
