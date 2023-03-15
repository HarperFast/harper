'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import { connect } from 'mqtt';
const { authorization, url } = getVariables();


describe('test MQTT connections and commands', () => {
	let available_records;
	let client;
	before(async () => {
		available_records = await setupTestApp();
		client = connect('ws://localhost:9926')

		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
	});
	it('subscribe to retained record', async () => {
		client.subscribe('VariedProps/' + available_records[1], function (err) {
			if (!err) {
				client.publish('presence', 'Hello mqtt')
			}
		})
	});
});