const { Quote } = tables;

// one worker thread, so the origin state set through /Origin/ is the state the source reads
let value = 'v1';
let mode = 'ok';
let calls = 0;
let release;

Quote.sourcedFrom(
	class Origin extends Resource {
		async get() {
			calls++;
			if (mode === 'hold') await new Promise((resolve) => (release = resolve));
			if (mode === 'fail') throw Object.assign(new Error('origin down'), { statusCode: 500 });
			return { id: this.getId(), value };
		}
		allowStaleWhileRevalidate() {
			return true;
		}
	}
);

export class Origin extends Resource {
	static loadAsInstance = false;
	post(target, body) {
		value = body.value ?? value;
		mode = body.mode ?? mode;
		if (mode !== 'hold') release?.();
		return { value, mode, calls };
	}
}
