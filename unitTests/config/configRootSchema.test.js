'use strict';

const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { CONFIG_PARAM_MAP, STUDIO_CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getCachedCertificateVerificationConfig } = require('#src/security/certificateVerification/verificationConfig');
const { configValidator, effectiveConfigValidator } = require('#src/validation/configValidator');
const { flattenConfig } = require('#src/config/configUtils');
const { convertToMS } = require('#src/utility/common_utils');
const { supportedCompression } = require('../rocksdbBindings.mts').rocksdbBindings();
require('#src/utility/rocksCompressionSupport');
const schema = require('../../config-root.schema.json');

const defaults = YAML.parse(readFileSync(join(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));

// Harper reads these straight from the YAML, but no config parameter names them (harper#4502).
const UNREGISTERED_SETTINGS = new Set(['logging.path', 'logging.external.root', 'logging.external.stdStreams']);

const WRITABLE_PARAMS = new Set([...Object.keys(CONFIG_PARAM_MAP), ...Object.values(STUDIO_CONFIG_PARAMS)]);

function resolveRef(node) {
	return node.$ref ? schema.definitions[node.$ref.slice('#/definitions/'.length)] : node;
}

function shapesOf(node) {
	const resolved = resolveRef(node);
	const shapes = (resolved.oneOf ?? resolved.anyOf)?.map(resolveRef) ?? [resolved];
	return [...shapes, ...(resolved.allOf ?? []).flatMap(shapesOf)];
}

function objectShape(node) {
	return shapesOf(node).find((shape) => shape.properties);
}

function* schemaNodes(node, path = []) {
	yield { node, path };
	for (const shape of shapesOf(node)) {
		for (const [name, child] of Object.entries(shape.properties ?? {})) yield* schemaNodes(child, [...path, name]);
	}
}

function isSetting(node) {
	return shapesOf(node).some((shape) => !shape.properties);
}

const paramName = (path) => path.join('_').toLowerCase();

function isWritable(path) {
	return path.some((_, i) => WRITABLE_PARAMS.has(paramName(path.slice(0, i + 1))));
}

function sampleValue(node) {
	const shape = objectShape(node) ?? shapesOf(node)[0];
	if (shape.properties)
		return Object.fromEntries(Object.entries(shape.properties).map(([name, child]) => [name, sampleValue(child)]));
	if (shape.enum) return shape.enum[0];
	if (shape.type === 'boolean') return true;
	if (shape.type === 'number') return 10000;
	throw new Error(`no sample value for schema type ${JSON.stringify(shape.type)}`);
}

function withValue(sample, path, value) {
	const copy = structuredClone(sample);
	path.slice(0, -1).reduce((parent, key) => parent[key], copy)[path.at(-1)] = value;
	return copy;
}

function revocationCheckAccepts(certificateVerification) {
	return getCachedCertificateVerificationConfig({ certificateVerification }) !== false;
}

function jsonType(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

/** Whether a leaf node admits a JSON value: the draft-06 keywords config-root.schema.json uses on leaves. */
function schemaAccepts(node, value) {
	node = resolveRef(node);
	if (node.allOf && !node.allOf.every((part) => schemaAccepts(part, value))) return false;
	if (node.anyOf && !node.anyOf.some((part) => schemaAccepts(part, value))) return false;
	if (node.oneOf && node.oneOf.filter((part) => schemaAccepts(part, value)).length !== 1) return false;
	if (node.not && schemaAccepts(node.not, value)) return false;
	if (node.const !== undefined && value !== node.const) return false;
	if (node.enum && !node.enum.includes(value)) return false;
	if (node.type) {
		const types = [node.type].flat();
		const type = jsonType(value);
		if (!types.includes(type) && !(type === 'integer' && types.includes('number'))) return false;
	}
	if (typeof value === 'number') {
		if (node.minimum !== undefined && value < node.minimum) return false;
		if (node.maximum !== undefined && value > node.maximum) return false;
		if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) return false;
		if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum) return false;
	}
	if (typeof value === 'string' && node.pattern !== undefined && !new RegExp(node.pattern).test(value)) return false;
	return true;
}

