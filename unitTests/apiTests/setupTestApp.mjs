import { getMockLMDBPath } from '../test_utils.js';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';

const headers = {
	//authorization,
	'content-type': 'application/cbor',
	accept: 'application/cbor'
};

let seed = 0;
function random() {
	seed++;
	let a = seed * 15485863;
	return (a * a * a % 2038074743) / 2038074743;
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
	// exit if it is already setup or we are running in the browser
	if (created_records || typeof navigator !== 'undefined') return created_records;
	let path = getMockLMDBPath();
	process.env.STORAGE_PATH = path;
	// make it easy to see what is going on when unit testing
	process.env.LOGGING_STDSTREAMS = 'true';
	// might need fileURLToPath
	process.env.RUN_HDB_APP = fileURLToPath(new URL('../testApp', import.meta.url));
	created_records = [];
	const { startHTTPThreads } = await import('../../server/threads/socketRouter.js');
	await startHTTPThreads(2);
	for (let i = 0; i < 20; i++) {
		let object = {id: Math.round(random() * 1000000)};
		for (let i = 0; i < 20; i++) {
			if (random() > 0.1) {
				object['prop' + i] =
					random() < 0.3 ? Math.floor(random() * 400) / 2 :
						random() < 0.3 ? makeString() : random() < 0.3 ? true : random() < 0.3 ? {sub: 'data'} : null;
			}
		}

		let response = await axios.put('http://localhost:9926/VariedProps/' + object.id, encode(object), {
			method: 'PUT',
			responseType: 'arraybuffer',
			headers,
		});
		created_records.push(object.id);
	}
	return created_records;
}