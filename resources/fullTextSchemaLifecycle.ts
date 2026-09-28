import { ClientError } from '../utility/errors/hdbError.ts';
import {
	compileFullTextDefinition,
	compileFullTextDefinitions,
	compileValidFullTextDefinitions,
	sortFullTextDefinitions,
	type FullTextDefinition,
	type FullTextSchemaAttribute,
} from './fullTextSchema.ts';

export type FullTextWarning = (message: string) => void;

export function serializeFullTextState(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? `${entry}n` : entry));
	} catch {
		return Object.prototype.toString.call(value);
	}
}

export function definitionsEqual(left: unknown, right: unknown): boolean {
	return serializeFullTextState(left ?? []) === serializeFullTextState(right ?? []);
}

export function readPersistedFullTextDefinitions(
	values: unknown,
	attributes: readonly FullTextSchemaAttribute[],
	warn: FullTextWarning
): FullTextDefinition[] {
	if (values === undefined) return [];
	return compileValidFullTextDefinitions(values, attributes, (value, error) => {
		const name = typeof (value as any)?.name === 'string' ? ` '${(value as any).name}'` : '';
		warn(`Ignoring invalid persisted @fullText declaration${name}: ${error.message}`);
	});
}

export function retainFullTextDefinitions(
	values: unknown,
	durableAttributes: readonly FullTextSchemaAttribute[],
	requestedAttributes: readonly FullTextSchemaAttribute[],
	warn: FullTextWarning
): FullTextDefinition[] {
	const durable = readPersistedFullTextDefinitions(values, durableAttributes, warn);
	return compileFullTextDefinitions(durable, requestedAttributes);
}

export function mergePeerFullTextDefinitions(
	persistedValues: unknown,
	incomingValues: unknown,
	attributes: readonly FullTextSchemaAttribute[],
	warn: FullTextWarning
): { values: unknown; definitions: FullTextDefinition[]; changed: boolean } {
	if (!Array.isArray(incomingValues)) {
		warn('Ignoring peer @fullText declarations because the incoming value is not a list');
		return {
			values: persistedValues,
			definitions: readPersistedFullTextDefinitions(persistedValues, attributes, warn),
			changed: false,
		};
	}

	const merged = readPersistedFullTextDefinitions(persistedValues ?? [], attributes, warn);
	const persistedByName = new Map<string, unknown>();
	for (const definition of merged) {
		if (typeof (definition as any)?.name === 'string') persistedByName.set((definition as any).name, definition);
	}
	for (const value of incomingValues) {
		let incoming: FullTextDefinition;
		try {
			incoming = compileFullTextDefinition(value, attributes);
		} catch (error) {
			if (!(error instanceof ClientError)) throw error;
			warn(`Ignoring invalid peer @fullText declaration: ${error.message}`);
			continue;
		}
		const existing = persistedByName.get(incoming.name);
		if (existing !== undefined) {
			let matches = false;
			try {
				matches = definitionsEqual(compileFullTextDefinition(existing, attributes), incoming);
			} catch (error) {
				if (!(error instanceof ClientError)) throw error;
			}
			if (!matches)
				warn(`Ignoring peer redefinition of @fullText index '${incoming.name}'; the local schema is authoritative`);
			continue;
		}
		merged.push(incoming);
		persistedByName.set(incoming.name, incoming);
	}

	const definitions = sortFullTextDefinitions(merged);
	return { values: definitions, definitions, changed: !definitionsEqual(persistedValues, definitions) };
}
