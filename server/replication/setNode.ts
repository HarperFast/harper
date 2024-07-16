import {
	createCsr,
	setCertTable,
	signCertificate,
	getReplicationCert,
	getReplicationCertAuth,
} from '../../security/keys';
import { validateBySchema } from '../../validation/validationWrapper';
import Joi from 'joi';
import { basename } from 'path';
const { pki } = require('node-forge');
import { get } from '../../utility/environment/environmentManager';
import { OPERATIONS_ENUM, CONFIG_PARAMS } from '../../utility/hdbTerms';
import { PRIVATEKEY_PEM_NAME } from '../../utility/terms/certificates';
import { ensureNode } from './subscriptionManager';
import { getHDBNodeTable } from './knownNodes';
import { getThisNodeUrl, sendOperationToNode, urlToNodeName, getThisNodeName } from './replicator';
import * as hdb_logger from '../../utility/logging/harper_logger';
import { handleHDBError, hdb_errors, ClientError } from '../../utility/errors/hdbError.js';
const { HTTP_STATUS_CODES } = hdb_errors;

const validation_schema = Joi.object({
	url: Joi.string(),
	node_name: Joi.string(),
	rejectUnauthorized: Joi.boolean(),
	replicates: Joi.boolean(),
	subscriptions: Joi.array(),
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
		if (!url && !req.node_name) throw new ClientError('url or node_name is required for remove_node operation');
		const node_record_id = req.node_name ?? urlToNodeName(url);
		const hdb_nodes = getHDBNodeTable();
		const record = await hdb_nodes.get(node_record_id);
		if (!record) throw new ClientError(node_record_id + ' does not exist');

		// we delete record and req that other node also deletes record (or mark itself as non-replicating)
		// we do not wait for the other node to respond, it may not even be online anymore
		sendOperationToNode(
			{ url: record.url },
			{
				operation: OPERATIONS_ENUM.REMOVE_NODE_BACK,
				name:
					record?.subscriptions?.length > 0
						? getThisNodeName() // if we are doing a removal with explicit subscriptions, we want to the other node to remove the record for this node
						: node_record_id, // if we are doing a removal with full replication, we want the other node to remove its own record to indicate it is not replicating
			},
			undefined
		).catch((err) => {
			hdb_logger.warn(
				`Error removing node from target node ${node_record_id}, if it is offline and we be online in the future, you may need to clean up this node manually, or retry:`,
				err
			);
		});

		await hdb_nodes.delete(node_record_id);

		return `Successfully removed '${node_record_id}' from manifest`;
	}

	if (!url) throw new ClientError('url required for this operation');

	const this_url = getThisNodeUrl();
	if (this_url == null) throw new ClientError('replication url is missing from harperdb-config.yaml');

	let rep;
	let csr;
	let cert_auth;
	if (url?.startsWith('wss:')) {
		if (req.operation === 'add_node' && !req.authorization)
			throw new ClientError('authorization parameter is required');

		rep = await getReplicationCert();
		const ca_record = await getReplicationCertAuth();
		if (!rep) throw new Error('Unable to find a certificate to use for replication');
		if (rep.options.is_self_signed) {
			// Create the certificate signing request that will be sent to the other node
			csr = await createCsr();
			hdb_logger.info('Sending CSR to target node:', url);
		} else {
			cert_auth = ca_record?.certificate;
			hdb_logger.info('Sending CA named', ca_record?.name, 'to target node', url);
		}
	}

	// This is the record that will be added to the other nodes hdb_nodes table
	const target_add_node_obj = {
		operation: OPERATIONS_ENUM.ADD_NODE_BACK,
		node_name: get(CONFIG_PARAMS.REPLICATION_NODENAME),
		target_node_name: req.node_name,
		url: this_url,
		csr,
		cert_auth,
	};

	if (get(CONFIG_PARAMS.REPLICATION_NODENAME)) target_add_node_obj.node_name = get(CONFIG_PARAMS.REPLICATION_NODENAME);
	if (req.subscriptions) {
		target_add_node_obj.subscriptions = req.subscriptions.map(reverseSubscription);
	}

	if (req.hasOwnProperty('subscribe') || req.hasOwnProperty('publish')) {
		const rev = reverseSubscription(req);
		target_add_node_obj.subscribe = rev.subscribe;
		target_add_node_obj.publish = rev.publish;
	}

	if (req?.authorization?.username && req?.authorization?.password) {
		req.authorization =
			'Basic ' + Buffer.from(req.authorization.username + ':' + req.authorization.password).toString('base64');
	}

	let target_node_response;
	try {
		target_node_response = await sendOperationToNode({ url }, target_add_node_obj, req);
	} catch (err) {
		err.message = `Error returned from ${url}: ` + err.message;
		throw err;
	}

	if (
		csr &&
		(!target_node_response?.certificate || !target_node_response?.certificate?.includes?.('BEGIN CERTIFICATE'))
	) {
		throw new Error(
			`Unexpected certificate signature response from node ${url} response: ${JSON.stringify(target_node_response)}`
		);
	}

	if (csr) {
		hdb_logger.info('CSR response received from node:', url, 'saving certificate and CA in hdb_certificate');

		await setCertTable({
			name: pki.certificateFromPem(target_node_response.signingCA).issuer.getField('CN').value,
			certificate: target_node_response.signingCA,
			is_authority: true,
		});

		if (target_node_response.certificate) {
			await setCertTable({
				name: getThisNodeName(),
				uses: ['https', 'operations', 'wss'],
				certificate: target_node_response.certificate,
				private_key_name: rep?.options?.key_file,
				is_authority: false,
				is_self_signed: false,
			});
		}
		cert_auth = target_node_response.signingCA;
	}

	const node_record = { url, ca: target_node_response.usingCA };
	if (req.node_name) node_record.name = req.node_name;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	else node_record.replicates = true;

	if (node_record.replicates) {
		await ensureNode(getThisNodeName(), {
			url: this_url,
			ca: cert_auth,
			replicates: true,
		});
	}
	await ensureNode(target_node_response.nodeName, node_record);

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
	if (req.target_node_name && req.target_node_name !== getThisNodeName()) {
		return { error: `node_name does not match configured node name ${getThisNodeName()}` };
	}

	const certs = await signCertificate(req);
	// If the add_node req has a CSR attached, return the CA that was used to issue the CSR,
	// else return whatever CA this node is using for replication
	let origin_ca;
	if (!req.csr) {
		// If there is no CSR in the request there should be a CA, use this CA in the hdb_nodes record for origin node
		origin_ca = req?.cert_auth?.certificate;
		hdb_logger.info('addNodeBack received CA name:', req.cert_auth?.name, 'from node:', req.url);
	} else {
		origin_ca = certs.signingCA;
		hdb_logger.info(
			'addNodeBack received CSR from node:',
			req.url,
			'this node will use and respond with CA that was used to issue CSR'
		);
	}

	const node_record = { url: req.url, ca: origin_ca };
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	else node_record.replicates = true;
	const rep_ca = await getReplicationCertAuth();
	if (node_record.replicates) {
		await ensureNode(getThisNodeName(), {
			url: getThisNodeUrl(),
			ca: rep_ca?.certificate,
			replicates: true,
		});
	}
	await ensureNode(req.node_name, node_record);
	certs.nodeName = getThisNodeName();

	certs.usingCA = rep_ca?.certificate; // in addition to the signed CA, we need to return the CA that is being used for the active certificate
	hdb_logger.info('addNodeBack responding to:', req.url, 'with CA named:', rep_ca?.name);

	return certs;
}

/**
 * Is called by other node when remove_node is requested and
 * system tables are not replicating
 */
export async function removeNodeBack(req) {
	hdb_logger.trace('removeNodeBack received request:', req);
	const hdb_nodes = getHDBNodeTable();
	//  delete the record
	await hdb_nodes.delete(req.name);
}

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}
