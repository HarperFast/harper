const { ValidatedCache } = tables;

ValidatedCache.sourcedFrom({
	async get(id) {
		const response = await fetch(
			`http://127.0.0.1:${process.env.VALIDATION_ORIGIN_PORT}/item/${encodeURIComponent(id)}`
		);
		return response.json();
	},
});
