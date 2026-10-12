import { ClientError } from '../utility/errors/hdbError.ts';
import { Readable } from 'node:stream';
import type { ResourceBodyPart } from './ResourceInterface.ts';

export const RESOLVE_BODY = Symbol('resolveBody');

export function resolveBody(data: any, collectForms = true, onResolved?: (data: any) => any): any {
	if (typeof data?.then === 'function') return data.then((value: any) => resolveBody(value, collectForms, onResolved));
	if (
		collectForms &&
		typeof data?.[Symbol.asyncIterator] === 'function' &&
		!(data instanceof Readable) &&
		!(data instanceof ReadableStream)
	) {
		const resolved = typeof data[RESOLVE_BODY] === 'function' ? data[RESOLVE_BODY]() : collectFormData(data);
		return onResolved ? resolved.then(onResolved) : resolved;
	}
	return onResolved ? onResolved(data) : data;
}

export async function collectFormData(
	body: AsyncIterable<ResourceBodyPart>,
	materialize: (value: unknown) => unknown = (value) => value
): Promise<Record<string, unknown>> {
	const form: Record<string, unknown> = {};
	const repeated = new Set<string>();
	for await (const part of body) {
		if (
			!part ||
			typeof part.name !== 'string' ||
			!Object.hasOwn(part, 'name') ||
			!Object.hasOwn(part, 'value') ||
			Object.keys(part).length !== 2
		)
			throw new ClientError('Expected a request body part with name and value');
		const { name } = part;
		if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype')
			throw new ClientError(`Multipart field "${name}" is not allowed`, 400);
		const value = await materialize(part.value);
		if (repeated.has(name)) (form[name] as unknown[]).push(value);
		else if (Object.hasOwn(form, name)) {
			form[name] = [form[name], value];
			repeated.add(name);
		} else form[name] = value;
	}
	return form;
}
