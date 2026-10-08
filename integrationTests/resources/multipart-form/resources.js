const progress = new Map();
const responses = new Map();

export class StreamingUpload extends tables.StoredUpload {
	static streamRequestBody = ['post'];

	async post(data, target) {
		const fields = {};
		const saved = [];
		const context = this.getContext();
		try {
			for await (const part of data) {
				for (const [name, value] of Object.entries(part)) {
					if (value instanceof Blob) {
						progress.set(target.id, { received: true, name: value.name });
						const id = `${target.id}-${saved.length}`;
						await tables.StoredUpload.put({ id, file: value }, { ...context, signal: context.signal, authorize: true });
						await context.transaction.commit();
						saved.push(id);
					} else fields[name] = value;
				}
			}
		} catch (error) {
			progress.set(target.id, { failed: true, message: error.message });
			throw error;
		}
		return { fields, saved };
	}
}

export class UploadProgress extends Resource {
	get(target) {
		return progress.get(target.id) ?? { received: false };
	}
}

export class ReadUpload extends Resource {
	async get(target) {
		const record = await tables.StoredUpload.get(target.id);
		if (!record) return;
		const text = await record.file.text();
		return { name: record.file.name, type: record.file.type, size: record.file.size, text };
	}
}

export class RefusedUpload extends Resource {
	static streamRequestBody = ['post'];

	allowCreate() {
		return false;
	}

	post() {
		throw new Error('A refused upload must not reach its method');
	}
}

export class IgnoredUpload extends Resource {
	static streamRequestBody = ['post', 'delete'];

	post() {
		return { ignored: true };
	}

	delete() {
		return true;
	}
}

export class UncommittedUpload extends StreamingUpload {
	async post(data, target) {
		for await (const part of data) {
			if (part.file) await tables.StoredUpload.put({ id: target.id, file: part.file });
		}
	}
}

export class SlowResponseUpload extends Resource {
	static streamRequestBody = ['post'];

	post(data, target) {
		return (async function* () {
			yield { message: 'first' };
			await new Promise((resolve) => responses.set(target.id, resolve));
			yield { message: 'last' };
		})();
	}
}

export class ReleaseUpload extends Resource {
	get(target) {
		responses.get(target.id)?.();
		responses.delete(target.id);
		return true;
	}
}
