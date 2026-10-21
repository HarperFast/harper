// The source reads from an origin the test runs, which counts the requests for each id.
const { CoalescedCache } = tables;

CoalescedCache.sourcedFrom({
	async get(id) {
		const response = await fetch(
			`http://127.0.0.1:${process.env.COALESCING_ORIGIN_PORT}/item/${encodeURIComponent(id)}`
		);
		if (response.status === 404) return undefined;
		return response.json();
	},
});
