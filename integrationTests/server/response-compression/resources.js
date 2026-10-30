import { Readable } from 'node:stream';

const records = (count) => Array.from({ length: count }, (_, n) => ({ n, label: `record number ${n}` }));

export class BigObject extends Resource {
	static loadAsInstance = false;
	get() {
		return { records: records(200) };
	}
}

export class BigArray extends Resource {
	static loadAsInstance = false;
	get() {
		return records(200);
	}
}

export class SmallArray extends Resource {
	static loadAsInstance = false;
	get() {
		return [1, 2, 3];
	}
}

export class StreamedArray extends Resource {
	static loadAsInstance = false;
	async get() {
		async function* generate() {
			for (const record of records(200)) yield record;
		}
		return generate();
	}
}

const rowCounts = { opened: 0, stepped: 0, returned: 0 };

class CountedIterable {
	constructor(delay) {
		this.delay = delay;
	}
	[Symbol.asyncIterator]() {
		rowCounts.opened++;
		const delay = this.delay;
		let n = 0;
		return {
			async next() {
				if (n >= 200) return { value: undefined, done: true };
				rowCounts.stepped++;
				if (delay) await new Promise((r) => setTimeout(r, delay));
				return { value: { n, label: `record number ${n++}` }, done: false };
			},
			async return(value) {
				rowCounts.returned++;
				return { value, done: true };
			},
		};
	}
}

export class CountedRows extends Resource {
	static loadAsInstance = false;
	get() {
		return new CountedIterable(0);
	}
}

export class SlowCountedRows extends Resource {
	static loadAsInstance = false;
	get() {
		return new CountedIterable(20);
	}
}

// read and reset
export class RowCounts extends Resource {
	static loadAsInstance = false;
	get() {
		const counts = { ...rowCounts };
		rowCounts.opened = rowCounts.stepped = rowCounts.returned = 0;
		return counts;
	}
}

export class Health extends Resource {
	static loadAsInstance = false;
	get() {
		return { ok: true };
	}
}

server.contentTypes.set('application/x-compression-iterator', {
	*serializeStream() {
		yield 'one';
		yield 'two';
	},
});

server.contentTypes.set('application/x-compression-async-iterator', {
	async *serializeStream() {
		yield 'one';
		yield 'two';
	},
});

server.contentTypes.set('application/x-compression-failing-stream', {
	serializeStream() {
		return Readable.from(
			(async function* () {
				yield 'first chunk ';
				throw new Error('compression-source-failure');
			})()
		);
	},
});
