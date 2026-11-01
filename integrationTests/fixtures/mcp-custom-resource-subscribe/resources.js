// Custom MCP resources with `subscribe` (#3250). `notes:///{id}` returns an
// in-memory change stream with `end()`; `notes-return:///{id}` one released only
// through its iterator's `return()`; `rows:///{id}` subscribes through the Note
// table under the session user; `plain:///readme` declares no subscribe.
// Probe (REST) reports what the subscribe methods saw and emits changes; the
// suite runs one worker, so this state is the state the MCP session uses.
import { RequestTarget, getUser } from 'harper';

const state = (globalThis.__MCP_SUBSCRIBE_3250__ ??= { subscribes: [], released: [], streams: new Map() });

// One open stream per id: a later subscribe for the same id replaces the entry.
class NoteStream {
	constructor(id, kind) {
		this.id = id;
		this.kind = kind;
		this.buffered = [];
		this.resolveNext = null;
		this.closed = false;
		state.streams.set(id, this);
	}
	push(value) {
		if (this.closed) return;
		if (this.resolveNext) {
			this.resolveNext({ done: false, value });
			this.resolveNext = null;
		} else this.buffered.push(value);
	}
	close(via) {
		if (this.closed) return;
		this.closed = true;
		state.released.push({ id: this.id, via });
		if (state.streams.get(this.id) === this) state.streams.delete(this.id);
		if (this.resolveNext) {
			this.resolveNext({ done: true, value: undefined });
			this.resolveNext = null;
		}
	}
	[Symbol.asyncIterator]() {
		return {
			next: () => {
				if (this.buffered.length) return Promise.resolve({ done: false, value: this.buffered.shift() });
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve) => (this.resolveNext = resolve));
			},
			return: () => {
				this.close('return');
				return Promise.resolve({ done: true, value: undefined });
			},
		};
	}
}

class EndableNoteStream extends NoteStream {
	end() {
		this.close('end');
	}
}

function recordSubscribe(resource, kind, params, context) {
	state.subscribes.push({
		kind,
		params,
		contextUser: context.user?.username,
		instanceUser: resource.getContext()?.user?.username,
		ambientUser: getUser()?.username,
		profile: context.profile,
	});
}

export class NotesMcp extends Resource {
	readNote(params) {
		return { text: `note ${params.id}`, mimeType: 'text/plain' };
	}
	readReadme() {
		return 'readme';
	}
	async readRow(params) {
		return { text: JSON.stringify((await tables.Note.get(params.id)) ?? null), mimeType: 'application/json' };
	}
	watchNote(params, context) {
		recordSubscribe(this, 'notes', params, context);
		if (params.id === 'broken') throw new Error('note source unavailable: sk-secret-3250');
		return new EndableNoteStream(params.id, 'end');
	}
	watchNoteReturnOnly(params, context) {
		recordSubscribe(this, 'notes-return', params, context);
		return new NoteStream(params.id, 'return');
	}
	watchRow(params, context) {
		recordSubscribe(this, 'rows', params, context);
		const target = new RequestTarget();
		target.id = params.id;
		target.omitCurrent = true;
		target.checkPermission = true;
		// single-arg: runs under the user-carrying transaction the MCP layer opened
		return tables.Note.subscribe(target);
	}
}

NotesMcp.mcpResources = [
	{
		uriTemplate: 'notes:///{id}',
		name: 'note',
		description: 'A note; subscribe to hear when it changes',
		mimeType: 'text/plain',
		method: 'readNote',
		subscribe: 'watchNote',
	},
	{
		uriTemplate: 'notes-return:///{id}',
		name: 'note (return-only stream)',
		description: 'A note whose change stream is released through return()',
		mimeType: 'text/plain',
		method: 'readNote',
		subscribe: 'watchNoteReturnOnly',
	},
	{
		uriTemplate: 'rows:///{id}',
		name: 'note row',
		description: 'A Note row, watched through the table',
		mimeType: 'application/json',
		method: 'readRow',
		subscribe: 'watchRow',
	},
	{ uri: 'plain:///readme', name: 'readme', description: 'Not subscribable', method: 'readReadme' },
];

export class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		return { subscribes: state.subscribes, released: state.released, open: [...state.streams.keys()] };
	}
	// POST /Probe/ { id } emits one change on that id's open stream
	static async post(_target, data) {
		const { id } = (await data) ?? {};
		const stream = state.streams.get(id);
		stream?.push({ id });
		return { delivered: !!stream };
	}
}
