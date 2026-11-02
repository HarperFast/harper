const { CoalescedCache } = tables;

const burstWaiters = Number(process.env.COALESCING_BURST_WAITERS);
const parked = new Map();
const held = new Set();
const { primaryStore } = CoalescedCache;
const tryLock = primaryStore.tryLock;
primaryStore.tryLock = function (key, onUnlocked) {
	const acquired = tryLock.call(this, key, onUnlocked);
	if (!acquired) parked.set(key, (parked.get(key) ?? 0) + 1);
	return acquired;
};
async function holdFirstCall(id) {
	if (held.has(id)) return;
	held.add(id);
	const deadline = Date.now() + 5_000;
	while ((parked.get(id) ?? 0) < burstWaiters) {
		if (Date.now() > deadline)
			throw new Error(`only ${parked.get(id) ?? 0} of ${burstWaiters} reads parked on the record lock`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

CoalescedCache.sourcedFrom({
	async get(id) {
		await holdFirstCall(id);
		const response = await fetch(
			`http://127.0.0.1:${process.env.COALESCING_ORIGIN_PORT}/item/${encodeURIComponent(id)}`
		);
		if (response.status === 404) return undefined;
		return response.json();
	},
});
