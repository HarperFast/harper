function makeFakeSessionTable() {
	const store = new Map();
	return {
		store,
		async put(record) {
			store.set(record.id, { ...record });
		},
		async patch(id, changes, context) {
			if (context?.ifExists && !store.has(id)) return;
			store.set(id, { ...store.get(id), ...changes });
		},
		async get(id) {
			const record = store.get(id);
			return record ? { ...record } : undefined;
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

module.exports = { makeFakeSessionTable };
