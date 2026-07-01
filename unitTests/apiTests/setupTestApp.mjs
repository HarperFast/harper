import { setupTestDBPath } from '../testUtils.js';
import { fileURLToPath } from 'url';
import hdbTerms from '#src/utility/hdbTerms';
import { join } from 'path';
import axios from 'axios';
import { encode } from 'cbor-x';
import analytics from '#src/resources/analytics/write';
import { bypassAuth } from '#src/security/auth';
import { bypassAuth as bypassAuthMQTT } from '#src/server/mqtt';
import environmentManager from '#src/utility/environment/environmentManager';
import { getDatabases } from '#src/resources/databases';
import {
	getNextAvailableLoopbackAddress,
	releaseAllLoopbackAddressesForCurrentProcess,
} from '@harperfast/integration-testing';
const { setProperty } = environmentManager;
const config = {};

const headers = {
	//authorization,
	'content-type': 'application/cbor',
	'accept': 'application/cbor',
};

// Exported URL variables — updated by setupTestApp() before the server starts.
// Test files should import these rather than hard-coding localhost URLs so that
// concurrent agent runs each get their own isolated loopback address.
export let baseUrl = 'http://localhost:9926';
export let wsBaseUrl = 'ws://localhost:9926';
export let operationsUrl = 'http://localhost:9925';
export let mqttUrl = 'mqtt://localhost:1883';
export let mqttsUrl = 'mqtts://localhost:8883';
export let testHost = 'localhost';

let seed = 0;
export function random() {
	seed++;
	let a = seed * 15485863;
	return ((a * a * a) % 2038074743) / 2038074743;
}

function makeString() {
	let str = '';
	while (random() < 0.9) {
		str += random() < 0.8 ? 'hello world' : String.fromCharCode(300);
	}
	return str;
}
let createdRecords;
let serverStarted;
export async function setupTestApp() {
	analytics.setAnalyticsEnabled(false);
	bypassAuth();
	bypassAuthMQTT();
	let superGetUser = server.getUser;
	server.getUser = function (user, password) {
		if (user === 'test' && password === 'test') {
			return {
				id: 'test',
				role: {
					permission: {
						FourProp: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							attribute_permissions: [{ attribute_name: 'name', read: true, insert: true, update: true }],
						},
					},
				},
			};
		}
		return superGetUser(user, password);
	};

	// exit if it is already setup or we are running in the browser
	if (typeof process === 'undefined') return createdRecords;
	// Ensure the system database (hdb_role, hdb_user, etc.) is loaded from the
	// installed Harper path before setupTestDBPath() overrides HDB_ROOT_KEY to the
	// test PID dir. Without this, the system path preservation logic in
	// setupTestDBPath() has nothing to preserve and setUp() later can't find hdb_role.
	getDatabases();
	let path = setupTestDBPath();

	if (!serverStarted) {
		// Acquire a unique loopback address (127.0.0.x) for this process so
		// concurrent test runs don't collide on the same ports.
		const address = await getNextAvailableLoopbackAddress();
		testHost = address;
		baseUrl = `http://${address}:9926`;
		wsBaseUrl = `ws://${address}:9926`;
		operationsUrl = `http://${address}:9925`;
		mqttUrl = `mqtt://${address}:1883`;
		mqttsUrl = `mqtts://${address}:8883`;
		// Expose host to CJS helpers (e.g. utility.js) that can't use ES live bindings.
		process.env.HARPER_TEST_HOST = address;
		process.env.HARPER_TEST_OPS_PORT = '9925';
		process.on('beforeExit', () => releaseAllLoopbackAddressesForCurrentProcess().catch(() => {}));
	}

	setProperty(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET, join(path, 'operations-server'));
	setProperty(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, `${testHost}:9925`);
	setProperty(hdbTerms.CONFIG_PARAMS.HTTP_SECUREPORT, null);
	setProperty(hdbTerms.CONFIG_PARAMS.HTTP_PORT, `${testHost}:9926`);
	setProperty(hdbTerms.CONFIG_PARAMS.MQTT_NETWORK_PORT, `${testHost}:1883`);
	setProperty(hdbTerms.CONFIG_PARAMS.MQTT_NETWORK_SECUREPORT, `${testHost}:8883`);
	setProperty(hdbTerms.CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL, true);
	process.env.SCHEMAS_DATA_PATH = path;
	// make it easy to see what is going on when unit testing
	process.env.LOGGING_STDSTREAMS = 'true';
	// might need fileURLToPath
	process.env.RUN_HDB_APP = fileURLToPath(new URL('../testApp', import.meta.url));
	process.env._UNREF_SERVER = true; // unref the server so when we are done nothing should block us from exiting
	process.env._DISABLE_NATS = true;
	createdRecords = [];

	if (serverStarted) {
		// if already started, clear out any previous records and recreate them
		tables.VariedProps.clear();
		tables.FourProp.clear();
		tables.Related.clear();
		tables.SubObject.clear();
	} else {
		const { startHTTPThreads } = await import('#src/server/threads/socketRouter');
		serverStarted = await startHTTPThreads(config.threads || 0);
	}
	try {
		seed = 0; // reset the seed to make sure we are deterministic here
		for (let i = 0; i < 20; i++) {
			let object = { id: Math.round(random() * 1000000).toString(36) };
			for (let i = 0; i < 20; i++) {
				if (random() > 0.1) {
					object['prop' + i] =
						random() < 0.3
							? Math.floor(random() * 400) / 2
							: random() < 0.3
								? makeString()
								: random() < 0.3
									? true
									: random() < 0.3
										? { sub: 'data' }
										: null;
				}
			}

			await axios.put(`${baseUrl}/VariedProps/` + object.id, encode(object), {
				method: 'PUT',
				responseType: 'arraybuffer',
				headers,
			});
			createdRecords.push(object.id);
		}

		for (let i = 0; i < 15; i++) {
			let birthday = new Date(1990 + i + '-03-22T22:41:12.176Z');

			let object = {
				id: i.toString(),
				name: 'name' + i,
				age: 20 + i,
				birthday,
				title: 'title' + i,
			};
			await axios.put(`${baseUrl}/FourProp/` + object.id, encode(object), {
				method: 'PUT',
				responseType: 'arraybuffer',
				headers,
			});
			if (i >= 10) {
				// make sure deletion works properly for searches as well
				await axios.delete(`${baseUrl}/FourProp/` + object.id);
			}
		}
	} catch (error) {
		error.message += ': ' + error.response?.data.toString();
		throw error;
	}
	return createdRecords;
}

export async function addThreads() {
	const { startHTTPThreads } = await import('#src/server/threads/socketRouter');
	await startHTTPThreads(2);
}
