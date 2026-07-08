const assert = require('assert');
const { getRecordAtTime, applyForward } = require('#src/resources/crdt');

// Build a mock audit history and the `store` shape getRecordAtTime expects. Each event is
// { version, type: 'put'|'patch'|'delete', value, previousVersion }. The audit store resolves an
// entry by its exact version (matching the real store, which is only ever queried by exact
// version via the previousVersion chain).
function makeStore(events) {
	const byVersion = new Map();
	for (const event of events) byVersion.set(event.version, event);
	const auditStore = {
		get(version) {
			const event = byVersion.get(version);
			if (!event) return undefined;
			return {
				type: event.type,
				previousVersion: event.previousVersion,
				getValue: () => event.value,
			};
		},
	};
	return { rootStore: { auditStore } };
}

// currentEntry mirrors the live record entry getRecordAtTime starts the reverse walk from.
function currentEntry(value, localTime) {
	return { value, localTime };
}

describe('crdt getRecordAtTime', () => {
	describe('record deleted then re-inserted under the same key (issue #1330)', () => {
		// put(n:1) -> patch(n:2) -> patch(n:3) -> delete -> put(n:4, re-insert, current)
		const events = [
			{ version: 10, type: 'put', value: { id: 'K', n: 1, label: 'a' }, previousVersion: 0 },
			{ version: 20, type: 'patch', value: { n: 2, label: 'b' }, previousVersion: 10 },
			{ version: 30, type: 'patch', value: { n: 3, label: 'c' }, previousVersion: 20 },
			{ version: 40, type: 'delete', value: null, previousVersion: 30 },
			{ version: 50, type: 'put', value: { id: 'K', n: 4, label: 'd' }, previousVersion: 40 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'K', n: 4, label: 'd' }, 50);

		it('reconstructs a pre-delete patch reached after crossing the delete (the crash case)', () => {
			// Without the fix this threw: TypeError: Cannot set properties of null (setting 'id').
			assert.deepStrictEqual(getRecordAtTime(current, 20, store, 1, 'K'), { id: 'K', n: 2, label: 'b' });
		});

		it('reconstructs the patch immediately before the delete (no base patch reversed)', () => {
			assert.deepStrictEqual(getRecordAtTime(current, 30, store, 1, 'K'), { id: 'K', n: 3, label: 'c' });
		});

		it('reconstructs the base put that precedes the delete', () => {
			assert.deepStrictEqual(getRecordAtTime(current, 10, store, 1, 'K'), { id: 'K', n: 1, label: 'a' });
		});
	});

	it('applies CRDT add operations forward when reconstructing across a delete', () => {
		// put(count:5) -> patch(+3) -> delete -> put(count:100, current); at the patch count is 8.
		const events = [
			{ version: 10, type: 'put', value: { id: 'C', count: 5 }, previousVersion: 0 },
			{ version: 20, type: 'patch', value: { count: { __op__: 'add', value: 3 } }, previousVersion: 10 },
			{ version: 30, type: 'delete', value: null, previousVersion: 20 },
			{ version: 40, type: 'put', value: { id: 'C', count: 100 }, previousVersion: 30 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'C', count: 100 }, 40);
		assert.deepStrictEqual(getRecordAtTime(current, 20, store, 1, 'C'), { id: 'C', count: 8 });
	});

	it('returns null when the record was in a deleted gap at the requested time', () => {
		// put -> delete -> put -> delete -> put(current). A timestamp inside the first deleted
		// gap is reached by crossing the newer delete, then finding the older delete as the
		// in-range boundary (no surviving base put) -> the record did not exist then.
		const events = [
			{ version: 10, type: 'put', value: { id: 'G', n: 1 }, previousVersion: 0 },
			{ version: 20, type: 'delete', value: null, previousVersion: 10 },
			{ version: 30, type: 'put', value: { id: 'G', n: 2 }, previousVersion: 20 },
			{ version: 40, type: 'delete', value: null, previousVersion: 30 },
			{ version: 50, type: 'put', value: { id: 'G', n: 3 }, previousVersion: 40 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'G', n: 3 }, 50);
		assert.strictEqual(getRecordAtTime(current, 25, store, 1, 'G'), null);
	});

	it('reconstructs a record whose first write was a patch (no preceding put) across a delete', () => {
		// A key created by an incremental update has type 'patch' with previousVersion 0 (no put).
		// patch(+5) -> delete -> put(re-insert, current); at the patch the record was { count: 5 }.
		const events = [
			{ version: 10, type: 'patch', value: { count: { __op__: 'add', value: 5 } }, previousVersion: 0 },
			{ version: 20, type: 'delete', value: null, previousVersion: 10 },
			{ version: 30, type: 'put', value: { id: 'P', count: 99 }, previousVersion: 20 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'P', count: 99 }, 30);
		assert.deepStrictEqual(getRecordAtTime(current, 15, store, 1, 'P'), { count: 5 });
	});

	it('reconstructs a record re-inserted via a patch after a delete', () => {
		// put -> delete -> patch(re-insert via add) -> delete -> put(current). At the re-insert
		// patch the record is rebuilt from an empty base bounded by the delete before it.
		const events = [
			{ version: 10, type: 'put', value: { id: 'R', count: 1 }, previousVersion: 0 },
			{ version: 20, type: 'delete', value: null, previousVersion: 10 },
			{ version: 30, type: 'patch', value: { count: { __op__: 'add', value: 7 } }, previousVersion: 20 },
			{ version: 40, type: 'delete', value: null, previousVersion: 30 },
			{ version: 50, type: 'put', value: { id: 'R', count: 100 }, previousVersion: 40 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'R', count: 100 }, 50);
		assert.deepStrictEqual(getRecordAtTime(current, 35, store, 1, 'R'), { count: 7 });
	});

	it('returns null for a timestamp in the most recent deleted gap (no newer delete)', () => {
		// put -> delete -> put(re-insert, current). A timestamp after the delete but before the
		// re-insert is reached as the reverse-walk boundary (no newer delete triggers
		// reconstructForward), so the boundary-delete check must return null.
		const events = [
			{ version: 10, type: 'put', value: { id: 'G', n: 1 }, previousVersion: 0 },
			{ version: 20, type: 'delete', value: null, previousVersion: 10 },
			{ version: 30, type: 'put', value: { id: 'G', n: 2 }, previousVersion: 20 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'G', n: 2 }, 30);
		assert.strictEqual(getRecordAtTime(current, 25, store, 1, 'G'), null);
	});

	it('reconstructs a value that existed before a later delete/re-insert cycle', () => {
		// put -> delete -> put -> delete -> put(current). A timestamp inside the FIRST live span
		// must skip the newer delete and find the first put as its base.
		const events = [
			{ version: 10, type: 'put', value: { id: 'G', n: 1 }, previousVersion: 0 },
			{ version: 20, type: 'delete', value: null, previousVersion: 10 },
			{ version: 30, type: 'put', value: { id: 'G', n: 2 }, previousVersion: 20 },
			{ version: 40, type: 'delete', value: null, previousVersion: 30 },
			{ version: 50, type: 'put', value: { id: 'G', n: 3 }, previousVersion: 40 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'G', n: 3 }, 50);
		assert.deepStrictEqual(getRecordAtTime(current, 15, store, 1, 'G'), { id: 'G', n: 1 });
	});

	it('does not crash when older history needed to fill unknowns has been pruned', () => {
		// patch(n:2)@10 [PRUNED] <- patch(n:3)@20 <- patch(n:4)@30 (current). Reconstructing before
		// the pruned base leaves `n` unknown and walks into the missing @10 entry.
		const events = [
			// version 10 intentionally absent from the store (pruned)
			{ version: 20, type: 'patch', value: { n: 3 }, previousVersion: 10 },
			{ version: 30, type: 'patch', value: { n: 4 }, previousVersion: 20 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'K', n: 4, label: 'c' }, 30);
		// `n` cannot be resolved (its prior value was pruned), so it keeps the live value; no throw.
		assert.deepStrictEqual(getRecordAtTime(current, 15, store, 1, 'K'), { id: 'K', n: 4, label: 'c' });
	});

	describe('records with no delete in history (reverse-walk path unchanged)', () => {
		// put(v:1) -> patch(v:2) -> patch(v:3, current)
		const events = [
			{ version: 10, type: 'put', value: { id: 'N', v: 1 }, previousVersion: 0 },
			{ version: 20, type: 'patch', value: { v: 2 }, previousVersion: 10 },
			{ version: 30, type: 'patch', value: { v: 3 }, previousVersion: 20 },
		];
		const store = makeStore(events);
		const current = currentEntry({ id: 'N', v: 3 }, 30);

		it('reverses patches back to an earlier patch state', () => {
			assert.deepStrictEqual(getRecordAtTime(current, 20, store, 1, 'N'), { id: 'N', v: 2 });
		});

		it('reverses patches back to the original put', () => {
			assert.deepStrictEqual(getRecordAtTime(current, 10, store, 1, 'N'), { id: 'N', v: 1 });
		});
	});
});

describe('crdt applyForward', () => {
	it('overwrites plain values and applies add operations', () => {
		const record = { id: 'A', count: 5, label: 'old' };
		applyForward(record, { label: 'new', count: { __op__: 'add', value: 2 } });
		assert.deepStrictEqual(record, { id: 'A', count: 7, label: 'new' });
	});

	it('throws on an unsupported operation', () => {
		assert.throws(() => applyForward({}, { x: { __op__: 'multiply', value: 2 } }), /Unsupported operation multiply/);
	});
});
