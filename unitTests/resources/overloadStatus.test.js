require('../testUtils');
const assert = require('node:assert');
const {
	DatabaseTransaction,
	getTxnExpiration,
	setTxnExpiration,
	setMaxOutstandingTxnDuration,
	trackOutstandingCommit,
} = require('#src/resources/DatabaseTransaction');
const { statusForComponent } = require('#src/components/status/index');
const { initLogBridge, handleStatusLog } = require('#src/components/status/logBridge');
const { waitFor } = require('../waitFor.js');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');
const status = require('#src/server/status/index');
const { pinLogConfig } = require('../logConfigFixture');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

describe('transaction overload status', function () {
	it('keeps timed-out request targets in the ordinary log and out of status', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		setupTestDBPath();
		initLogBridge();
		const wasMainWorker = getWorkerIndex() === 0;
		const previousExpiration = getTxnExpiration();
		const logRoot = fs.mkdtempSync(join(tmpdir(), 'txn-status-'));
		const component = statusForComponent('database.txn-open-too-long');
		const previousChecked = component.get()?.lastChecked;
		const context = { url: '/records/SYNTHETIC_PRIVATE_ID?token=SYNTHETIC_QUERY_TOKEN' };
		const restore = pinLogConfig({ level: 'error', logRoot });
		setMainIsWorker(true);
		try {
			const Table = table({
				table: 'StatusPrivacyTxn',
				database: 'status-privacy',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			});
			setTxnExpiration(20);
			let result;
			let callbackCompleted = false;
			const error = await transaction(context, async () => {
				await Table.put('private-request', { value: 'must abort' }, context);
				await waitFor(() => context.transaction.timedOut, 2000);
				await waitFor(
					() => component.get()?.lastChecked !== previousChecked && component.get()?.status === 'error',
					2000
				);
				result = await status.get({ components: true });
				await waitFor(
					() =>
						fs.existsSync(join(logRoot, 'hdb.log')) &&
						fs.readFileSync(join(logRoot, 'hdb.log'), 'utf8').includes(context.url),
					2000
				);
				callbackCompleted = true;
			}).then(
				() => undefined,
				(error) => error
			);
			assert.ok(callbackCompleted, error?.stack);
			assert.strictEqual(error?.statusCode, 422);
			assert.match(error.message, /maximum open-transaction time/);
			const flat = result.componentStatus.find((entry) => entry.name === 'database.txn-open-too-long');
			const wire = JSON.stringify(result);
			assert.ok(!wire.includes('SYNTHETIC_PRIVATE_ID'));
			assert.ok(!wire.includes('SYNTHETIC_QUERY_TOKEN'));
			assert.strictEqual(flat.status, 'error');
			assert.strictEqual(flat.latestMessage, undefined);
			assert.strictEqual(flat.error, undefined);
		} finally {
			setTxnExpiration(previousExpiration);
			handleStatusLog({ resolves: 'database.txn-open-too-long' }, null, undefined, []);
			setMainIsWorker(wasMainWorker);
			restore();
			try {
				fs.rmSync(logRoot, { recursive: true, force: true });
			} catch {}
		}
	});

	it('reports a wedged commit without updating status for every rejected write', async function () {
		initLogBridge();
		let settle;
		const previousDuration = setMaxOutstandingTxnDuration(1);
		const component = statusForComponent('database.write-queue-overloaded');
		const previousChecked = component.get()?.lastChecked;
		trackOutstandingCommit(new Promise((resolve) => (settle = resolve)));
		const rejectWrite = () => {
			assert.throws(
				() => new DatabaseTransaction().checkOverloaded(),
				(error) => error.statusCode === 503
			);
		};
		try {
			await waitFor(() => {
				try {
					new DatabaseTransaction().checkOverloaded();
				} catch (error) {
					assert.equal(error.statusCode, 503);
				}
				const current = component.get();
				return current?.status === 'error' && current.lastChecked !== previousChecked;
			}, 20_000);
			const first = component.get();
			assert.equal(first.status, 'error');
			const count = first.occurrenceCount;
			const checked = first.lastChecked;
			for (let i = 0; i < 20; i++) rejectWrite();
			await Promise.resolve();
			assert.equal(component.get().occurrenceCount, count);
			assert.strictEqual(component.get().lastChecked, checked);
		} finally {
			handleStatusLog({ resolves: 'database.write-queue-overloaded' }, 'info', undefined, []);
			setMaxOutstandingTxnDuration(previousDuration);
			settle();
			await Promise.resolve();
		}
	});
});
