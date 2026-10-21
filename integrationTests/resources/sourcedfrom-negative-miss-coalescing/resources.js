const { CoalescedCache } = tables;

// Each id's first source call waits until the rest of its burst has parked on the record lock.
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
	const deadline = Date.now() + 10_000;
	while ((parked.get(id) ?? 0) < burstWaiters && Date.now() < deadline) {
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
