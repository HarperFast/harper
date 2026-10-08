'use strict';

const assert = require('node:assert');
const { buildOperations } = require('#src/agent/operations');

describe('agent/operations set_agent_config', () => {
	function setAgentConfig() {
		const patches = [];
		const deps = {
			getConfig: () => ({}),
			setConfig: (patch) => {
				patches.push(patch);
				return patch;
			},
			startRun: () => {},
			cancelRun: () => false,
		};
		const operation = buildOperations(deps).find((op) => op.name === 'set_agent_config');
		return { execute: operation.execute, patches };
	}

	it('rejects an httpFetch patch, applying nothing from the request', async () => {
		const { execute, patches } = setAgentConfig();
		for (const httpFetch of [true, false, { allow: ['example.com'] }]) {
			await assert.rejects(execute({ operation: 'set_agent_config', httpFetch, maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /fixed at startup/);
				return true;
			});
		}
		assert.deepStrictEqual(patches, []);
	});

	it('rejects a componentsScope or configScope patch, applying nothing from the request', async () => {
		const { execute, patches } = setAgentConfig();
		for (const key of ['componentsScope', 'configScope']) {
			await assert.rejects(execute({ operation: 'set_agent_config', [key]: '.', maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.ok(err.message.startsWith(`agent.${key} is fixed at startup`), err.message);
				return true;
			});
		}
		assert.deepStrictEqual(patches, []);
	});

	it('still applies the runtime-tunable keys', async () => {
		const { execute, patches } = setAgentConfig();
		await execute({ operation: 'set_agent_config', maxTurns: 3, allowDestructive: true });
		assert.deepStrictEqual(patches, [{ maxTurns: 3, allowDestructive: true }]);
	});

	it('applies maxToolResultBytes within 1024..1048576 and rejects anything else with a 400', async () => {
		const { execute, patches } = setAgentConfig();
		await execute({ operation: 'set_agent_config', maxToolResultBytes: 1024 });
		await execute({ operation: 'set_agent_config', maxToolResultBytes: 1_048_576 });
		for (const maxToolResultBytes of [0, 1023, 1_048_577, 65536.5, '65536', null]) {
			await assert.rejects(execute({ operation: 'set_agent_config', maxToolResultBytes, maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /maxToolResultBytes must be an integer from 1024 to 1048576/);
				return true;
			});
		}
		assert.deepStrictEqual(patches, [{ maxToolResultBytes: 1024 }, { maxToolResultBytes: 1_048_576 }]);
	});
});
