import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

interface MultipartFile {
	name: string;
	filename: string;
	contentType?: string;
	stream: Readable;
}

interface MultipartBody {
	boundary: string;
	contentType: string;
	stream: Readable;
}

/**
 * Build a streaming multipart/form-data body for the operations API.
 *
 * Fields are emitted first, in the order they appear in the `fields` record, then the
 * single (optional) file part. That ordering is required by the server-side multipart
 * parser (`server/serverHelpers/multipartParser.ts`): dispatching fields like `operation`
 * must arrive before the file so preValidation/auth hooks can see them, and the file
 * always comes last so the route handler streams it into extraction.
 *
 * Each field value is JSON-stringified — the server parser will reverse that on values
 * that look like JSON, otherwise leave them as raw strings.
 */
export function buildMultipartBody(fields: Record<string, unknown>, file?: MultipartFile): MultipartBody {
	const boundary = '----HarperMultipart' + randomBytes(12).toString('hex');
	const stream = Readable.from(generateParts(boundary, fields, file));
	return {
		boundary,
		contentType: `multipart/form-data; boundary=${boundary}`,
		stream,
	};
}

async function* generateParts(
	boundary: string,
	fields: Record<string, unknown>,
	file: MultipartFile | undefined
): AsyncGenerator<Buffer> {
	const dashBoundary = `--${boundary}`;
	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		yield Buffer.from(
			`${dashBoundary}\r\nContent-Disposition: form-data; name="${escapeFieldName(name)}"\r\n\r\n${serializeFieldValue(value)}\r\n`
		);
	}
	if (file) {
		const contentType = file.contentType ?? 'application/octet-stream';
		yield Buffer.from(
			`${dashBoundary}\r\nContent-Disposition: form-data; name="${escapeFieldName(file.name)}"; filename="${escapeFieldName(file.filename)}"\r\nContent-Type: ${contentType}\r\n\r\n`
		);
		for await (const chunk of file.stream) {
			yield typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
		}
		yield Buffer.from('\r\n');
	}
	yield Buffer.from(`${dashBoundary}--\r\n`);
}

function serializeFieldValue(value: unknown): string {
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

function escapeFieldName(name: string): string {
	// Strip CR/LF and quote characters that would break the Content-Disposition header.
	// Field/file names are caller-controlled CLI values so this is defense-in-depth, not
	// untrusted-input sanitization.
	return name.replace(/[\r\n"]/g, '');
}
