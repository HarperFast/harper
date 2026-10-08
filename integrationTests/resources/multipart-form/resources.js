const progress = new Map();

export class StreamingUpload extends tables.StoredUpload {
	static streamRequestBody = ['post'];

	async post(data, target) {
		const fields = {};
		const saved = [];
		try {
			for await (const part of data) {
				for (const [name, value] of Object.entries(part)) {
					if (value instanceof Blob) {
						progress.set(target.id, { received: true, name: value.name });
						const id = `${target.id}-${saved.length}`;
						await tables.StoredUpload.put({ id, file: value });
						await this.getContext().transaction.commit();
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
	static streamRequestBody = ['post'];

	post() {
		return { ignored: true };
	}
}