function schemaNodeAt(path) {
	return path.split('.').reduce((node, key) => objectShape(node).properties[key], schema);
}

/** The installed defaults with each `path: value` applied, as validateConfig() checks them. */
function joiAccepts(settings) {
	const config = { ...structuredClone(defaults), rootPath: '/tmp/harper-schema-test' };
	for (const [path, value] of Object.entries(settings)) {
		const keys = path.split('.');
		keys.slice(0, -1).reduce((node, key) => (node[key] ??= {}), config)[keys.at(-1)] = value;
	}
	return (
		(configValidator(structuredClone(config), true).error ?? effectiveConfigValidator(flattenConfig(config)).error) ===
		undefined
	);
}

/** The samples only the schema admits, and those only Joi admits. */
function disagreements(path, samples, extraSettings = {}) {
	const node = schemaNodeAt(path);
	const schemaOnly = [];
	const joiOnly = [];
	for (const value of samples) {
		const bySchema = schemaAccepts(node, value);
		const byJoi = joiAccepts({ ...extraSettings, [path]: value });
		if (bySchema && !byJoi) schemaOnly.push(value);
		if (byJoi && !bySchema) joiOnly.push(value);
	}
	return { schemaOnly, joiOnly };
}

const certificateVerificationBlocks = [...schemaNodes(schema)].filter(
	({ path }) => path.at(-1) === 'certificateVerification'
);

