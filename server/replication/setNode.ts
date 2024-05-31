import { createCsr, getCertsKeys, setCertTable, signCertificate } from '../../security/keys';
import { validateBySchema } from '../../validation/validationWrapper';
import Joi from 'joi';
import { pki } from 'node-forge';
import { get } from '../../utility/environment/environmentManager';
import { OPERATIONS_ENUM, CONFIG_PARAMS, LICENSE_KEY_DIR_NAME } from '../../utility/hdbTerms';
import { CERTIFICATE_PEM_NAME, CA_PEM_NAME, CERT_NAME } from '../../utility/terms/certificates';
import { ensureNode } from './subscriptionManager';
import { getHDBNodeTable } from './knownNodes';
import { getThisNodeUrl, sendOperationToNode, urlToNodeName, getThisNodeName } from './replicator';
import * as hdb_logger from '../../utility/logging/harper_logger';
import { handleHDBError, hdb_errors, ClientError } from '../../utility/errors/hdbError.js';
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
		const record = await hdb_nodes.get(node_record_id);
		if (!record) throw new ClientError(node_record_id + ' does not exist');

		// If node record has subscriptions it is not part of fully replicated cluster and hdb_nodes table is not replicated,
		// so we delete record and req that other node also deletes record
		if (record?.subscriptions?.length > 0) {
			await sendOperationToNode(
				{ url: record.url },
				{
					operation: OPERATIONS_ENUM.REMOVE_NODE_BACK,
					name: getThisNodeName(),
				},
				undefined
			);
			await hdb_nodes.delete(node_record_id);
		} else {
			await hdb_nodes.patch(node_record_id, { publish: false, subscribe: false, subscriptions: null });
		}

		return `Successfully removed '${node_record_id}' from manifest`;
	}

	let csr;
	if (url?.startsWith('wss:')) {
		const { rep } = await getCertsKeys();
		if (!rep.cert.includes?.('issued by')) {
			// Create the certificate signing request that will be sent to the other node
			csr = await createCsr();
		}
	}

	// TODO: test adding a node to an instance without previous replication config.
	const this_url = getThisNodeUrl();
	if (this_url == null) {
		throw new Error('replication url is missing from harperdb-config.yaml');
	}

	// This is the record that will be added to the other nodes hdb_nodes table
	const remote_add_node_obj = {
		operation: OPERATIONS_ENUM.ADD_NODE_BACK,
		node_name: get(CONFIG_PARAMS.REPLICATION_NODENAME),
		target_node_name: req.node_name,
		url: this_url,
		csr,
		//certificate: await readFile(get(CONFIG_PARAMS.TLS_CERTIFICATE), 'utf8'), //TODO: what cert should we pass here?
	};

	if (get(CONFIG_PARAMS.REPLICATION_NODENAME)) remote_add_node_obj.node_name = get(CONFIG_PARAMS.REPLICATION_NODENAME);
	if (req.subscriptions) {
		remote_add_node_obj.subscriptions = req.subscriptions.map(reverseSubscription);
	}

	if (req.hasOwnProperty('subscribe') || req.hasOwnProperty('publish')) {
		const rev = reverseSubscription(req);
		remote_add_node_obj.subscribe = rev.subscribe;
		remote_add_node_obj.publish = rev.publish;
	}

	if (req?.authorization?.username && req?.authorization?.password) {
		req.authorization =
			'Basic ' + Buffer.from(req.authorization.username + ':' + req.authorization.password).toString('base64');
	}

	let remote_response;
	try {
		remote_response = await sendOperationToNode({ url }, remote_add_node_obj, req);
	} catch (err) {
		err.message = `Error returned from ${url}: ` + err.message;
		throw err;
	}

	if (csr && (!remote_response?.certificate || !remote_response?.certificate?.includes?.('BEGIN CERTIFICATE'))) {
		throw new Error(
			`Unexpected certificate signature response from node ${url} response: ${JSON.stringify(remote_response)}`
		);
	}

	await setCertTable({
		name: `issued by ${urlToNodeName(url)}-ca`,
		certificate: remote_response.ca_certificate,
		is_authority: true,
	});

	if (remote_response.certificate) {
		await setCertTable({
			name: `issued by ${urlToNodeName(url)}`,
			uses: ['https', 'operations', 'wss'],
			certificate: remote_response.certificate,
			private_key_name: 'privateKey.pem', // TODO: this needs to be the name of the private key file that was used for CSR
			is_authority: false,
		});
	}

	const node_record = { url, ca: remote_response.ca_certificate };
	if (req.node_name) node_record.name = req.node_name;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	if (req.subscribe) node_record.subscribe = req.subscribe;
	if (req.publish) node_record.publish = req.publish;

	await ensureNode(remote_response.nodeName, node_record);

	if (req.operation === 'update_node') {
		return `Successfully updated '${url}'`;
	}

	return `Successfully added '${url}' to manifest`;
}

/**
 * Is called by other node when an add_node operation is requested
 * @param req
 */
export async function addNodeBack(req) {
	hdb_logger.trace('addNodeBack received request:', req);
	if (req.target_node_name && req.target_node_name !== get(CONFIG_PARAMS.REPLICATION_NODENAME)) {
		return { error: 'node_name does not match configured node name' };
	}

	const certs = await signCertificate(req);
	const node_record = { url: req.url, ca: certs.ca_certificate };
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	if (req.hasOwnProperty('subscribe')) node_record.publish = req.publish;
	if (req.hasOwnProperty('publish')) node_record.subscribe = req.subscribe;
	await ensureNode(req.node_name, node_record);
	certs.nodeName = getThisNodeName();

	return certs;
}

/**
 * Is called by other node when remove_node is requested and
 * system tables are not replicating
 */
export async function removeNodeBack(req) {
	hdb_logger.trace('removeNodeBack received request:', req);
	const hdb_nodes = getHDBNodeTable();
	await hdb_nodes.delete(req.name);
}

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}
