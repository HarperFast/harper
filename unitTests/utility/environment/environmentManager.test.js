'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const config_utils = require('#src/config/configUtils');
const common_utils = require('#src/utility/common_utils');
const rewire = require('rewire');
const fs = require('fs');
const hdbTerms = require('#src/utility/hdbTerms');
const env_rw = rewire('#src/utility/environment/environmentManager');
const log = require('#src/utility/logging/harper_logger');

const TEST_PROP_1_NAME = 'root';
const TEST_PROP_2_NAME = 'path';
const TEST_PROP_1_VAL = 'I am root';
const TEST_PROP_2_VAL = '$HOME/users';

const TEST_PROPS_FILE_PATH = `${__dirname}/../../hdb_boot_properties.file`;

const LOWERCASE_ERR_MSG_1 = "Cannot read property 'toLowerCase' of null";
const LOWERCASE_ERR_MSG_2 = "Cannot read properties of null (reading 'toLowerCase')";

describe('Test environmentManager module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	describe('Test getHdbBasePath', () => {
		it('Test that getHdbBasePath and setHdbBasePath', () => {
			env_rw.setHdbBasePath('testpath');

			const result = env_rw.getHdbBasePath();

			expect(result).to.equal('testpath');
		});
	});

	describe('Test get function', () => {
		let get_config_value_stub;

		before(() => {
			get_config_value_stub = sandbox.stub(config_utils, 'getConfigValue');
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test expected value is returned', () => {
			get_config_value_stub.returns(TEST_PROP_1_VAL);

			const result = env_rw.get(TEST_PROP_1_NAME);
			expect(result).to.equal(TEST_PROP_1_VAL);
		});

		it('Test if value is undefined it returns undefined', () => {
			get_config_value_stub.returns(undefined);

			const result = env_rw.get('test-prop');
			expect(result).to.be.undefined;
		});
	});

	describe('Test setProperty function', () => {
		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test expected values are passed', () => {
			let update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			env_rw.setProperty(TEST_PROP_1_NAME, TEST_PROP_1_VAL);
			env_rw.setProperty(TEST_PROP_2_NAME, TEST_PROP_2_VAL);

			expect(update_config_object.firstCall.args[0]).to.eql(TEST_PROP_1_NAME);
			expect(update_config_object.firstCall.args[1]).to.eql(TEST_PROP_1_VAL);
			expect(update_config_object.secondCall.args[0]).to.eql(TEST_PROP_2_NAME);
			expect(update_config_object.secondCall.args[1]).to.eql(TEST_PROP_2_VAL);
			sandbox.restore();
		});

		it('Test with invalid property, expect exception', () => {
			let result = undefined;
			try {
				env_rw.setProperty(null, TEST_PROP_1_VAL);
			} catch (err) {
				result = err;
			}

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.be.oneOf([LOWERCASE_ERR_MSG_1, LOWERCASE_ERR_MSG_2]);
		});
	});

	describe('Test doesPropFileExist function', () => {
		const does_prop_file_exist = env_rw.__get__('doesPropFileExist');

		before(() => {
			sandbox.stub(fs, 'accessSync').resolves();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test it returns true', () => {
			sandbox.stub(common_utils, 'getPropsFilePath').returns(TEST_PROPS_FILE_PATH);
			const result = does_prop_file_exist();

			expect(result).to.be.true;
			sandbox.restore();
		});

		it('Test it catches error, logs trace message, and returns false', () => {
			sandbox.stub(common_utils, 'getPropsFilePath');
			const trace_stub = sandbox.stub(log, 'trace');
			const result = does_prop_file_exist();

			expect(result).to.be.false;
			expect(trace_stub.args[0]).to.eql(['Environment manager found no properties file at undefined']);
		});
	});

	describe('Test initSync function', () => {
		let does_prop_file_exist_stub;
		let init_config;
		let get_config_value;

		before(() => {
			does_prop_file_exist_stub = sandbox.stub().returns(true);
			init_config = sandbox.stub(config_utils, 'initConfig');
			get_config_value = sandbox.stub(config_utils, 'getConfigValue');
		});

		after(() => {
			sandbox.resetHistory();
		});

		it('Tests config env initialized', () => {
			env_rw.__set__('propFileExists', false);
			env_rw.__set__('doesPropFileExist', does_prop_file_exist_stub);

			env_rw.initSync();

			expect(init_config.called).to.be.true;
			expect(get_config_value.called).to.be.true;
		});
	});

	describe('Test initTestEnvironment function', () => {
		let set_property_stub;
		let set_property_rw;

		before(() => {
			set_property_stub = sandbox.stub();
			set_property_rw = env_rw.__set__('setProperty', set_property_stub);
		});

		// Without this, the stubbed internal setProperty binding leaks into every describe block
		// that runs later in this file (rewire's __set__ isn't reverted by sandbox.restore()).
		after(() => {
			set_property_rw();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});
		// what is magically correct about 23 and 31?
		it.skip('Test properties are set with no test config obj', () => {
			env_rw.initTestEnvironment();

			expect(set_property_stub.called).to.be.true;
			expect(set_property_stub.callCount).to.equal(23);
		});

		it.skip('Test properties are set with test config obj', () => {
			const test_config_obj = {
				cors_accesslist: [],
				server_timeout: 120000,
				keep_alive_timeout: 5000,
				headers_timeout: 60000,
			};

			env_rw.initTestEnvironment(test_config_obj);

			expect(set_property_stub.called).to.be.true;
			expect(set_property_stub.callCount).to.equal(31);
		});
	});

	describe('Test config-override tracking and replay (worker-thread inheritance)', () => {
		// appliedOverrides entries carry the override plus the configured value it displaced, so a
		// forced reload can tell a config file that still says what it said from one that changed.
		const overrideMap = (...entries) => new Map(entries.map(([name, value, base]) => [name, { value, base }]));

		afterEach(() => {
			sandbox.restore();
			env_rw.__set__('appliedOverrides', new Map());
			env_rw.__set__('inheritedOverridesApplied', false);
		});

		it('getConfigOverrides returns undefined when nothing has been overridden on this thread', () => {
			env_rw.__set__('appliedOverrides', new Map());
			expect(env_rw.getConfigOverrides()).to.be.undefined;
		});

		it('getConfigOverrides reflects every setProperty call on this thread, in order', () => {
			sandbox.stub(config_utils, 'updateConfigObject');
			env_rw.setProperty('foo', 'bar');
			env_rw.setProperty('baz', 42);
			expect(env_rw.getConfigOverrides()).to.eql({ foo: 'bar', baz: 42 });
		});

		it('a later setProperty for the same param overwrites the value replayed to workers', () => {
			sandbox.stub(config_utils, 'updateConfigObject');
			env_rw.setProperty('foo', 'first');
			env_rw.setProperty('foo', 'second');
			expect(env_rw.getConfigOverrides()).to.eql({ foo: 'second' });
		});

		it('collapses two different legacy aliases for the same canonical param onto one Map entry', () => {
			// SERVER_PORT_KEY ('SERVER_PORT') and OPERATIONSAPI_NETWORK_PORT both canonicalize to
			// 'operationsApi_network_port' (CONFIG_PARAM_MAP). Without canonical keying these would
			// land in two separate Map entries, and replay order (Map insertion order) wouldn't
			// guarantee the later call wins — a worker could end up on a stale alias's value even
			// though its parent had already moved past it.
			sandbox.stub(config_utils, 'updateConfigObject');
			env_rw.setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY, 9925);
			env_rw.setProperty(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, 9926);
			expect(env_rw.getConfigOverrides()).to.eql({ operationsApi_network_port: 9926 });
		});

		it('reapplyAllOverrides replays every override the reload left alone through setProperty', () => {
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'getConfigValue').returns(undefined);
			env_rw.__set__('appliedOverrides', overrideMap(['foo', 'bar', undefined], ['baz', 42, undefined]));
			const reapply_all_overrides = env_rw.__get__('reapplyAllOverrides');

			reapply_all_overrides();

			expect(update_config_object.calledWith('foo', 'bar')).to.be.true;
			expect(update_config_object.calledWith('baz', 42)).to.be.true;
		});

		it('lets the config file win: a reload that changed the param retires the override', () => {
			// A forced re-init is how an operator's harper-config.yaml edit takes effect (the RESTART
			// handlers in security/keys.ts and processManagement.js). Replaying unconditionally would
			// make editing an overridden param a silent no-op for the life of the process.
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'getConfigValue').returns('edited-on-disk');
			env_rw.__set__('appliedOverrides', overrideMap(['node_hostname', 'overridden', 'original-on-disk']));

			env_rw.__get__('reapplyAllOverrides')();

			expect(update_config_object.called).to.be.false;
			// Dropped from the map too, so it stops propagating to newly spawned workers — otherwise
			// the skew this mechanism prevents would reappear from the other direction.
			expect(env_rw.getConfigOverrides()).to.be.undefined;
		});

		it('compares object-valued params by content, since a reload rebuilds them as fresh objects', () => {
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'getConfigValue').returns({ data: { path: '/data' } });
			env_rw.__set__(
				'appliedOverrides',
				overrideMap(['databases', { data: { path: '/iso' } }, { data: { path: '/data' } }])
			);

			env_rw.__get__('reapplyAllOverrides')();

			expect(update_config_object.calledWith('databases', { data: { path: '/iso' } })).to.be.true;
		});

		it('rejects a value that could not be handed to a worker rather than letting the spawn degrade', () => {
			// manageThreads.js's configOverrides provider structuredClones this map into every worker
			// and only logs a clone failure, spawning the worker on the on-disk config instead — so
			// the cloneability invariant is enforced here, where the caller can still fix it.
			sandbox.stub(config_utils, 'updateConfigObject');
			expect(() => env_rw.setProperty('rootPath', () => '/iso')).to.throw(/structured-cloneable/);
			expect(env_rw.getConfigOverrides()).to.be.undefined;
		});

		it('a forced initSync() reapplies overrides instead of silently dropping them after the disk re-read', () => {
			// Regression test: initConfig(force) rebuilds configObj/flatConfigObj from disk, which
			// would otherwise discard anything setProperty() had layered on top of it (e.g. after a
			// component RESTART calls initSync(true) — see security/keys.ts).
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'initConfig');
			sandbox.stub(config_utils, 'getConfigValue');
			env_rw.__set__('propFileExists', true);
			env_rw.__set__('inheritedOverridesApplied', true);
			env_rw.__set__('appliedOverrides', overrideMap(['locally_set_key', 'should-survive-reload', undefined]));

			env_rw.initSync(true);

			expect(update_config_object.calledWith('locally_set_key', 'should-survive-reload')).to.be.true;
		});

		it('a non-forced initSync() does not replay local overrides a second time', () => {
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'initConfig');
			sandbox.stub(config_utils, 'getConfigValue');
			env_rw.__set__('propFileExists', true);
			env_rw.__set__('inheritedOverridesApplied', true);
			env_rw.__set__('appliedOverrides', overrideMap(['locally_set_key', 'value', undefined]));

			env_rw.initSync(false);

			expect(update_config_object.called).to.be.false;
		});

		it('syncs installProps HDB_ROOT from config AFTER replaying overrides, not from the pre-replay disk read', () => {
			// Regression test for a bug the round-2 canonical-keying fix introduced: setProperty()
			// records a rootPath override under its canonical name, not HDB_ROOT_KEY, so replaying it
			// doesn't retrigger the installProps side effect in setProperty() itself — getHdbBasePath()
			// only tracks an isolated rootPath override if this sync in initSync() runs after replay.
			const update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			sandbox.stub(config_utils, 'initConfig');
			const get_config_value = sandbox.stub(config_utils, 'getConfigValue').returns('/isolated/root');
			env_rw.__set__('propFileExists', true);
			env_rw.__set__('inheritedOverridesApplied', true);
			env_rw.__set__('appliedOverrides', overrideMap(['rootPath', '/isolated/root', '/isolated/root']));

			env_rw.initSync(true);

			expect(get_config_value.calledAfter(update_config_object)).to.be.true;
			expect(env_rw.getHdbBasePath()).to.equal('/isolated/root');
		});
	});
});
