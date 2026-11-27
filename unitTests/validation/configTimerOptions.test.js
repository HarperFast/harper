'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { supportedCompression } = require('../rocksdbBindings.mts').rocksdbBindings();
const { ROCKS_COMPRESSION_ALGORITHMS } = require('#src/utility/rocksCompressionConfig');
// What the database open and set_configuration load: validation then checks this build's codecs.
require('#src/utility/rocksCompressionSupport');
const { configValidator, effectiveConfigValidator } = require('#src/validation/configValidator');
const { flattenConfig, setConfiguration, getConfigFilePath } = require('#src/config/configUtils');
const env = require('#src/utility/environment/environmentManager');
const { convertToMS } = require('#src/utility/common_utils');
const { preserveRootConfig } = require('../rootConfigFixture.js');

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const defaults = YAML.parse(readFileSync(join(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));

/** The installed defaults with each `path: value` applied; an undefined value removes the key. */
function configOf(settings) {
	const config = { ...structuredClone(defaults), rootPath: '/tmp/harper-timer-options-test' };
	for (const [path, value] of Object.entries(settings)) {
		const keys = path.split('.');
		let node = config;
		for (const key of keys.slice(0, -1)) node = node[key] ??= {};
		if (value === undefined) delete node[keys.at(-1)];
		else node[keys.at(-1)] = value;
	}
	return config;
}
const configWith = (path, value) => configOf({ [path]: value });

/** The error validateConfig() would raise: the nested schema first, then the flattened pass. */
function validationError(config) {
	return (
		configValidator(structuredClone(config), true).error ??
		effectiveConfigValidator(flattenConfig(structuredClone(config))).error
	);
}

const show = (value) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

function assertAccepted(path, value) {
	const error = validationError(configWith(path, value));
	assert.strictEqual(error, undefined, `${path}: ${show(value)} rejected: ${error?.message}`);
}

function assertRejected(path, value, label = path) {
	const error = validationError(configWith(path, value));
	assert.ok(error, `${path}: ${show(value)} accepted`);
	assert.ok(error.message.includes(`'${label}'`), `${path}: ${show(value)} error does not name it: ${error.message}`);
}

const NOT_A_DURATION = [
	-1,
	-5,
	'-1s',
	true,
	false,
	{},
	{ seconds: 30 },
	[],
	'soon',
	'5 minutes',
	'30sec',
	'1e3',
	'0foo',
];
const MISREAD_UNITS = ['500ms', '10ms', '1M', '0.5M', '1y'];
const OVER_TIMER_LIMIT = [2147484, '2147484s', '35792m', '597h', '600h', '25d', '24.9d', 1e300, Infinity];
const TYPICAL_DURATIONS = [30, 90, '30s', '1m', '5m', '45s', '1h', '1.5h', '0.5h', '1H', '2D', '24d', '24.5d', '596h'];

const DURATIONS = [
	{ path: 'storage.transactionLog.coolingInterval', installed: '30s', zero: true, minMs: 1 },
	{ path: 'storage.reclamation.interval', installed: '1h', zero: false, minMs: 1000 },
	{ path: 'storage.maxTransactionQueueTime', installed: '45s', zero: true, minMs: 1 },
	{ path: 'storage.longTransactionReportThreshold', installed: '5m', zero: true, minMs: 1 },
];

describe('timer duration options', () => {
	for (const { path, installed, zero, minMs } of DURATIONS) {
		describe(path, () => {
			it('accepts the documented default, typical durations and null', () => {
				for (const value of [installed, ...TYPICAL_DURATIONS, null]) assertAccepted(path, value);
			});

			it('rejects negatives, booleans, objects and strings that are not a duration', () => {
				for (const value of NOT_A_DURATION) assertRejected(path, value);
			});

			it('rejects units convertToMS reads differently than they read (ms, months, years)', () => {
				for (const value of MISREAD_UNITS) assertRejected(path, value);
			});

			it('rejects a duration longer than 2^31-1 ms, which Node runs after 1 ms', () => {
				assertAccepted(path, MAX_TIMER_DELAY_MS / 1000);
				for (const value of OVER_TIMER_LIMIT) assertRejected(path, value);
			});

			it(`${zero ? 'accepts' : 'rejects'} 0 and bounds the shortest delay at ${minMs} ms`, () => {
				for (const value of [0, '0', '0s', '0.0m']) (zero ? assertAccepted : assertRejected)(path, value);
				for (const value of [minMs / 1000, `${minMs / 1000}s`]) assertAccepted(path, value);
				for (const value of [minMs / 2000, `${minMs / 2000}s`]) assertRejected(path, value);
			});

			it('rejects a value the readers get through a lower-cased key', () => {
				const keys = path.split('.');
				const lowered = [...keys.slice(0, -1), keys.at(-1).toLowerCase()].join('.');
				const error = validationError(configWith(lowered, '25d'));
				assert.ok(error?.message.includes(`'${path}'`), error?.message);
			});

			it('accepts exactly the values whose convertToMS result is a usable delay', () => {
				for (const value of [...TYPICAL_DURATIONS, ...OVER_TIMER_LIMIT, 0.0005, 0.001, '0.5m', '0.01m']) {
					const ms = convertToMS(value);
					const usable = (zero && ms === 0) || (ms >= minMs && ms <= MAX_TIMER_DELAY_MS);
					assert.strictEqual(
						validationError(configWith(path, value)) === undefined,
						usable,
						`${show(value)}: ${ms} ms`
					);
				}
			});
		});
	}
});

describe('storage.maxTransactionOpenTime', () => {
	const path = 'storage.maxTransactionOpenTime';
	it('accepts a number of milliseconds, a quoted number its reader coerces, and null', () => {
		for (const value of [1, 5, 500, 30000, 60000, 180000, MAX_TIMER_DELAY_MS, '30000', null])
			assertAccepted(path, value);
	});
	it('rejects 0, negatives, durations, booleans, objects and values past the timer limit', () => {
		for (const value of [0, -1, '30s', 'soon', true, {}, [], MAX_TIMER_DELAY_MS + 1, Infinity])
			assertRejected(path, value);
	});
});

describe('storage.reclamation.threshold', () => {
	const path = 'storage.reclamation.threshold';
	it('accepts a ratio from 0 to 1 and null', () => {
		for (const value of [0, 0.3, 0.4, 1, null]) assertAccepted(path, value);
	});
	it('rejects negatives, ratios above 1, booleans, objects and words', () => {
		for (const value of [-0.1, 1.5, 40, true, {}, 'most']) assertRejected(path, value);
	});
});

describe('threads.heapSnapshotNearLimit', () => {
	const path = 'threads.heapSnapshotNearLimit';
	it('accepts a boolean and null', () => {
		for (const value of [true, false, null]) assertAccepted(path, value);
	});
	it('rejects a quoted boolean, which its truthiness read would turn on, and other values', () => {
		for (const value of ['false', 'true', 1, 0, {}]) assertRejected(path, value);
	});
});

describe('storage.rocks', () => {
	it('accepts every codec this build opens, in any case and with surrounding space, and unset', () => {
		for (const codec of supportedCompression)
			for (const value of [codec, codec.toUpperCase(), ` ${codec} `])
				assertAccepted('storage.rocks.compression', value);
		for (const value of ['', '  ', null]) assertAccepted('storage.rocks.compression', value);
	});

	it('rejects a codec name the build cannot open, without echoing the value', () => {
		const missingFromBuild = ROCKS_COMPRESSION_ALGORITHMS.filter((codec) => !supportedCompression.includes(codec));
		for (const value of [...missingFromBuild, 'lz5', 'gzip', 'definitely-not-a-codec', 'secret-token', true, 5, {}]) {
			assertRejected('storage.rocks.compression', value);
			const { message } = validationError(configWith('storage.rocks.compression', value));
			assert.ok(!message.includes('secret-token') && !message.includes('lz5'), message);
			assert.ok(
				supportedCompression.every((codec) => message.includes(codec)),
				message
			);
		}
	});

	for (const path of ['storage.rocks.blockCacheSize', 'storage.rocks.writeBufferManagerSize']) {
		it(`${path} takes a whole, non-negative number of bytes`, () => {
			for (const value of [0, 1, 268435456, Number.MAX_SAFE_INTEGER, null]) assertAccepted(path, value);
			for (const value of [-1, 0.5, 1024.5, '1024', true, {}, Number.MAX_SAFE_INTEGER + 1]) assertRejected(path, value);
		});
	}

	it('accepts an empty rocks block', () => {
		assertAccepted('storage.rocks', null);
	});

	it('validates without loading a native addon, so modules that validate config load where none can', () => {
		const script = `
			const { configValidator, effectiveConfigValidator } = require('#src/validation/configValidator');
			const { flattenConfig } = require('#src/config/configUtils');
			const config = JSON.parse(process.argv[1]);
			const error = configValidator(structuredClone(config), true).error ?? effectiveConfigValidator(flattenConfig(config)).error;
			process.stdout.write(String(error?.message));`;
		for (const [compression, expected] of [
			['lz4', 'undefined'],
			['lz5', "'storage.rocks.compression' must be one of: " + ROCKS_COMPRESSION_ALGORITHMS.join(', ')],
		]) {
			const config = configWith('storage.rocks.compression', compression);
			const output = execFileSync(process.execPath, ['--no-addons', '-e', script, JSON.stringify(config)], {
				cwd: join(__dirname, '../..'),
				encoding: 'utf8',
				timeout: 30000,
			});
			assert.strictEqual(output.trim().split('\n').at(-1), expected);
		}
	});
});

const HTTP_OPTIONS = [
	{ path: 'http.keepAliveTimeout', min: 0, max: MAX_TIMER_DELAY_MS - 1000 },
	{ path: 'http.timeout', min: 0, max: MAX_TIMER_DELAY_MS },
	{ path: 'http.headersTimeout', min: 1, max: MAX_TIMER_DELAY_MS, pairedWithTimeout: true },
	{ path: 'http.maxHeaderSize', min: 0, max: Number.MAX_SAFE_INTEGER },
	{ path: 'operationsApi.network.keepAliveTimeout', min: 1, max: MAX_TIMER_DELAY_MS - 1000 },
	{ path: 'operationsApi.network.timeout', min: 1, max: MAX_TIMER_DELAY_MS },
	{ path: 'operationsApi.network.headersTimeout', min: 1, max: MAX_TIMER_DELAY_MS, pairedWithTimeout: true },
];

describe('HTTP server options', () => {
	for (const { path, min, max, pairedWithTimeout } of HTTP_OPTIONS) {
		const option = path.split('.').at(-1);
		describe(path, () => {
			it('accepts typical values and its bounds', () => {
				for (const value of [min, 1000, 30000, 60000, 16384]) assertAccepted(path, value);
				// a headersTimeout above the request timeout is the pair rule's case
				const timeoutPath = path.replace(option, 'timeout');
				const atMax = configOf({ [path]: max, ...(pairedWithTimeout && { [timeoutPath]: MAX_TIMER_DELAY_MS }) });
				assert.strictEqual(validationError(atMax), undefined, `${path}: ${max}`);
			});

			it('rejects negatives, fractions, strings, booleans, null, objects and values past its limit', () => {
				for (const value of [min - 1, 1.5, '30000', true, null, {}, max + 1]) assertRejected(path, value);
			});

			it('accepts only values the running Node.js accepts for createServer', () => {
				for (const value of [min, 1, 1000, max]) {
					const options = { [option === 'timeout' ? 'requestTimeout' : option]: value };
					if (pairedWithTimeout) options.requestTimeout = 0;
					assert.doesNotThrow(() => http.createServer(options), `${path}: ${value}`);
				}
				for (const value of [-1, 1.5, '30000', true, null])
					assert.throws(() => http.createServer({ [option === 'timeout' ? 'requestTimeout' : option]: value }));
			});
		});
	}

	it('rejects a headersTimeout above the request timeout, which createServer refuses', () => {
		for (const [headersTimeout, timeout] of [
			[200000, 120000],
			[120001, 120000],
		]) {
			const config = configWith('http.headersTimeout', headersTimeout);
			config.http.timeout = timeout;
			assert.match(
				validationError(config)?.message ?? '',
				/'http\.headersTimeout' \(\d+\) must not be greater than 'http\.timeout'/
			);
			assert.throws(() => http.createServer({ headersTimeout, requestTimeout: timeout }), { code: 'ERR_OUT_OF_RANGE' });
		}
	});

	it('accepts a headersTimeout up to the request timeout, or any with the request timeout off', () => {
		for (const [headersTimeout, timeout] of [
			[60000, 120000],
			[120000, 120000],
			[400000, 0],
		]) {
			const config = configWith('http.headersTimeout', headersTimeout);
			config.http.timeout = timeout;
			assert.strictEqual(validationError(config), undefined, `${headersTimeout} with ${timeout}`);
			assert.doesNotThrow(() => http.createServer({ headersTimeout, requestTimeout: timeout }));
		}
	});

	it("holds an unset request timeout to Node.js's default of 300000 ms", () => {
		const config = configWith('http.timeout', undefined);
		config.http.headersTimeout = 300001;
		config.operationsApi.network.headersTimeout = 60000;
		assert.match(validationError(config)?.message ?? '', /'http\.timeout' \(300000, Node\.js's default\)/);
		assert.throws(() => http.createServer({ headersTimeout: 300001 }), { code: 'ERR_OUT_OF_RANGE' });
		config.http.headersTimeout = 300000;
		assert.strictEqual(validationError(config), undefined);
	});

	it('checks the operations API pair it inherits from http', () => {
		const config = configWith('http.headersTimeout', 100000);
		config.operationsApi.network.timeout = 60000;
		assert.match(
			validationError(config)?.message ?? '',
			/'operationsApi\.network\.headersTimeout' \(100000\) must not be greater than 'operationsApi\.network\.timeout' \(60000\)/
		);
	});

	it('accepts an operations API timeout of 0 inherited from http, which createServer allows', () => {
		assert.strictEqual(validationError(configWith('http.timeout', 0)), undefined);
		assertRejected('operationsApi.network.timeout', 0);
	});

	it('checks the values customFunctions.network merges over http', () => {
		for (const [option, value] of [
			['keepAliveTimeout', -1],
			['timeout', MAX_TIMER_DELAY_MS + 1],
			['headersTimeout', 200000],
			['maxHeaderSize', 1.5],
		]) {
			const config = configWith(`customFunctions.network.${option}`, value);
			assert.ok(validationError(config), `customFunctions.network.${option}: ${value}`);
		}
	});
});

describe('set_configuration rejects these values with a 400 before writing', () => {
	preserveRootConfig();
	const cases = [
		...DURATIONS.flatMap(({ path }) =>
			[-5, true, { seconds: 30 }, 'soon', '25d'].map((value) => [path.replaceAll('.', '_'), value])
		),
		...[-1, true, {}, '30s', MAX_TIMER_DELAY_MS + 1].map((value) => ['storage_maxTransactionOpenTime', value]),
		...[-0.5, true, {}, 'most', 2].map((value) => ['storage_reclamation_threshold', value]),
		...[1, {}].map((value) => ['threads_heapSnapshotNearLimit', value]),
		...[...ROCKS_COMPRESSION_ALGORITHMS.filter((codec) => !supportedCompression.includes(codec)), 'lz5', true, {}].map(
			(value) => ['storage_rocks_compression', value]
		),
		...[-1, 0.5, true, {}].map((value) => ['storage_rocks_writeBufferManagerSize', value]),
		...[-1, 0.5, true, {}].map((value) => ['storage_rocks_blockCacheSize', value]),
		...HTTP_OPTIONS.flatMap(({ path, max }) =>
			[-1, true, {}, 'soon', max + 1].map((value) => [path.replaceAll('.', '_'), value])
		),
		['http_headersTimeout', 200000],
	];
	for (const [param, value] of cases) {
		it(`${param}: ${show(value)}`, async () => {
			const before = readFileSync(getConfigFilePath(), 'utf8');
			await assert.rejects(
				setConfiguration({ operation: 'set_configuration', [param]: value }),
				(error) => error.statusCode === 400 && /config file validation error/i.test(error.message)
			);
			assert.strictEqual(readFileSync(getConfigFilePath(), 'utf8'), before);
		});
	}

	it('accepts the installed defaults', async () => {
		const values = {
			storage_transactionLog_coolingInterval: '30s',
			storage_reclamation_interval: '1h',
			storage_reclamation_threshold: 0.4,
			storage_maxTransactionQueueTime: '45s',
			storage_maxTransactionOpenTime: 30000,
			storage_longTransactionReportThreshold: '5m',
			http_keepAliveTimeout: 30000,
			http_timeout: 120000,
		};
		const previous = Object.fromEntries(Object.keys(values).map((param) => [param, env.get(param)]));
		try {
			await setConfiguration({ operation: 'set_configuration', ...values });
		} finally {
			for (const [param, value] of Object.entries(previous)) env.setProperty(param, value);
		}
	});
});
