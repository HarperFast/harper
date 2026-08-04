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

const G = (globalThis.__QA883__ ??= {
	started: false,
	events: [], // {id, version, value, seq, type, at}
	error: null,
});

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
