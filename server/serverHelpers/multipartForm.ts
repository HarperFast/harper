import busboy from 'busboy';
import { Readable, Transform } from 'node:stream';
import { Blob, createBlob } from '../../resources/blob.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import { get } from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { collectFormData, RESOLVE_BODY } from '../../resources/resolveBody.ts';
import type { ResourceBodyPart } from '../../resources/ResourceInterface.ts';

type FormValue = string | Blob;
type FormPart = { name: string; value: FormValue | Promise<Blob>; file?: Readable };
type MultipartInput = AsyncIterable<Uint8Array> & {
	destroy?: () => void;
	afterResponse?: (callback: () => void) => () => void;
};

function withFileName(blob: Blob, name?: string): Blob {
	// Bun's inherited name setter does not create the own property copied by the record encoder.
	return Object.defineProperty(blob, 'name', { value: name, enumerable: true, writable: true, configurable: true });
}

export async function deserializeMultipartForm(data: Buffer, contentType = ''): Promise<object> {
	return collectFormData(new MultipartFormBody(Readable.from([data]), contentType, false));
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

class MultipartFormBody implements AsyncIterableIterator<ResourceBodyPart<FormValue>> {
	#error?: Error;
	#stopped = false;
	#started = false;
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
				// busboy signals partsLimit when reaching it, before admitting the next part.
				limits: { fieldSize: 1024 * 1024, fields: 64, files: 64, parts: 129 },
			});
		} catch (error) {
			throw new ClientError(error, 400);
		}
		const source = Readable.from(input, { objectMode: false });
		const files = new Set<Readable>();
		const maximumSize = get(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE) ?? 10_000_000;
		let size = 0;
		const exceedsLimit = (chunk: Uint8Array) => {
			size += chunk.length;
			return size > maximumSize;
		};
		let canceled = false;
		const counter = new Transform({
			transform(chunk, _encoding, done) {
				done(
					exceedsLimit(chunk)
						? new ClientError(`Request body too large, maximum size is ${maximumSize} bytes`, 413)
						: null,
					chunk
				);
			},
		});
		const fail = (error: Error, clientFault = true) => {
			// Discarded files must not turn an intentional iterator return into a request failure.
			if (canceled) return;
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
			for (const file of files) file.destroy(this.error ?? new ServerError('Multipart file was not consumed'));
			parser.destroy();
			counter.destroy();
			// On Node, destroying an unread request closes its socket, so wait for the response first.
			if (!source.readableEnded && !source.destroyed) {
				source.on('data', (chunk) => {
					if (exceedsLimit(chunk)) source.pause();
				});
				if (size > maximumSize) source.pause();
				else source.resume();
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
			let value: Blob | Promise<Blob>;
			if (streamFiles) value = withFileName(createBlob(file, { type: info.mimeType }), info.filename);
			else {
				value = new Promise<Blob>((resolve, reject) => {
					const chunks: Buffer[] = [];
					file.on('data', (chunk) => chunks.push(chunk));
					file.on('end', () =>
						resolve(withFileName(createBlob(Buffer.concat(chunks), { type: info.mimeType }), info.filename))
					);
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

	async next(): Promise<IteratorResult<ResourceBodyPart<FormValue>>> {
		this.#started = true;
		if (this.#error) throw this.#error;
		if (this.#stopped || (this.#parts.destroyed && !this.#parts.readableEnded)) return { value: undefined, done: true };
		if (this.#previousFile && !this.#previousFile.readableEnded) {
			this.#error ??= new ServerError(
				'Consume each multipart Blob before reading the next part; commit staged Blob writes'
			);
			this.#parts.destroy(this.error);
		}
		const part = await this.#iterator.next();
		if (this.#error) throw this.#error;
		if (this.#stopped) return { value: undefined, done: true };
		if (part.done) return { value: undefined, done: true };
		this.#previousFile = part.value.file;
		const value = await part.value.value;
		if (this.#error) throw this.#error;
		if (this.#stopped) return { value: undefined, done: true };
		return { value: { name: part.value.name, value }, done: false };
	}

	async [RESOLVE_BODY](): Promise<Record<string, unknown>> {
		this.#assertCollectable();
		if (this.#started) throw new ServerError('Cannot collect a multipart body after consumption has started');
		this.#started = true;
		const form = await collectFormData(this, async (value: Blob & { name?: string }) => {
			if (!this.#previousFile) return value;
			const chunks: Buffer[] = [];
			for await (const chunk of this.#previousFile) chunks.push(chunk);
			return withFileName(createBlob(Buffer.concat(chunks), { type: value.type }), value.name);
		});
		this.#assertCollectable();
		return form;
	}

	#assertCollectable() {
		if (this.#error) throw this.#error;
		if (this.#stopped) throw new ServerError('Cannot collect a canceled multipart body');
	}

	async return(): Promise<IteratorResult<ResourceBodyPart<FormValue>>> {
		this.cancel();
		return { value: undefined, done: true };
	}

	cancel() {
		this.#stopped = true;
		this.#parts.destroy();
	}
}
