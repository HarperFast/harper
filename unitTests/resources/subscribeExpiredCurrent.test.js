const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

describe('Table.subscribe() skips expired current records on non-source tables', function () {
	let tableSeq = 0;
	let clientSeq = 0;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	function nextTableName(prefix) {
		return `${prefix}_${process.pid}_${++tableSeq}`;
	}

	function nextClientId(prefix) {
		return `${prefix}-${process.pid}-${++clientSeq}`;
	}

	it('exposes expiresAt on primaryStore.getRange({ versions: true })', async function () {
		const ExpRangeTable = table({
			table: nextTableName('SubExpRange'),
			database: nextTableName('db'),
			expiration: 3600,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		const pastExpiry = Date.now() - 5000;
		const futureExpiry = Date.now() + 60_000;
		await ExpRangeTable.put('expired-key', { id: 'expired-key', name: 'old' }, { expiresAt: pastExpiry });
		await ExpRangeTable.put('live-key', { id: 'live-key', name: 'fresh' }, { expiresAt: futureExpiry });

		const entries = Array.from(ExpRangeTable.primaryStore.getRange({ start: false, versions: true }));
		const expiredEntry = entries.find((e) => e.key === 'expired-key');
		const liveEntry = entries.find((e) => e.key === 'live-key');

		assert.ok(expiredEntry, 'expired entry should still be stored before eviction');
		assert.strictEqual(expiredEntry.expiresAt, pastExpiry);
		assert.ok(liveEntry, 'live entry should be stored');
		assert.strictEqual(liveEntry.expiresAt, futureExpiry);
	});

	it('skips expired records in the [expiration, expiration + eviction] window on wildcard/collection subscribe without lazy eviction', async function () {
		const ExpWindowTable = table({
			table: nextTableName('SubExpWindowCol'),
			database: nextTableName('db'),
			expiration: 0.05,
			eviction: 3600, // 1h eviction window so the background sweep never evicts during the test
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		await ExpWindowTable.put({ id: 'a-expired', name: 'expired-table-ttl' });
		await ExpWindowTable.put({ id: ['prefix', 'a-expired'], name: 'expired-prefix-ttl' });
		await delay(80);

		const futureExpiry = Date.now() + 60_000;
		await ExpWindowTable.put('z-live', { id: 'z-live', name: 'live-row' }, { expiresAt: futureExpiry });
		await ExpWindowTable.put(
			['prefix', 'z-live'],
			{ id: ['prefix', 'z-live'], name: 'live-prefix-row' },
			{ expiresAt: futureExpiry }
		);

		const storedExpired = ExpWindowTable.primaryStore.getEntry('a-expired');
		assert.ok(storedExpired?.value, 'a-expired must still exist in primaryStore within the eviction window');
		assert.ok(storedExpired.expiresAt < Date.now(), 'a-expired must have passed expiresAt');

		const storedPrefixExpired = ExpWindowTable.primaryStore.getEntry(['prefix', 'a-expired']);
		assert.ok(storedPrefixExpired?.value, 'prefix/a-expired must still exist in primaryStore');
		assert.ok(storedPrefixExpired.expiresAt < Date.now(), 'prefix/a-expired must have passed expiresAt');

		const collectionEvents = [];
		const collectionSub = await ExpWindowTable.subscribe({});
		collectionSub.on('data', (ev) => collectionEvents.push(ev));

		const prefixEvents = [];
		const prefixSub = await ExpWindowTable.subscribe({ id: 'prefix', isCollection: true });
		prefixSub.on('data', (ev) => prefixEvents.push(ev));

		try {
			await waitFor(() => collectionEvents.some((ev) => ev.id === 'z-live'), 3000);
			assert.deepStrictEqual(
				collectionEvents.map((ev) => ev.id),
				[['prefix', 'z-live'], 'z-live'],
				'collection subscribe should deliver only unexpired records'
			);

			await waitFor(() => prefixEvents.length === 1, 3000);
			assert.deepStrictEqual(
				prefixEvents.map((ev) => ev.id),
				[['prefix', 'z-live']],
				'prefix subscribe should deliver only unexpired matching records'
			);

			const afterSubExpired = ExpWindowTable.primaryStore.getEntry('a-expired');
			assert.ok(afterSubExpired?.value, 'subscribe() must not lazily evict a-expired from primaryStore');
			assert.ok(afterSubExpired.expiresAt < Date.now());
			const afterSubPrefixExpired = ExpWindowTable.primaryStore.getEntry(['prefix', 'a-expired']);
			assert.ok(afterSubPrefixExpired?.value, 'subscribe() must not lazily evict prefix/a-expired from primaryStore');
		} finally {
			collectionSub.end();
			prefixSub.end();
		}
	});

	it('skips expired records in the [expiration, expiration + eviction] window on single-record subscribe without lazy eviction', async function () {
		const ExpWindowSingleTable = table({
			table: nextTableName('SubExpWindowSingle'),
			database: nextTableName('db'),
			expiration: 0.05,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		await ExpWindowSingleTable.put({ id: 'a-expired', name: 'expired-table-ttl' });
		await delay(80);
		await ExpWindowSingleTable.put('z-live', { id: 'z-live', name: 'live-row' }, { expiresAt: Date.now() + 60_000 });

		const storedExpired = ExpWindowSingleTable.primaryStore.getEntry('a-expired');
		assert.ok(storedExpired?.value, 'a-expired must still exist in primaryStore within the eviction window');
		assert.ok(storedExpired.expiresAt < Date.now(), 'a-expired must have passed expiresAt');

		const liveSingleEvents = [];
		const liveSingleSub = await ExpWindowSingleTable.subscribe('z-live');
		liveSingleSub.on('data', (ev) => liveSingleEvents.push(ev));

		const expiredSingleEvents = [];
		const expiredSingleSub = await ExpWindowSingleTable.subscribe('a-expired');
		expiredSingleSub.on('data', (ev) => expiredSingleEvents.push(ev));

		try {
			await waitFor(() => liveSingleEvents.length >= 1, 3000);
			assert.strictEqual(liveSingleEvents[0].id, 'z-live');
			assert.strictEqual(liveSingleEvents[0].value.name, 'live-row');

			const afterSubExpired = ExpWindowSingleTable.primaryStore.getEntry('a-expired');
			assert.ok(afterSubExpired?.value, 'subscribe() must not lazily evict a-expired from primaryStore');
			assert.ok(afterSubExpired.expiresAt < Date.now());

			await ExpWindowSingleTable.put(
				'a-expired',
				{ id: 'a-expired', name: 'replacement-live' },
				{ expiresAt: Date.now() + 60_000 }
			);
			await waitFor(() => expiredSingleEvents.length >= 1, 3000);
			assert.strictEqual(
				expiredSingleEvents[0].value?.name,
				'replacement-live',
				'first event on expired single-record subscription must be the subsequent live write, not the expired current value'
			);
		} finally {
			liveSingleSub.end();
			expiredSingleSub.end();
		}
	});

	it('skips records expired via @expiresAt attribute before the 60s sweep on single-record and wildcard subscribe', async function () {
		const ExpiresAtAttrTable = table({
			table: nextTableName('SubExpiresAtAttr'),
			database: nextTableName('db'),
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'expiresAt', type: 'Date', indexed: true, expiresAt: true },
			],
		});

		await ExpiresAtAttrTable.put({
			id: 'a-expired-past',
			name: 'already-past',
			expiresAt: new Date(Date.now() - 5000),
		});
		await ExpiresAtAttrTable.put({
			id: 'b-expired-elapsed',
			name: 'short-ttl',
			expiresAt: new Date(Date.now() + 40),
		});
		await ExpiresAtAttrTable.put({
			id: 'z-unexpired',
			name: 'still-valid',
			expiresAt: new Date(Date.now() + 60_000),
		});

		await delay(70);

		for (const id of ['a-expired-past', 'b-expired-elapsed']) {
			const entry = ExpiresAtAttrTable.primaryStore.getEntry(id);
			assert.ok(entry?.value, `${id} should still be present in primaryStore before the 60s sweep`);
			assert.ok(entry.expiresAt < Date.now(), `${id} should have expiresAt < now`);
		}

		const wildcardEvents = [];
		const wildcardSub = await ExpiresAtAttrTable.subscribe({});
		wildcardSub.on('data', (ev) => wildcardEvents.push(ev));

		const singleExpiredEvents = [];
		const singleExpiredSub = await ExpiresAtAttrTable.subscribe('b-expired-elapsed');
		singleExpiredSub.on('data', (ev) => singleExpiredEvents.push(ev));

		const singleValidEvents = [];
		const singleValidSub = await ExpiresAtAttrTable.subscribe('z-unexpired');
		singleValidSub.on('data', (ev) => singleValidEvents.push(ev));

		try {
			await waitFor(() => wildcardEvents.some((ev) => ev.id === 'z-unexpired'), 3000);
			assert.deepStrictEqual(
				wildcardEvents.map((ev) => ev.id),
				['z-unexpired'],
				'wildcard subscribe should skip @expiresAt-expired records and deliver only unexpired records'
			);

			await waitFor(() => singleValidEvents.length >= 1, 3000);
			assert.strictEqual(singleValidEvents[0].id, 'z-unexpired');
			assert.strictEqual(singleValidEvents[0].value.name, 'still-valid');

			for (const id of ['a-expired-past', 'b-expired-elapsed']) {
				const entry = ExpiresAtAttrTable.primaryStore.getEntry(id);
				assert.ok(entry?.value, `${id} must remain in primaryStore after subscribe()`);
			}

			await ExpiresAtAttrTable.put({
				id: 'b-expired-elapsed',
				name: 'renewed',
				expiresAt: new Date(Date.now() + 60_000),
			});
			await waitFor(() => singleExpiredEvents.length >= 1, 3000);
			assert.strictEqual(
				singleExpiredEvents[0].value?.name,
				'renewed',
				'expired single-record subscriber should only receive the new live write'
			);
		} finally {
			wildcardSub.end();
			singleExpiredSub.end();
			singleValidSub.end();
		}
	});

	it('skips expired records on MQTT retained-on-subscribe (single topic, + wildcard, and # wildcard)', async function () {
		const MqttTopicName = nextTableName('SubExpMqtt');
		const MqttTable = table({
			table: MqttTopicName,
			database: nextTableName('db'),
			expiration: 0.05,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		Resources.resources.set(MqttTopicName, MqttTable, { mqtt: true });

		await MqttTable.put({ id: 'a-expired', name: 'mqtt-expired-top' });
		await MqttTable.put({ id: 'nested/a-expired', name: 'mqtt-expired-nested' });
		await delay(80);

		const futureExpiry = Date.now() + 60_000;
		await MqttTable.put('z-live', { id: 'z-live', name: 'mqtt-live-top' }, { expiresAt: futureExpiry });
		await MqttTable.put(
			'nested/z-live',
			{ id: 'nested/z-live', name: 'mqtt-live-nested' },
			{ expiresAt: futureExpiry }
		);

		assert.ok(MqttTable.primaryStore.getEntry('a-expired')?.expiresAt < Date.now());
		assert.ok(MqttTable.primaryStore.getEntry('nested/a-expired')?.expiresAt < Date.now());

		const mqttUser = { username: 'mqtt-exp-test', role: { permission: { super_user: true } } };

		const hashDeliveries = [];
		const hashSession = await getSession({
			clientId: nextClientId('mqtt-hash'),
			clean: true,
			user: mqttUser,
		});
		hashSession.setListener((topic, message) => {
			hashDeliveries.push({ topic, message });
			return true;
		});

		const plusDeliveries = [];
		const plusSession = await getSession({
			clientId: nextClientId('mqtt-plus'),
			clean: true,
			user: mqttUser,
		});
		plusSession.setListener((topic, message) => {
			plusDeliveries.push({ topic, message });
			return true;
		});

		const singleDeliveries = [];
		const singleSession = await getSession({
			clientId: nextClientId('mqtt-single'),
			clean: true,
			user: mqttUser,
		});
		singleSession.setListener((topic, message) => {
			singleDeliveries.push({ topic, message });
			return true;
		});

		try {
			await singleSession.addSubscription({ topic: `${MqttTopicName}/a-expired`, qos: 1, rh: 0 }, true);
			await singleSession.addSubscription({ topic: `${MqttTopicName}/z-live`, qos: 1, rh: 0 }, true);
			await waitFor(() => singleDeliveries.some((d) => d.topic === `${MqttTopicName}/z-live`), 3000);
			assert.deepStrictEqual(
				singleDeliveries.map((d) => d.topic),
				[`${MqttTopicName}/z-live`],
				'MQTT single-topic retained subscribe must deliver unexpired topic and skip expired topic'
			);

			await hashSession.addSubscription({ topic: `${MqttTopicName}/#`, qos: 1, rh: 0 }, true);
			await waitFor(() => hashDeliveries.some((d) => d.topic === `${MqttTopicName}/z-live`), 3000);
			assert.deepStrictEqual(
				hashDeliveries.map((d) => d.topic),
				[`${MqttTopicName}/nested/z-live`, `${MqttTopicName}/z-live`],
				'MQTT # retained subscribe must skip expired records'
			);

			await plusSession.addSubscription({ topic: `${MqttTopicName}/+`, qos: 1, rh: 0 }, true);
			await plusSession.addSubscription({ topic: `${MqttTopicName}/nested/+`, qos: 1, rh: 0 }, true);
			await waitFor(
				() =>
					plusDeliveries.some((d) => d.topic === `${MqttTopicName}/z-live`) &&
					plusDeliveries.some((d) => d.topic === `${MqttTopicName}/nested/z-live`),
				3000
			);
			assert.deepStrictEqual(
				plusDeliveries.map((d) => d.topic).sort(),
				[`${MqttTopicName}/nested/z-live`, `${MqttTopicName}/z-live`],
				'MQTT + retained subscribe must skip expired records'
			);

			assert.ok(
				MqttTable.primaryStore.getEntry('a-expired')?.value,
				'a-expired must remain in primaryStore after MQTT subscribe'
			);
			assert.ok(
				MqttTable.primaryStore.getEntry('nested/a-expired')?.value,
				'nested/a-expired must remain in primaryStore after MQTT subscribe'
			);

			await MqttTable.put('a-expired', { id: 'a-expired', name: 'mqtt-fresh' }, { expiresAt: Date.now() + 60_000 });
			await waitFor(() => singleDeliveries.some((d) => d.topic === `${MqttTopicName}/a-expired`), 3000);
			const expiredTopicEvents = singleDeliveries.filter((d) => d.topic === `${MqttTopicName}/a-expired`);
			assert.strictEqual(expiredTopicEvents.length, 1);
			assert.strictEqual(expiredTopicEvents[0].message.name, 'mqtt-fresh');
		} finally {
			hashSession.disconnect(true);
			plusSession.disconnect(true);
			singleSession.disconnect(true);
			await Promise.all([hashSession.writes, plusSession.writes, singleSession.writes]);
			Resources.resources.delete(MqttTopicName);
		}
	});

	it('skips expired records during reload re-snapshot (currentScopeRecords) on collection and single-record subscribers', async function () {
		const ReloadExpTable = table({
			table: nextTableName('SubExpReload'),
			database: nextTableName('db'),
			expiration: 3600,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		await ReloadExpTable.put('a-expired', { id: 'a-expired', name: 'stale' }, { expiresAt: Date.now() - 5000 });
		await ReloadExpTable.put('z-live', { id: 'z-live', name: 'fresh' }, { expiresAt: Date.now() + 60_000 });

		const collectionEvents = [];
		const collectionSub = await ReloadExpTable.subscribe({ omitCurrent: true });
		collectionSub.on('data', (ev) => collectionEvents.push(ev));

		const expiredKeyEvents = [];
		const expiredKeySub = await ReloadExpTable.subscribe({ id: 'a-expired', omitCurrent: true });
		expiredKeySub.on('data', (ev) => expiredKeyEvents.push(ev));

		const liveKeyEvents = [];
		const liveKeySub = await ReloadExpTable.subscribe({ id: 'z-live', omitCurrent: true });
		liveKeySub.on('data', (ev) => liveKeyEvents.push(ev));

		try {
			assert.strictEqual(collectionEvents.length, 0);
			assert.strictEqual(expiredKeyEvents.length, 0);
			assert.strictEqual(liveKeyEvents.length, 0);

			await ReloadExpTable.writeReloadMarker();

			await waitFor(() => collectionEvents.some((ev) => ev.id === 'z-live'), 3000);
			await waitFor(() => liveKeyEvents.length === 1, 3000);

			assert.deepStrictEqual(
				collectionEvents.map((ev) => ev.id),
				['z-live'],
				'reload re-snapshot on collection subscriber must skip expired records'
			);
			assert.deepStrictEqual(
				liveKeyEvents.map((ev) => ev.id),
				['z-live'],
				'reload re-snapshot on live single-record subscriber must deliver the live record'
			);
			assert.strictEqual(
				expiredKeyEvents.length,
				0,
				'reload re-snapshot on expired single-record subscriber must skip it'
			);
			assert.ok(
				ReloadExpTable.primaryStore.getEntry('a-expired')?.value,
				'reload re-snapshot must not evict expired record'
			);
		} finally {
			collectionSub.end();
			expiredKeySub.end();
			liveKeySub.end();
		}
	});

	it('raises cursorMaxTime across expired rows for includeSuperseded collection subscribers', async function () {
		const GateTable = table({
			table: nextTableName('SubExpGate'),
			database: nextTableName('db'),
			expiration: 3600,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		await GateTable.put('a-live', { id: 'a-live', name: 'first' }, { expiresAt: Date.now() + 60_000 });
		await delay(5);
		await GateTable.put('z-expired', { id: 'z-expired', name: 'newer-expired' }, { expiresAt: Date.now() - 5000 });

		const liveEntry = GateTable.primaryStore.getEntry('a-live');
		const expiredEntry = GateTable.primaryStore.getEntry('z-expired');
		const expiredTime = expiredEntry.localTime ?? expiredEntry.version;
		const liveTime = liveEntry.localTime ?? liveEntry.version;
		assert.ok(expiredTime > liveTime, 'expired row should have a strictly higher timestamp than the live row');

		const events = [];
		const sub = await GateTable.subscribe({ includeSuperseded: true });
		sub.on('data', (ev) => events.push(ev));

		try {
			await waitFor(() => events.some((ev) => ev.id === 'a-live'), 3000);
			await waitFor(() => sub.startTime === expiredTime, 3000);
			assert.deepStrictEqual(
				events.map((ev) => ev.id),
				['a-live'],
				'expired row is not delivered, yet cursorMaxTime advances subscription.startTime to its timestamp'
			);
		} finally {
			sub.end();
		}
	});

	it('leaves source-backed (sourcedFrom) tables unchanged and does not call the source from subscribe()', async function () {
		const CachedTable = table({
			table: nextTableName('SubExpCached'),
			database: nextTableName('db'),
			expiration: 0.05,
			eviction: 3600,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});

		let sourceGetCalls = 0;
		class BackingSource extends Resource {
			async get() {
				sourceGetCalls++;
				return { id: this.getId(), name: `from-source-${sourceGetCalls}` };
			}
		}
		CachedTable.sourcedFrom(BackingSource);

		const loaded = await CachedTable.get('s1');
		assert.strictEqual(loaded.name, 'from-source-1');
		assert.strictEqual(sourceGetCalls, 1);

		await delay(80);
		const cachedEntry = CachedTable.primaryStore.getEntry('s1');
		assert.ok(cachedEntry?.value, 'cached entry must still exist in primaryStore');
		assert.ok(cachedEntry.expiresAt < Date.now(), 'cached entry must be past expiresAt');

		const singleEvents = [];
		const singleSub = await CachedTable.subscribe('s1');
		singleSub.on('data', (ev) => singleEvents.push(ev));

		const collectionEvents = [];
		const collectionSub = await CachedTable.subscribe({});
		collectionSub.on('data', (ev) => collectionEvents.push(ev));

		try {
			await waitFor(() => singleEvents.length >= 1, 3000);
			assert.strictEqual(singleEvents[0].id, 's1');
			assert.strictEqual(singleEvents[0].value.name, 'from-source-1');
			assert.strictEqual(sourceGetCalls, 1, 'subscribe() must not call the backing source');

			await waitFor(() => collectionEvents.length >= 1, 3000);
			assert.strictEqual(collectionEvents[0].id, 's1');
			assert.strictEqual(collectionEvents[0].value.name, 'from-source-1');
			assert.strictEqual(sourceGetCalls, 1, 'collection subscribe() must not call the backing source');
		} finally {
			singleSub.end();
			collectionSub.end();
		}
	});
});
