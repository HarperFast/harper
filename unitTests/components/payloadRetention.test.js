'use strict';

// harper#2681: failed deploys' payloads expire by count and age, keeping each project's newest.

const assert = require('node:assert');
const { hostname } = require('node:os');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { sweepFailedPayloads, failedPayloadRetention } = require('#src/components/payloadRetention');
const { databases } = require('#src/resources/databases');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');

const DEPLOYMENT_TABLE = SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;
const DAY = 86_400_000;
const NOW = 100 * DAY;

describe('failed deploy payload retention (harper#2681)', () => {
	let rows;
	let prior;

	beforeEach(() => {
		rows = new Map();
		if (!databases.system) databases.system = {};
		prior = databases.system[DEPLOYMENT_TABLE];
		databases.system[DEPLOYMENT_TABLE] = {
			async *search(conditions) {
				for (const row of rows.values()) {
					if (conditions.every(({ attribute, value }) => row[attribute] === value)) yield row;
				}
			},
			async put(row) {
				rows.set(row.deployment_id, row);
			},
		};
	});
	afterEach(() => {
		databases.system[DEPLOYMENT_TABLE] = prior;
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXAGE, undefined);
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXCOUNT, undefined);
	});

	function failed(id, daysAgo, extra = {}) {
		rows.set(id, {
			deployment_id: id,
			project: 'web',
			status: 'failed',
			origin_node: hostname(),
			payload_blob: { size: 10 },
			payload_size: 10,
			started_at: NOW - daysAgo * DAY,
			completed_at: NOW - daysAgo * DAY,
			event_log: [],
			...extra,
		});
	}
	const kept = () => [...rows.values()].filter((row) => row.payload_blob != null).map((row) => row.deployment_id);

	it('defaults to the two newest failed payloads of a project, within seven days', () => {
		assert.deepStrictEqual(failedPayloadRetention(), { maxAgeMs: 7 * DAY, maxCount: 2 });
	});

	it('keeps the newest failed payloads of a project, and records why it dropped the rest', async () => {
		for (const [id, daysAgo] of [
			['a', 1],
			['b', 1.1],
			['c', 1.2],
			['d', 1.3],
		])
			failed(id, daysAgo);
		const dropped = await sweepFailedPayloads({ now: NOW });
		assert.deepStrictEqual(kept().sort(), ['a', 'b']);
		assert.deepStrictEqual(dropped.map(({ deployment_id }) => deployment_id).sort(), ['c', 'd']);
		const row = rows.get('c');
		assert.strictEqual(row.payload_size, 10, 'metadata is kept');
		assert.deepStrictEqual(row.event_log.at(-1).data, {
			payload_size: 10,
			reason: 'retention',
			limit: 'failedMaxCount',
		});
	});

	it('drops a payload past the age bound, but never the newest', async () => {
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXCOUNT, 10);
		failed('newest-but-old', 30);
		failed('older', 31);
		await sweepFailedPayloads({ now: NOW });
		assert.deepStrictEqual(kept(), ['newest-but-old']);
		assert.strictEqual(rows.get('older').event_log.at(-1).data.limit, 'failedMaxAge');
	});

	it('leaves alone rows another node wrote, rows that did not fail, and other projects when asked for one', async () => {
		failed('a', 1);
		failed('b', 2);
		failed('c', 3);
		failed('elsewhere', 4, { origin_node: 'another-node' });
		failed('staged', 5, { status: 'staged' });
		failed('pending', 6, { status: 'installing' });
		failed('other-project', 7, { project: 'api' });
		failed('other-project-older', 8, { project: 'api' });
		failed('other-project-oldest', 9, { project: 'api' });
		await sweepFailedPayloads({ now: NOW, project: 'web' });
		assert.deepStrictEqual(kept().sort(), [
			'a',
			'b',
			'elsewhere',
			'other-project',
			'other-project-older',
			'other-project-oldest',
			'pending',
			'staged',
		]);
	});

	it('keeps every failed payload when both bounds are 0', async () => {
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXAGE, 0);
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXCOUNT, 0);
		for (const [id, daysAgo] of [
			['a', 10],
			['b', 20],
			['c', 30],
		])
			failed(id, daysAgo);
		assert.deepStrictEqual(await sweepFailedPayloads({ now: NOW }), []);
		assert.strictEqual(kept().length, 3);
	});

	it('falls back to the defaults for a value it cannot use, rather than dropping everything', () => {
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXAGE, '');
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_FAILEDMAXCOUNT, 'lots');
		assert.deepStrictEqual(failedPayloadRetention(), { maxAgeMs: 7 * DAY, maxCount: 2 });
	});
});
