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
