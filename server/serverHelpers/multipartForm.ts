import busboy from 'busboy';
import { Readable, Transform } from 'node:stream';
import { Blob, createBlob } from '../../resources/blob.ts';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { get } from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';

type FormValue = string | Blob;
type FormPart = { name: string; value: FormValue | Promise<Blob>; file?: Readable };
type MultipartInput = AsyncIterable<Uint8Array> & {
	destroy?: () => void;
	afterResponse?: (callback: () => void) => () => void;
};

export async function deserializeMultipartForm(data: Buffer, contentType: string): Promise<object> {
	const form = {};
	for await (const part of new MultipartFormBody(Readable.from([data]), contentType, false)) {
		for (const name of Object.keys(part)) {
			const value = part[name];
			if (Object.hasOwn(form, name)) {
				const previous = form[name];
				if (Array.isArray(previous)) previous.push(value);
				else form[name] = [previous, value];
			} else form[name] = value;
		}
	}
	return form;
}

export function deserializeMultipartStream(
	input: MultipartInput,
	contentType: string,
	signal?: AbortSignal
): MultipartFormBody {
	return new MultipartFormBody(input, contentType, true, signal);
}

export function completeMultipartBody(data: unknown, result: any): any {
	if (!(data instanceof MultipartFormBody)) return result;
	return Promise.resolve(result).then(
		(value) => {
			const error = data.error;
			data.cancel();
			if (error) throw error;
			return value;
		},
		(error) => {
			data.cancel();
			throw error;
		}
	);
}

export function cancelMultipartBody(data: unknown): void {
	if (data instanceof MultipartFormBody) data.cancel();
}

class MultipartFormBody implements AsyncIterableIterator<Record<string, FormValue>> {
	#error?: Error;
	#parts: Readable;
	#iterator: AsyncIterator<FormPart>;
	#previousFile?: Readable;
	#cancel: () => void;

	constructor(input: MultipartInput, contentType: string, streamFiles: boolean, signal?: AbortSignal) {
		let parser: ReturnType<typeof busboy>;
		try {
			parser = busboy({
				headers: { 'content-type': contentType },
				defParamCharset: 'utf8',
				limits: { fieldSize: 1024 * 1024, fields: 64, files: 64, parts: 128 },
			});
		} catch (error) {
			throw new ClientError(error, 400);
		}
		const source = Readable.from(input, { objectMode: false });
		const files = new Set<Readable>();
		const maximumSize = get(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE) ?? 10_000_000;
		let size = 0;
		let canceled = false;
		const counter = new Transform({
			transform(chunk, _encoding, done) {
				size += chunk.length;
				done(
					size > maximumSize
						? new ClientError(`Request body too large, maximum size is ${maximumSize} bytes`, 413)
						: null,
					chunk
				);
			},
		});
		const fail = (error: Error, clientFault = true) => {
			this.#error ??=
				clientFault && !(error as Error & { statusCode?: number }).statusCode ? new ClientError(error, 400) : error;
			this.#parts.destroy(this.error);
		};
		this.#cancel = () => {
			if (canceled) return;
			canceled = true;
			signal?.removeEventListener('abort', abort);
			source.unpipe(counter);
			counter.unpipe(parser);
			for (const file of files) file.destroy(this.error ?? new ClientError('Multipart file was not consumed', 400));
			parser.destroy();
			counter.destroy();
			// On Node, destroying an unread request closes its socket, so wait for the response first.
			if (!source.readableEnded && !source.destroyed) {
				source.resume();
				let grace: NodeJS.Timeout;
				const startGrace = () => {
					grace = setTimeout(() => {
						input.destroy?.();
						source.destroy();
					}, 1000);
					grace.unref();
				};
				const detach = input.afterResponse?.(startGrace);
				if (!input.afterResponse) startGrace();
				source.once('close', () => {
					clearTimeout(grace);
					detach?.();
				});
			}
		};
		this.#parts = new Readable({
			objectMode: true,
			read() {},
			destroy: (error, done) => {
				this.#cancel();
				done(error);
			},
		});
		this.#parts.on('error', () => {});
		this.#iterator = this.#parts[Symbol.asyncIterator]();
		const abort = () => fail(new ClientError('Multipart request aborted', 400));
		const checkName = (name: string) => {
			if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') {
				fail(new ClientError(`Multipart field "${name}" is not allowed`, 400));
				return false;
			}
			return !canceled;
		};
		parser.on('field', (name, value, info) => {
			if (info.valueTruncated || info.nameTruncated) {
				fail(new ClientError('Multipart field too large', 413));
				return;
			}
			if (checkName(name)) this.#parts.push({ name, value });
		});
		parser.on('file', (name, file, info) => {
			// busboy destroys itself before notifying files of a parse failure; consumer errors leave it live.
			file.on('error', (error) => fail(error, parser.destroyed));
			files.add(file);
			file.once('close', () => files.delete(file));
			if (!checkName(name)) {
				file.destroy(this.error);
				return;
			}
			const decorate = (blob: Blob) => Object.assign(blob, { name: info.filename });
			let value: Blob | Promise<Blob>;
			if (streamFiles) value = decorate(createBlob(file, { type: info.mimeType }));
			else {
				value = new Promise<Blob>((resolve, reject) => {
					const chunks: Buffer[] = [];
					file.on('data', (chunk) => chunks.push(chunk));
					file.on('end', () => resolve(decorate(createBlob(Buffer.concat(chunks), { type: info.mimeType }))));
					file.on('error', reject);
				});
				value.catch(() => {});
			}
			this.#parts.push({ name, value, file: streamFiles ? file : undefined });
		});
		for (const event of ['fieldsLimit', 'filesLimit', 'partsLimit'])
			parser.on(event, () => fail(new ClientError('Too many multipart parts', 413)));
		parser.on('error', fail);
		counter.on('error', fail);
		source.on('error', fail);
		parser.on('close', () => {
			if (!canceled) this.#parts.push(null);
		});
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		else source.pipe(counter).pipe(parser);
	}

	[Symbol.asyncIterator]() {
		return this;
	}

	get error() {
		return this.#error;
	}

	async next(): Promise<IteratorResult<Record<string, FormValue>>> {
		if (this.#error) throw this.#error;
		if (this.#parts.destroyed && !this.#parts.readableEnded) return { value: undefined, done: true };
		if (this.#previousFile && !this.#previousFile.readableEnded) {
			this.#error ??= new ClientError(
				'Consume each multipart Blob before reading the next part; commit staged Blob writes',
				400
			);
			this.#parts.destroy(this.error);
		}
		const part = await this.#iterator.next();
		if (this.#error) throw this.#error;
		if (part.done) return { value: undefined, done: true };
		this.#previousFile = part.value.file;
		const value = await part.value.value;
		if (this.#error) throw this.#error;
		return { value: { [part.value.name]: value }, done: false };
	}

	async return(): Promise<IteratorResult<Record<string, FormValue>>> {
		this.cancel();
		return { value: undefined, done: true };
	}

	cancel() {
		this.#parts.destroy();
	}
}
