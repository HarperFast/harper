import { getMockLMDBPath } from '../test_utils.js';
import { fileURLToPath } from 'url';
import { setProperty } from '../../utility/environment/environmentManager.js';
import terms from '../../utility/hdbTerms.js';
import { join } from 'path';
import axios from 'axios';
import { encode } from 'cbor-x';
import { createRequire } from 'module';
import analytics from '../../ts-build/resources/analytics.js';
import { disableNATS } from '../../ts-build/server/nats/natsReplicator.js';
import { bypassAuth } from '../../ts-build/security/auth.js';
import { bypassAuth as bypassAuthMQTT } from '../../ts-build/server/mqtt.js';
const require = createRequire(import.meta.url);
const config = {};

const headers = {
	//authorization,
	'content-type': 'application/cbor',
	'accept': 'application/cbor',
};

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
let created_records;
export async function setupTestApp() {
	analytics.setAnalyticsEnabled(false);
	disableNATS();
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
	if (created_records || typeof process === 'undefined') return created_records;
	let path = getMockLMDBPath();
	setProperty(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET, join(path, 'operations-server'))
	process.env.SCHEMAS_DATA_PATH = path;
	// make it easy to see what is going on when unit testing
	process.env.LOGGING_STDSTREAMS = 'true';
	// might need fileURLToPath
	process.env.RUN_HDB_APP = fileURLToPath(new URL('../testApp', import.meta.url));
	process.env._UNREF_SERVER = true; // unref the server so when we are done nothing should block us from exiting
	process.env._DISABLE_NATS = true;
	created_records = [];

	const { startHTTPThreads } = require('../../server/threads/socketRouter');
	await startHTTPThreads(config.threads || 0);
	try {
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

			let response = await axios.put('http://localhost:9926/VariedProps/' + object.id, encode(object), {
				method: 'PUT',
				responseType: 'arraybuffer',
				headers,
			});
			created_records.push(object.id);
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
			let response = await axios.put('http://localhost:9926/FourProp/' + object.id, encode(object), {
				method: 'PUT',
				responseType: 'arraybuffer',
				headers,
			});
			if (i >= 10) {
				// make sure deletion works properly for searches as well
				await axios.delete('http://localhost:9926/FourProp/' + object.id);
			}
		}
	} catch (error) {
		error.message += ': ' + error.response?.data.toString();
		throw error;
	}
	return created_records;
}

export async function addThreads() {
	const { startHTTPThreads } = require('../../server/threads/socketRouter');
	await startHTTPThreads(2);
}
