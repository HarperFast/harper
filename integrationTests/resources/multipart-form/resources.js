import { t } from 'harper';

const progress = new Map();
const responses = new Map();

export class StreamingUpload extends tables.StoredUpload {
	static async post(target, data, context) {
		data = await data;
		if (!data?.[Symbol.asyncIterator]) {
			throw Object.assign(new Error('Expected multipart/form-data'), { statusCode: 415 });
		}
		const fields = {};
		const saved = [];
		try {
			for await (const { name, value } of data) {
				if (value instanceof Blob) {
					progress.set(target.id, { received: true, name: value.name });
					const id = `${target.id}-${saved.length}`;
					await tables.StoredUpload.put({ id, file: value }, { ...context, signal: context.signal, authorize: true });
					await context.transaction.commit();
					saved.push(id);
				} else fields[name] = value;
			}
		} catch (error) {
			progress.set(target.id, { failed: true, message: error.message });
			throw error;
		}
		return { fields, saved };
	}
}

export class DelegatedUpload extends Resource {
	static post(target, data) {
		progress.set(target.id, { streamed: typeof data?.[Symbol.asyncIterator] === 'function' });
		return super.post(target, data).catch((error) => {
			progress.set(target.id, { failed: true });
			throw error;
		});
	}

	async allowCreate(_user, data) {
		this.authorized = data;
		return (
			data.title === 'allowed' &&
			!(data instanceof Promise) &&
			(!data.file || (await data.file.text()).startsWith('payload'))
		);
	}

	async post(data, target) {
		if (data !== this.authorized) throw new Error('Authorization and post must share the body');
		if (data.file) await tables.StoredUpload.put({ id: target.id, title: data.title, file: data.file });
		return {
			title: data.title,
			tag: data.tag,
			streamed: progress.get(target.id).streamed,
			files: await Promise.all(
				(data.attachments ?? []).map(async (file) => ({ name: file.name, text: await file.text() }))
			),
		};
	}
}

export class SchemaUpload extends Resource.withSchema({
	post: { body: t.object({ title: t.string }) },
}) {
	post(_target, data) {
		return data;
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
	allowCreate() {
		return false;
	}
	post() {
		throw new Error('A refused upload must not reach its method');
	}
}

export class IgnoredUpload extends Resource {
	static post() {
		return { ignored: true };
	}
	static delete() {
		return true;
	}
}

export class SelectedFieldUpload extends Resource {
	static async post(target, data) {
		let title;
		for await (const { name, value } of data) {
			if (name === 'title') title = value;
			break;
		}
		progress.set(target.id, { returned: true });
		await new Promise((resolve) => responses.set(target.id, resolve));
		return { title };
	}
}

export class UncommittedUpload extends StreamingUpload {
	static async post(target, data) {
		for await (const { name, value } of data) {
			if (name === 'file') await tables.StoredUpload.put({ id: target.id, file: value });
		}
	}
}

export class UncommittedReturnUpload extends StreamingUpload {
	static async post(target, data) {
		const { value: part } = await data.next();
		await tables.StoredUpload.put({ id: target.id, file: part.value });
		return { ok: true };
	}
}

export class SlowResponseUpload extends Resource {
	static post(target) {
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
