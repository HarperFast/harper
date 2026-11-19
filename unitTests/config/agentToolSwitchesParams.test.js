'use strict';

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const schema = require('../../config-root.schema.json');

describe('agent.tools configuration (harper#3993)', () => {
	const tools = schema.properties.agent.properties.tools;

	it('declares agent.tools as a closed object of booleans, read at startup only', () => {
		assert.equal(tools.type, 'object');
		assert.equal(tools.additionalProperties, false);
		assert.deepEqual(Object.keys(tools.properties), ['filesystem', 'schedule', 'inspector', 'bestPractices']);
		assert.match(tools.description, /Read at startup only; set_agent_config cannot change it/);
	});

	for (const [constant, name] of [
		['AGENT_TOOLS_FILESYSTEM', 'filesystem'],
		['AGENT_TOOLS_SCHEDULE', 'schedule'],
		['AGENT_TOOLS_INSPECTOR', 'inspector'],
		['AGENT_TOOLS_BESTPRACTICES', 'bestPractices'],
	])
		it(`registers agent.tools.${name} for env vars, CLI flags and set_configuration`, () => {
			assert.equal(CONFIG_PARAMS[constant], `agent_tools_${name}`);
			assert.equal(CONFIG_PARAM_MAP[`agent_tools_${name.toLowerCase()}`], `agent_tools_${name}`);
			assert.equal(tools.properties[name].type, 'boolean');
		});
});
