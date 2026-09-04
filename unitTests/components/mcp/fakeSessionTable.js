const { PATCH_IF_EXISTS } = require('#src/resources/Resource');

function makeFakeSessionTable() {
	const store = new Map();
	return {
		store,
		replicate: false,
		databaseName: 'system',
		tableName: 'mcp_session',
		async put(record) {
			store.set(record.id, { ...record });
		},
		async [PATCH_IF_EXISTS](id, changes) {
			if (!store.has(id)) return;
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
