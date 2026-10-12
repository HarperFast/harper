// QA-883 — in-process `.subscribe()` ground-truth probe.
//
// Reaches the SAME internal Table.subscribe() (resources/Table.ts ~L3877) that SSE/WS/MQTT all
// funnel through (server/REST.ts CONNECT -> resource.connect -> super.subscribe; MQTT via
// server/DurableSubscriptionsSession.ts -> resource.subscribe(request, context)), but calls it
// directly at module load with NO transport in between — the purest "does subscribe() drop
// same-id updates" surface. Started once per worker process; the test always runs this fixture
// with threads.count:1 so a probe HTTP request always lands on the SAME worker that ran the
// subscription (Harper's worker_threads don't share memory — a second worker's InProcProbe would
// read an empty, never-started ledger).
//
// `tables.Burst.subscribe(request)` (no explicit context) resolves through Resource.ts's static
// `subscribe = transactional(...)` wrapper: with no context argument, `applyContext` falls back to
// `contextStorage.getStore() ?? {}` and opens its OWN transaction (Resource.ts ~L752, ~L797) —
// so this is a free-standing call, safe to fire at top-level module init.
import { RequestTarget } from 'harper';
import { setTimeout as sleep } from 'node:timers/promises';

const G = (globalThis.__QA883__ ??= {
	started: false,
	events: [], // {id, version, value, seq, type, at}
	error: null,
});
const MAX_EVENTS = 5000;

async function startInProcessSubscription() {
	if (G.started) return;
	G.started = true;
	try {
		const request = new RequestTarget('/');
		request.isCollection = true; // whole-table (collection) subscription, thisId === null
		const subscription = await tables.Burst.subscribe(request);
		(async () => {
			for await (const event of subscription) {
				if (!event || event.type === 'end_txn') continue;
				const rec = event.value;
				G.events.push({
					id: event.id,
					version: event.version,
					value: rec && typeof rec === 'object' ? rec.value : undefined,
					seq: rec && typeof rec === 'object' ? rec.seq : undefined,
					tag: rec && typeof rec === 'object' ? rec.tag : undefined,
					type: event.type,
					at: Date.now(),
				});
				if (G.events.length > MAX_EVENTS) G.events.splice(0, G.events.length - MAX_EVENTS);
			}
		})().catch((err) => {
			G.error = String((err && err.stack) || err);
		});
	} catch (err) {
		G.error = String((err && err.stack) || err);
	}
}
startInProcessSubscription();

// InProcProbe: read the in-process subscription's full ledger (this worker only — see header).
export class InProcProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		return {
			count: G.events.length,
			events: G.events,
			error: G.error,
			started: G.started,
		};
	}
}

export class ReplayProbe extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const { ids, sentinelId, includeSuperseded, rawEvents } = await body;
		const subscription = await tables.Burst.subscribe({
			startTime: 1,
			isCollection: true,
			includeSuperseded,
			rawEvents,
			eventFilter: (event) => event.id === sentinelId || ids.includes(event.id),
		});
		const timeout = setTimeout(() => subscription.close(new Error('Replay sentinel was not delivered')), 10_000);
		const events = [];
		try {
			for await (const event of subscription) {
				if (event.id === sentinelId) return events;
				events.push({ id: event.id, type: event.type, value: event.value, version: event.version });
			}
			throw new Error('Subscription ended before the replay sentinel');
		} finally {
			clearTimeout(timeout);
			subscription.end();
		}
	}
}

async function waitForSnapshot(condition) {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error('Snapshot probe condition did not complete');
		await sleep(10);
	}
}

export class BufferedSnapshotProbe extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const { prefix } = await body;
		const id = `${prefix}000`;
		for (let i = 0; i < 150; i++) {
			await tables.Burst.put(`${prefix}${String(i).padStart(3, '0')}`, { seq: 0 }, {});
		}
		const notices = [];
		const sibling = await tables.Burst.subscribe(
			{ id, omitCurrent: true, listener: (event) => notices.push(event) },
			{}
		);
		let snapshot;
		try {
			snapshot = await tables.Burst.subscribe(
				{
					isCollection: true,
					eventFilter: (event) => typeof event.id === 'string' && event.id.startsWith(prefix),
				},
				{}
			);
			await waitForSnapshot(() => snapshot.queue?.length > 100 && snapshot.currentDrainResolver);
			if (!snapshot.queue.some((event) => event.id === id && event.value?.seq === 0)) {
				throw new Error('Snapshot did not scan the old row before pausing');
			}
			await tables.Burst.put(id, { seq: 1 }, {});
			await waitForSnapshot(() => notices.some((event) => event.type === 'put' && event.value?.seq === 1));
			await tables.Burst.publish(id, { seq: 2 }, {});
			await waitForSnapshot(() => notices.some((event) => event.type === 'message'));
			const events = [];
			snapshot.on('data', (event) => events.push(event));
			await waitForSnapshot(
				() => events.some((event) => event.id === `${prefix}149`) && events.some((event) => event.type === 'message')
			);
			return {
				current: (await tables.Burst.get(id, {})).seq,
				events: events.filter((event) => event.id === id).map((event) => ({ type: event.type, seq: event.value?.seq })),
			};
		} finally {
			snapshot?.end();
			sibling.end();
		}
	}
}
