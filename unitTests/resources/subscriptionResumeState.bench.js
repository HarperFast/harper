const { SubscriptionResumeState } = require('#src/resources/subscriptionResumeState');

function measure(count, pattern) {
	const origins = Array.from({ length: count }, (_, index) => `node-${index}`);
	const state = new SubscriptionResumeState({ historyId: 'benchmark', window: 100, origins });
	let updates = 0;
	let bytes = 0;
	for (let i = 0; i < 10000; i++) {
		let origin = i % count;
		let timestamp = 1000 + i;
		if (pattern === 'silent mix') origin = i % Math.ceil(count / 2);
		if (pattern === 'bursty') origin = Math.floor(i / 250) % count;
		if (pattern === 'skew' && origin === count - 1) timestamp -= 500;
		state.recordTransaction(origins[origin], timestamp);
		const checkpoint = state.checkpoint();
		if (checkpoint.resumeState) {
			updates++;
			bytes += Buffer.byteLength(checkpoint.resumeState);
		}
	}
	return {
		origins: count,
		pattern,
		transactions: 10000,
		updates,
		tokenBytes: bytes,
		bytesPerTransaction: bytes / 10000,
	};
}

describe('subscription resume state wire cost', () => {
	it('reports token updates and bytes for common traffic patterns', () => {
		const rows = [];
		for (const count of [5, 20]) {
			for (const pattern of ['steady active', 'silent mix', 'bursty', 'skew']) rows.push(measure(count, pattern));
		}
		console.table(rows);
	});
});
