declare const tables: any;
declare const Resource: any;

const { DirectSource, DirectMirror, GenericSource, GenericMirror, Probe } = tables;

DirectMirror.sourcedFrom(DirectSource);
GenericMirror.sourcedFrom({
	name: 'ForwardedTableSource',
	async get(id) {
		const record = await GenericSource.get(id, {});
		return record ? { ...record } : undefined;
	},
	async subscribe(options) {
		const subscription = await GenericSource.subscribe({ ...options, crossThreads: true });
		return (async function* () {
			for await (const event of subscription) yield { ...event };
		})();
	},
});

export class SourceState extends Resource {
	allowRead(user) {
		return Boolean(user?.role?.permission?.super_user);
	}

	get() {
		const names = ['DirectSource', 'DirectMirror', 'GenericSource', 'GenericMirror'];
		const entries = [];
		for (const entry of Probe.auditStore.getRange({ start: 1, log: 0 })) {
			const name = [...names, 'Probe'].find((name) => tables[name].tableId === entry.tableId);
			if (name) {
				entries.push({
					table: name,
					id: entry.recordId,
					type: entry.type,
					version: entry.version,
					key: entry.txnLogKey,
					endTxn: entry.endTxn,
				});
			}
		}
		const records = Object.fromEntries(
			names.map((name) => [
				name,
				['s1', 's2'].map((id) => {
					// Observe storage without triggering a cache fill.
					const entry = tables[name].primaryStore.getEntry(id);
					return entry ? { id, value: entry.value, version: entry.version } : null;
				}),
			])
		);
		const readiness = Probe.indices.vector.customIndex.derivedHost.readiness();
		return { entries, records, vector: { ...readiness, ownerEpoch: String(readiness.ownerEpoch) } };
	}
}
