import { createCsr, getCertsKeys, setCertTable } from '../../security/keys';
import { validateBySchema } from '../../validation/validationWrapper';
import Joi from 'joi';
import needle from 'needle';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { get } from '../../utility/environment/environmentManager';
import { OPERATIONS_ENUM, CONFIG_PARAMS, LICENSE_KEY_DIR_NAME } from '../../utility/hdbTerms';
import { CERTIFICATE_PEM_NAME, CA_PEM_NAME, CERT_NAME } from '../../utility/terms/certificates';
import { ensureNode } from './subscriptionManager';
import { urlToNodeName } from './replicator';
import * as hdb_logger from '../../utility/logging/harper_logger';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError.js';
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdb_errors;

const validation_schema = Joi.object({
	url: Joi.string().required(),
});

export async function addNode(req: object) {
	const validation = validateBySchema(req, validation_schema);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	// TODO: test adding a node to an instance without previous replication config.
	// Create the certificate signing request that will be sent to the other node
	const csr = await createCsr();
	const { url } = req;

	const this_url = get(CONFIG_PARAMS.REPLICATION_URL);
	if (this_url == null) {
		throw new Error('replication url is missing from harperdb-config.yaml');
	}

	// This is the record that will be added to the other nodes hdb_nodes table
	const remote_add_node_obj = {
		url: this_url,
	};

	if (req.node_name) remote_add_node_obj.node_name = req.node_name;
	if (req.subscriptions) {
		const cloned_subs = [...req.subscriptions];
		for (const s of cloned_subs) {
			const reversed = reverseSubscription(s);
			s.subscribe = reversed.subscribe;
			s.publish = reversed.publish;
		}
		remote_add_node_obj.subscriptions = cloned_subs;
	}

	if (req.hasOwnProperty('subscribe') && req.hasOwnProperty('publish')) {
		const rev = reverseSubscription({ subscribe: req.subscribe, publish: req.publish });
		remote_add_node_obj.subscribe = rev.subscribe;
		remote_add_node_obj.publish = rev.publish;
	}

	const sign_req = {
		operation: OPERATIONS_ENUM.SIGN_CERTIFICATE,
		csr,
		certificate: await readFile(get(CONFIG_PARAMS.TLS_CERTIFICATE), 'utf8'),
		add_node: remote_add_node_obj,
	};
	let sign_res;
	try {
		sign_res = await needle('post', url, sign_req, {
			json: true,
			rejectUnauthorized: false,
			auth: 'basic',
			headers: { username: req.username, password: req.password, content_type: 'application/json' },
		});
	} catch (err) {
		hdb_logger.error(err);
		return new Error(`Error requesting certificate signature from node: ${url} message: ${err.message()}`);
	}

	if (!sign_res?.body?.certificate || !sign_res.body?.certificate?.includes?.('BEGIN CERTIFICATE')) {
		return new Error(
			`Unexpected certificate signature response from node ${url} response: ${JSON.stringify(sign_res.body)}`
		);
	}

	await setCertTable({ name: urlToNodeName(url) + '-ca', certificate: sign_res.body.ca_certificate });
	await setCertTable({
		name: urlToNodeName(url),
		uses: ['https', 'operations', 'wss'],
		certificate: sign_res.body.certificate,
		is_authority: false,
	});

	await writeFile(
		join(get(CONFIG_PARAMS.ROOTPATH), LICENSE_KEY_DIR_NAME, CERTIFICATE_PEM_NAME),
		sign_res.body.certificate
	);
	await writeFile(join(get(CONFIG_PARAMS.ROOTPATH), LICENSE_KEY_DIR_NAME, CA_PEM_NAME), sign_res.body.ca_certificate);

	const node_record = { url, ca: sign_res.body.ca_certificate };
	if (req.node_name) node_record.node_name = req.node_name;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	if (req.subscribe) node_record.subscribe = req.subscribe;
	if (req.publish) node_record.publish = req.publish;

	ensureNode(undefined, node_record);

	return `Successfully added '${url}' to manifest`;
}

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	const result = {};
	if (subscribe === true && publish === false) {
		result.subscribe = false;
		result.publish = true;
	} else if (subscribe === false && publish === true) {
		result.subscribe = true;
		result.publish = false;
	} else {
		return subscription;
	}

	return result;
}
