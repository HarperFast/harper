'use strict';

const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { CONFIG_PARAM_MAP, STUDIO_CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getCachedCertificateVerificationConfig } = require('#src/security/certificateVerification/verificationConfig');
const { configValidator } = require('#src/validation/configValidator');
const { convertToMS } = require('#src/utility/common_utils');
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
		for (const rejected of ['-1h', '0.001', '0.5', '10ms', '1M', '1y', 'soon'])
			assert.ok(!duration.test(rejected), rejected);
	});

	it('bounds authentication.maxLoginTokenTimeout to durations of at least a second, as the root validator does', () => {
		const { maxLoginTokenTimeout } = schema.properties.authentication.properties;
		const duration = new RegExp(maxLoginTokenTimeout.pattern);
		const config = (value) => ({
			...structuredClone(defaults),
			rootPath: '/tmp/harper-schema-test',
			authentication: { ...defaults.authentication, maxLoginTokenTimeout: value },
		});
		for (const accepted of ['5m', '90', '90s', '1.5h', '1d'])
			assert.ok(duration.test(accepted) && convertToMS(accepted) >= 1000, accepted);
		for (const accepted of ['5m', '90s', 300])
			assert.strictEqual(configValidator(config(accepted), true).error, undefined, String(accepted));
		for (const rejected of ['-1m', '0', '0.5', '1w', '10ms', 'soon', 0, -5]) {
			if (typeof rejected === 'string') assert.ok(!duration.test(rejected), rejected);
			assert.match(
				configValidator(config(rejected), true).error?.message ?? '',
				/maxLoginTokenTimeout/,
				String(rejected)
			);
		}
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
