const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

// server/serverHelpers/sharedMessageEncoding.ts encodes a message once and reuses it across every
// subscriber of a topic, keyed on the message object's identity. That is only sound because a
// fan-out delivers ONE object instance to every subscription — this pins that premise. If a change
// makes each subscription decode its own copy, the MQTT fan-out silently reverts to one
// serialization per subscriber with no other test noticing (byte equality holds either way).
describe('subscription value identity across subscribers', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('delivers the same value object instance to every subscriber of a record write', async function () {
		const IdentityTable = table({
			database: 'data',
			table: 'SubscriptionValueIdentity',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const firstEvents = [];
		const secondEvents = [];
		const firstSub = await IdentityTable.subscribe({});
		firstSub.on('data', (event) => firstEvents.push(event));
		const secondSub = await IdentityTable.subscribe({});
		secondSub.on('data', (event) => secondEvents.push(event));

		await IdentityTable.put({ id: 'sensor-1', reading: 21.5 });

		const isPut = (event) => event.type === 'put' && event.id === 'sensor-1';
		await waitFor(() => firstEvents.some(isPut), { message: 'first subscriber receives the put' });
		await waitFor(() => secondEvents.some(isPut), { message: 'second subscriber receives the put' });

		const first = firstEvents.find(isPut);
		const second = secondEvents.find(isPut);
		assert.notStrictEqual(first, second, 'each subscription builds its own event object');
		assert.strictEqual(
			first.value,
			second.value,
			'both subscribers must receive the SAME record object — the shared MQTT encoding keys on it'
		);
		assert.strictEqual(first.value.reading, 21.5);
	});

	// The other half of the contract: identity is only a safe cache key because it changes when the
	// content does. If two versions of a record ever shared one object, the fan-out would serve the
	// older version's bytes for the newer one.
	it('delivers a distinct value object for each version of a record', async function () {
		const VersionTable = table({
			database: 'data',
			table: 'SubscriptionValueVersions',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const events = [];
		const subscription = await VersionTable.subscribe({});
		subscription.on('data', (event) => events.push(event));

		await VersionTable.put({ id: 'sensor-2', reading: 1 });
		await waitFor(() => events.some((e) => e.value?.reading === 1), { message: 'first version delivered' });
		await VersionTable.put({ id: 'sensor-2', reading: 2 });
		await waitFor(() => events.some((e) => e.value?.reading === 2), { message: 'second version delivered' });

		const first = events.find((e) => e.value?.reading === 1);
		const second = events.find((e) => e.value?.reading === 2);
		assert.notStrictEqual(first.value, second.value, 'a new version must be a new object, or bytes go stale');
		assert.notStrictEqual(first.version, second.version);
	});
});
