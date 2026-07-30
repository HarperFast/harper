'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');

const { handleApplication } = require('#src/server/mqtt');

// Regression coverage for the split from #1999: MQTT's raw-socket listener must keep
// registering with its own `usageType` so createTLSSelector/getEffectiveTlsCiphers can give
// mqtt-tagged certificates exact-match priority (see unitTests/security/keys.test.js for the
// certificate-selection side of this contract).
describe('mqtt.ts handleApplication raw-socket registration', () => {
	function recordingServer() {
		const calls = [];
		// handleApplication stores server.socket()'s return value (serverInstances.push(...)), so
		// the recorder returns an object rather than calls.push()'s length to match that shape.
		return { socket: (...args) => (calls.push(args), {}), calls };
	}

	it('registers no listener when neither port nor securePort is configured', () => {
		const server = recordingServer();
		const scope = {
			options: { getAll: () => ({ network: {} }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 0);
	});

	it("registers the raw TCP/TLS listener with securePort, mtls, and usageType 'mqtt' forwarded", () => {
		const server = recordingServer();
		const mtls = { required: true };
		const scope = {
			options: { getAll: () => ({ network: { securePort: 8883, mtls } }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 1);
		assert.deepStrictEqual(server.calls[0][1], { port: undefined, securePort: 8883, mtls, usageType: 'mqtt' });
	});

	it('registers the listener from a plain (non-TLS) port alone, without requiring securePort', () => {
		// server/mqtt.ts sets `usageType: 'mqtt'` unconditionally in one options literal, so this
		// doesn't add distinct usageType coverage over the test above — what it actually pins is
		// the `if (port || securePort)` guard at server/mqtt.ts:88 firing for a port-only config.
		const server = recordingServer();
		const scope = {
			options: { getAll: () => ({ network: { port: 1883 } }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 1);
		assert.deepStrictEqual(server.calls[0][1], {
			port: 1883,
			securePort: undefined,
			mtls: undefined,
			usageType: 'mqtt',
		});
	});
});
