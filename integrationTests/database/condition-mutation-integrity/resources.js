// QA-706 — regression anchor + adjacent-corner probe for harper#1572 / PR #1911
// ("fix(query): stop query planning from mutating the caller's conditions").
//
// Product-catalog service: builds ONE `conditions` array (WITH a nested `operator:'or'`
// sub-array) ONCE at module scope, then reuses it across a paginated sweep, a count, a
// live-refresh loop, and a burst of concurrent queries -- the natural "module-level held
// query filter" pattern the original bug report described. Every endpoint returns the
// CURRENT state of the held object (via /Snapshot/) so the test process -- which is a
// SEPARATE OS process from this Harper worker -- can deep-equal it against a pristine
// copy captured before any query ran. JS object identity can't cross the HTTP boundary,
// so a JSON snapshot + deepStrictEqual on the test side is the oracle.
//
// The test's Harper config pins threads.count:1 so `liveConditions` / `concurrentConditions`
// are genuinely the SAME JS array reference across every request in this suite. With more
// than one worker thread each gets its own module instance (no shared JS heap), which would
// make the concurrent cross-request aliasing scenario untestable.

function buildConditions() {
	return [
		{ attribute: 'category', comparator: 'equals', value: 'electronics' },
		{
			operator: 'or',
			conditions: [
				{ attribute: 'price', comparator: 'less_than', value: 500 },
				{ attribute: 'createdAt', comparator: 'greater_than', value: '2024-01-01T00:00:00.000Z' },
			],
		},
	];
}

// Array-form TARGET (search(array) instead of search({conditions: array})) built from an
// array-form CONDITION ENTRY (`[attribute, value]` tuple) -- a distinct clone code path in
// cloneConditions (`Object.assign(condition.slice(), condition)`).
function buildArrayFormConditions() {
	return [['category', 'electronics']];
}

let liveConditions = buildConditions();
let concurrentConditions = buildConditions();
let arrayFormConditions = buildArrayFormConditions();

function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
}

// POST /Reset/ -> rebuild all three held objects fresh. Lets test sections isolate.
export class Reset extends Resource {
	static loadAsInstance = false;
	async post() {
		liveConditions = buildConditions();
		concurrentConditions = buildConditions();
		arrayFormConditions = buildArrayFormConditions();
		return { ok: true };
	}
}

// POST /Seed/ { count } -- deterministic product-catalog spread.
// category cycles electronics/home/garden; price ramps 100..999 so roughly a third of
// electronics rows are <500; createdAt ramps 2023-01-01.. so roughly half are >2024-01-01;
// rank = count-i (unindexed, monotonic) for the postOrdering-sort probe.
const CATEGORIES = ['electronics', 'home', 'garden'];
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const count = Number(b.count) || 90;
		for (let i = 0; i < count; i++) {
			await tables.Product.put({
				id: `p-${String(i).padStart(4, '0')}`,
				category: CATEGORIES[i % CATEGORIES.length],
				price: 100 + ((i * 37) % 900),
				createdAt: new Date(Date.UTC(2023, 0, 1) + i * 20 * 24 * 3600 * 1000),
				rank: count - i,
				name: `Widget ${i}`,
			});
		}
		return { ok: true, count };
	}
}

// GET /Snapshot/?which=live|concurrent|arrayForm -> current state of the held object.
export class Snapshot extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const which = qget(query, 'which') || 'live';
		if (which === 'concurrent') return concurrentConditions;
		if (which === 'arrayForm') return arrayFormConditions;
		return liveConditions;
	}
}

// GET /RunOnce/?sortAttr=&desc=&limit=&offset=&select= -> ONE query against liveConditions.
export class RunOnce extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const sortAttr = qget(query, 'sortAttr');
		const desc = qget(query, 'desc') === 'true';
		const limit = qget(query, 'limit');
		const offset = qget(query, 'offset');
		const select = qget(query, 'select');
		const options = { conditions: liveConditions };
		if (sortAttr) options.sort = { attribute: sortAttr, descending: desc };
		if (limit != null) options.limit = Number(limit);
		if (offset != null) options.offset = Number(offset);
		if (select) options.select = select.split(',');
		const ids = [];
		for await (const r of tables.Product.search(options)) ids.push(r.id);
		return { ids, count: ids.length, conditionsAfter: liveConditions };
	}
}

// GET /RunArrayForm/?sortAttr= -> reuses arrayFormConditions. Without sortAttr, uses the
// bare-array TARGET form (search(array)); with sortAttr, wraps in object form (sort has no
// slot on a bare-array target) while still pointing `.conditions` at the SAME shared array.
export class RunArrayForm extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const sortAttr = qget(query, 'sortAttr');
		const ids = [];
		if (sortAttr) {
			for await (const r of tables.Product.search({ conditions: arrayFormConditions, sort: { attribute: sortAttr } }))
				ids.push(r.id);
		} else {
			for await (const r of tables.Product.search(arrayFormConditions)) ids.push(r.id);
		}
		return { ids, count: ids.length, conditionsAfter: arrayFormConditions };
	}
}

// GET /RunConcurrent/?n=&sortAttr=&desc= -> fire N queries in TRUE parallel (Promise.all,
// same JS event loop / same worker thanks to threads.count:1) sharing ONE conditions object.
export class RunConcurrent extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const n = Number(qget(query, 'n')) || 8;
		const sortAttr = qget(query, 'sortAttr');
		const desc = qget(query, 'desc') === 'true';
		const runOne = async () => {
			const options = { conditions: concurrentConditions };
			if (sortAttr) options.sort = { attribute: sortAttr, descending: desc };
			const ids = [];
			for await (const r of tables.Product.search(options)) ids.push(r.id);
			return ids;
		};
		const runs = await Promise.all(Array.from({ length: n }, runOne));
		return { runs, conditionsAfter: concurrentConditions };
	}
}

// GET /Count/ -> plain count query using liveConditions, no sort (the "count" leg of the
// paginated-sweep + count + live-refresh workload).
export class Count extends Resource {
	static loadAsInstance = false;
	async get() {
		let count = 0;
		for await (const _r of tables.Product.search({ conditions: liveConditions })) count++;
		return { count, conditionsAfter: liveConditions };
	}
}