describe('config-root.schema.json matches the configuration Harper reads', () => {
	it('names every setting by a path a registered config parameter writes, itself or through a parent', () => {
		const unwritable = [];
		for (const { node, path } of schemaNodes(schema)) {
			if (path.length === 0 || !isSetting(node) || UNREGISTERED_SETTINGS.has(path.join('.'))) continue;
			if (!isWritable(path)) unwritable.push(path.join('.'));
		}
		assert.deepStrictEqual(unwritable, []);
	});

	it('exempts only settings the schema still declares and no config parameter writes', () => {
		const settings = new Set([...schemaNodes(schema)].map(({ path }) => path.join('.')));
		for (const path of UNREGISTERED_SETTINGS) {
			assert.ok(settings.has(path), `${path} is no longer in the schema`);
			assert.ok(!isWritable(path.split('.')), `${path} is now writable`);
		}
	});

	it('declares only certificateVerification options the revocation-check validator accepts', () => {
		for (const { node, path } of certificateVerificationBlocks) {
			const sample = sampleValue(node);
			assert.ok(revocationCheckAccepts(sample), `${path.join('.')}: ${JSON.stringify(sample)}`);
		}
		assert.deepStrictEqual(
			certificateVerificationBlocks.map(({ path }) => path.join('.')),
			[
				'http.mtls.certificateVerification',
				'replication.mtls.certificateVerification',
				'mqtt.network.mtls.certificateVerification',
			]
		);
	});

	it('bounds each certificateVerification number where the revocation-check validator does', () => {
		for (const { node, path: blockPath } of certificateVerificationBlocks) {
			const sample = sampleValue(node);
			for (const { node: leaf, path } of schemaNodes(node)) {
				if (shapesOf(leaf)[0].type !== 'number') continue;
				const label = [...blockPath, ...path].join('.');
				const { minimum } = shapesOf(leaf)[0];
				assert.strictEqual(typeof minimum, 'number', `${label} declares no minimum`);
				assert.ok(revocationCheckAccepts(withValue(sample, path, minimum)), `${label} rejects ${minimum}`);
				assert.ok(!revocationCheckAccepts(withValue(sample, path, minimum - 1)), `${label} accepts ${minimum - 1}`);
			}
		}
	});

	it('accepts the boolean crl and ocsp shorthand the revocation-check validator accepts', () => {
		for (const { node, path } of certificateVerificationBlocks) {
			const sample = sampleValue(node);
			for (const name of ['crl', 'ocsp']) {
				const label = [...path, name].join('.');
				assert.ok(
					shapesOf(objectShape(node).properties[name]).some((shape) => shape.type === 'boolean'),
					`${label} has no boolean form`
				);
				for (const value of [true, false]) assert.ok(revocationCheckAccepts(withValue(sample, [name], value)), label);
			}
		}
	});

	it('accepts a null certificateVerification, as the root config validator does', () => {
		for (const { node, path } of certificateVerificationBlocks)
			assert.ok(
				shapesOf(node).some((shape) => shape.type === 'null'),
				`${path.join('.')} rejects null`
			);
		const config = { ...structuredClone(defaults), rootPath: '/tmp/harper-schema-test' };
		config.http.mtls = { certificateVerification: null };
		config.replication = { ...config.replication, mtls: { certificateVerification: null } };
		config.mqtt.network.mtls = { certificateVerification: null };
		assert.strictEqual(configValidator(config, true).error, undefined);
	});

	it('requires mqtt.network, as the root config validator does whenever mqtt is present', () => {
		assert.deepStrictEqual(schema.properties.mqtt.required, ['network']);
		const config = { ...structuredClone(defaults), rootPath: '/tmp/harper-schema-test', mqtt: { webSocket: true } };
		assert.match(configValidator(config, true).error?.message ?? '', /'mqtt\.network' is required/);
		assert.strictEqual(configValidator({ ...config, mqtt: defaults.mqtt }, true).error, undefined);
	});

	it('bounds storage.reclamation to values its scheduler and eviction heuristic handle', () => {
		const { threshold, interval, evictionFactor } = schema.properties.storage.properties.reclamation.properties;
		assert.deepStrictEqual([threshold.minimum, threshold.maximum], [0, 1]);
		assert.strictEqual(evictionFactor.exclusiveMinimum, 0);
		assert.ok(convertToMS(interval.minimum) >= 1000);
		assert.ok(convertToMS(interval.maximum) <= 2 ** 31 - 1, 'setTimeout limit');
		const duration = new RegExp(interval.pattern);
		for (const accepted of ['1', '90', '30m', '1.5h', '1d'])
			assert.ok(duration.test(accepted) && convertToMS(accepted) >= 1000, accepted);
		for (const rejected of ['-1h', '0.001', '0.5', '10ms', '1M', '1y', 'soon', '25d', '600h', '597h', '35792m'])
			assert.ok(!duration.test(rejected), rejected);
		for (const accepted of ['24d', '596h', '35791m', '2147483', '0.5h']) assert.ok(duration.test(accepted), accepted);
	});

	const DURATION_SAMPLES = [
		...[0, 0.0005, 0.001, 0.5, 1, 30, 90, 2147483, 2147483.647, 2147483.648, 2147484, -1, -0.5],
		...['0', '0.0', '0s', '0.0m', '1', '30', '30s', '0.5s', '0.0005s', '0.001s', '5m', '0.5m', '0.05m', '0.01m'],
		...['0.0001m', '0.00001m', '1h', '1H', '1.5h', '0.5h', '0.000001h', '0.0000001h', '0.0000003h', '2D', '24d'],
		...['24.0d', '24.5d', '0.0000001d', '0.00000001d', '0.00000002d', '25d', '596h', '596.5h', '597h', '600h'],
		...['35791m', '35791.3m', '35792m'],
		...['2147483s', '2147483.6s', '2147484s', '-1s', '500ms', '1M', '0.5M', '1y', 'soon', '05m', '1e3', '30 s'],
		...[true, false, {}, [], null],
	];

	it('bounds each timer duration as Joi does, short of fractions near the ceiling and floor', () => {
		// The pattern takes whole units up to the ceiling and fractions only below the last whole unit
		// or with an early nonzero digit; a regex cannot state x * 60000 <= 2^31-1 exactly.
		const inSampleOrder = (values) => DURATION_SAMPLES.filter((value) => values.includes(value));
		const nearCeiling = ['2147483.6s', '35791.3m', '596.5h', '24.5d'];
		for (const path of [
			'storage.transactionLog.coolingInterval',
			'storage.maxTransactionQueueTime',
			'storage.longTransactionReportThreshold',
		])
			assert.deepStrictEqual(disagreements(path, DURATION_SAMPLES), {
				schemaOnly: [],
				joiOnly: inSampleOrder([...nearCeiling, '0.0000003h', '0.00000002d']),
			});
		assert.deepStrictEqual(disagreements('storage.reclamation.interval', DURATION_SAMPLES), {
			schemaOnly: [],
			joiOnly: inSampleOrder([...nearCeiling, '0.05m']),
		});
	});

	it('bounds the HTTP server options exactly as Joi does', () => {
		const samples = [
			-1,
			0,
			1,
			1.5,
			1000,
			30000,
			2147482647,
			2147482648,
			2147483647,
			2147483648,
			'30000',
			true,
			null,
			{},
		];
		for (const path of [
			'http.keepAliveTimeout',
			'http.timeout',
			'http.maxHeaderSize',
			'operationsApi.network.keepAliveTimeout',
			'operationsApi.network.timeout',
		])
			assert.deepStrictEqual(
				disagreements(path, [...samples, 2 ** 53 - 1, 2 ** 53]),
				{ schemaOnly: [], joiOnly: [] },
				path
			);
		// headersTimeout is also held to the request timeout, a rule between two keys the schema cannot state
		for (const section of ['http', 'operationsApi.network'])
			assert.deepStrictEqual(
				disagreements(`${section}.headersTimeout`, samples, { [`${section}.timeout`]: 2147483647 }),
				{ schemaOnly: [], joiOnly: [] },
				section
			);
	});

	it('bounds the storage numbers and threads.heapSnapshotNearLimit exactly as Joi does, but for a quoted number', () => {
		const sizes = [0, 1, 268435456, 2 ** 53 - 1, 2 ** 53, -1, 0.5, '1024', true, {}, null];
		for (const path of ['storage.rocks.blockCacheSize', 'storage.rocks.writeBufferManagerSize'])
			assert.deepStrictEqual(disagreements(path, sizes), { schemaOnly: [], joiOnly: [] }, path);
		// Their readers coerce a quoted number, so Joi accepts one; the schema states the documented type.
		assert.deepStrictEqual(
			disagreements('storage.maxTransactionOpenTime', [
				1,
				5,
				30000,
				2147483647,
				2147483648,
				0,
				-1,
				'30000',
				'30s',
				true,
				null,
			]),
			{ schemaOnly: [], joiOnly: ['30000'] }
		);
		assert.deepStrictEqual(disagreements('storage.reclamation.threshold', [0, 0.4, 1, 1.5, -0.1, '0.3', true, null]), {
			schemaOnly: [],
			joiOnly: ['0.3'],
		});
		assert.deepStrictEqual(disagreements('threads.heapSnapshotNearLimit', [true, false, null, 'false', 1, 0]), {
			schemaOnly: [],
			joiOnly: [],
		});
	});

	it('spells storage.rocks.compression as the database open reads it, leaving the build to Joi', () => {
		const spellings = ['none', 'snappy', 'zlib', 'bzip2', 'lz4', 'lz4hc', 'xpress', 'zstd'];
		const samples = [...spellings, ...spellings.map((name) => ` ${name.toUpperCase()} `), '', '  ', null];
		const unavailable = samples.filter(
			(value) => typeof value === 'string' && value.trim() && !supportedCompression.includes(value.trim().toLowerCase())
		);
		assert.deepStrictEqual(disagreements('storage.rocks.compression', [...samples, 'lz5', 'gzip', true, 5, {}]), {
			schemaOnly: unavailable,
			joiOnly: [],
		});
		assert.ok(
			supportedCompression.every((codec) => spellings.includes(codec)),
			String(supportedCompression)
		);
	});

	it('states the default for every setting defaultConfig.yaml sets, wherever a description names one', () => {
		const mismatched = [];
		let compared = 0;
		for (const { node, path } of schemaNodes(schema)) {
			const description = node.description ?? resolveRef(node).description ?? '';
			const documented = /Default: '?([^\s;,']+?)'?[.;,]?(?:\s|$)/.exec(description)?.[1];
			const installed = path.reduce((value, key) => value?.[key], defaults);
			if (documented === undefined || installed == null || typeof installed === 'object') continue;
			compared++;
			if (documented !== String(installed)) mismatched.push(`${path.join('.')}: ${documented} vs ${installed}`);
		}
		assert.deepStrictEqual(mismatched, []);
		assert.ok(compared >= 20, `compared only ${compared} defaults`);
	});
});
