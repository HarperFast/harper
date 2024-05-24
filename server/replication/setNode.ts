import { createCsr, getCertsKeys, setCertTable } from '../../security/keys';
import { validateBySchema } from '../../validation/validationWrapper';
import Joi from 'joi';
import { get } from '../../utility/environment/environmentManager';
import { OPERATIONS_ENUM, CONFIG_PARAMS, LICENSE_KEY_DIR_NAME } from '../../utility/hdbTerms';
import { CERTIFICATE_PEM_NAME, CA_PEM_NAME, CERT_NAME } from '../../utility/terms/certificates';
import { ensureNode, getHDBNodeTable } from './subscriptionManager';
import { getThisNodeUrl, sendOperationToNode, urlToNodeName } from './replicator';
import * as hdb_logger from '../../utility/logging/harper_logger';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError.js';
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdb_errors;

const validation_schema = Joi.object({
	url: Joi.string(),
});

/**
 * Can add, update or remove a node from replication
 * @param req
 */
export async function setNode(req: object) {
	const validation = validateBySchema(req, validation_schema);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	const { url } = req;

	if (req.operation === 'remove_node') {
		const node_record_id = req.node_name ?? urlToNodeName(url);
		const hdb_nodes = getHDBNodeTable();
		await hdb_nodes.patch(node_record_id, { publish: false, subscribe: false, subscriptions: null });

		return `Successfully removed '${node_record_id}' from manifest`;
	}

	let csr;
	const { rep } = await getCertsKeys();
	if (!rep.cert.includes?.('issued by')) {
		// Create the certificate signing request that will be sent to the other node
		csr = await createCsr();
	}

	// TODO: test adding a node to an instance without previous replication config.
	const this_url = getThisNodeUrl();
	if (this_url == null) {
		throw new Error('replication url is missing from harperdb-config.yaml');
	}

	// This is the record that will be added to the other nodes hdb_nodes table
	const remote_add_node_obj = {
		url: this_url,
	};

	if (req.node_name) remote_add_node_obj.node_name = req.node_name;
	if (req.subscriptions) {
		remote_add_node_obj.subscriptions = req.subscriptions.map(reverseSubscription);
	}

	if (req.hasOwnProperty('subscribe') || req.hasOwnProperty('publish')) {
		const rev = reverseSubscription(req);
		remote_add_node_obj.subscribe = rev.subscribe;
		remote_add_node_obj.publish = rev.publish;
	}

	const sign_req = {
		operation: OPERATIONS_ENUM.SIGN_CERTIFICATE,
		csr,
		//certificate: await readFile(get(CONFIG_PARAMS.TLS_CERTIFICATE), 'utf8'), //TODO: what cert should we pass here?
		add_node: remote_add_node_obj,
	};
	let sign_res;
	try {
		// TODO: sendOperationToNode doesnt seem to fail well/at all
		sign_res = await sendOperationToNode({ url }, sign_req, req);
	} catch (err) {
		hdb_logger.error(err);
		throw new Error(`Error requesting certificate signature from node: ${url} message: ${err.message}`);
	}

	if (!sign_res?.certificate || !sign_res?.certificate?.includes?.('BEGIN CERTIFICATE')) {
		throw new Error(`Unexpected certificate signature response from node ${url} response: ${JSON.stringify(sign_res)}`);
	}

	await setCertTable({
		name: `issued by ${urlToNodeName(url)}-ca`,
		certificate: sign_res.ca_certificate,
		is_authority: true,
	});

	if (sign_res.certificate) {
		await setCertTable({
			name: `issued by ${urlToNodeName(url)}`,
			uses: ['https', 'operations', 'wss'],
			certificate: sign_res.certificate,
			private_key_name: 'privateKey.pem', // TODO: this needs to be the name of the private key file that was used for CSR
			is_authority: false,
		});
	}

	const node_record = { url, ca: sign_res.ca_certificate };
	if (req.node_name) node_record.node_name = req.node_name;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	if (req.subscribe) node_record.subscribe = req.subscribe;
	if (req.publish) node_record.publish = req.publish;

	await ensureNode(undefined, node_record);

	if (req.operation === 'update_node') {
		return `Successfully updated '${url}'`;
	}

	return `Successfully added '${url}' to manifest`;
}

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}
