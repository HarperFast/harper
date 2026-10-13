require('../testUtils');
const assert = require('node:assert');
const {
	DatabaseTransaction,
	setMaxOutstandingTxnDuration,
	trackOutstandingCommit,
} = require('#src/resources/DatabaseTransaction');
const { statusForComponent } = require('#src/components/status/index');
const { initLogBridge, handleStatusLog } = require('#src/components/status/logBridge');
const { waitFor } = require('../waitFor.js');

describe('transaction overload status', function () {
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
				return component.get()?.lastChecked !== previousChecked;
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
