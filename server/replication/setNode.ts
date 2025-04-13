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
import { getThisNodeUrl, sendOperationToNode, urlToNodeName, getThisNodeName, hostnameToUrl } from './replicator';
import * as hdb_logger from '../../utility/logging/harper_logger';
import { handleHDBError, hdb_errors, ClientError } from '../../utility/errors/hdbError.js';
const { HTTP_STATUS_CODES } = hdb_errors;

const validation_schema = Joi.object({
	hostname: Joi.string(),
	verify_tls: Joi.boolean(),
	replicates: Joi.boolean(),
	subscriptions: Joi.array(),
	revoked_certificates: Joi.array(),
	shard: Joi.number(),
});

/**
 * Can add, update or remove a node from replication
 * @param req
 */
export async function setNode(req: object) {
	if (req.node_name && !req.hostname) req.hostname = req.node_name;
	if (req.verify_tls !== undefined) req.rejectUnauthorized = req.verify_tls;
	let { url, hostname } = req;
	if (!url) url = hostnameToUrl(hostname);
	else if (!hostname) hostname = req.hostname = urlToNodeName(url);
	const validation = validateBySchema(req, validation_schema);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (req.operation === 'remove_node') {
		if (!url && !hostname) throw new ClientError('url or hostname is required for remove_node operation');
		const node_record_id = hostname;
		const hdb_nodes = getHDBNodeTable();
		const record = await hdb_nodes.get(node_record_id);
		if (!record) throw new ClientError(node_record_id + ' does not exist');

		try {
			// we delete record and req that other node also deletes record (or mark itself as non-replicating)
			// we do not wait for the other node to respond, it may not even be online anymore
			await sendOperationToNode(
				{ url: record.url },
				{
					operation: OPERATIONS_ENUM.REMOVE_NODE_BACK,
					name:
						record?.subscriptions?.length > 0
							? getThisNodeName() // if we are doing a removal with explicit subscriptions, we want to the other node to remove the record for this node
							: node_record_id, // if we are doing a removal with full replication, we want the other node to remove its own record to indicate it is not replicating
				},
				undefined
			);
		} catch (err) {
			hdb_logger.warn(
				`Error removing node from target node ${node_record_id}, if it is offline and we be online in the future, you may need to clean up this node manually, or retry:`,
				err
			);
		}

		await hdb_nodes.delete(node_record_id);

		return `Successfully removed '${nodeRecordId}' from cluster`;
	}

	if (!url) throw new ClientError('url required for this operation');

	const this_url = getThisNodeUrl();
	if (this_url == null) throw new ClientError('replication url is missing from harperdb-config.yaml');

	let rep;
	let csr;
	let cert_auth;
	if (url?.startsWith('wss:')) {
		rep = await getReplicationCert();
		const ca_record = await getReplicationCertAuth();
		if (!rep) throw new Error('Unable to find a certificate to use for replication');
		if (rep.options.is_self_signed) {
			// Create the certificate signing request that will be sent to the other node
			csr = await createCsr();
			hdb_logger.info('Sending CSR to target node:', url);
		} else if (ca_record) {
			cert_auth = ca_record.certificate;
			hdb_logger.info('Sending CA named', ca_record.name, 'to target node', url);
		}
	}

	// This is the record that will be added to the other nodes hdb_nodes table
	const target_add_node_obj = {
		operation: OPERATIONS_ENUM.ADD_NODE_BACK,
		hostname: get(CONFIG_PARAMS.REPLICATION_HOSTNAME),
		target_hostname: hostname,
		url: this_url,
		csr,
		cert_auth,
		authorization: req.retain_authorization ? req.authorization : null,
	};
	if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined)
		target_add_node_obj.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);

	if (req.subscriptions) {
		target_add_node_obj.subscriptions = req.subscriptions.map(reverseSubscription);
	} else target_add_node_obj.subscriptions = null;

	if (req.hasOwnProperty('subscribe') || req.hasOwnProperty('publish')) {
		const rev = reverseSubscription(req);
		target_add_node_obj.subscribe = rev.subscribe;
		target_add_node_obj.publish = rev.publish;
	}

	if (req?.authorization?.username && req?.authorization?.password) {
		req.authorization =
			'Basic ' + Buffer.from(req.authorization.username + ':' + req.authorization.password).toString('base64');
	}

	let target_node_response: any;
	let target_node_response_error: Error;
	try {
		target_node_response = await sendOperationToNode({ url }, target_add_node_obj, req);
	} catch (err) {
		err.message = `Error returned from ${url}: ` + err.message;
		hdb_logger.warn('Error adding node:', url, 'to cluster:', err);
		target_node_response_error = err;
	}

	if (
		csr &&
		(!target_node_response?.certificate || !target_node_response?.certificate?.includes?.('BEGIN CERTIFICATE'))
	) {
		if (target_node_response_error) {
			target_node_response_error.message += ' and connection was required to sign certificate';
			throw target_node_response_error;
		}
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

	const node_record = { url, ca: target_node_response?.usingCA };
	if (req.hostname) node_record.name = req.hostname;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	else node_record.replicates = true;
	if (req.start_time) {
		node_record.start_time = typeof req.start_time === 'string' ? new Date(req.start_time).getTime() : req.start_time;
	}
	if (req.retain_authorization) node_record.authorization = req.authorization;
	if (req.revoked_certificates) node_record.revoked_certificates = req.revoked_certificates;
	if (req.shard !== undefined) node_record.shard = req.shard;

	if (node_record.replicates) {
		const this_node = {
			url: this_url,
			ca: cert_auth,
			replicates: true,
			subscriptions: null,
		};
		if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined) this_node.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);

		if (req.retain_authorization) this_node.authorization = req.authorization;
		if (req.start_time) this_node.start_time = req.start_time;
		await ensureNode(getThisNodeName(), this_node);
	}
	await ensureNode(
		target_node_response ? target_node_response.nodeName : (node_record.name ?? urlToNodeName(url)),
		node_record
	);
	let message: string;
	if (req.operation === 'update_node') {
		message = `Successfully updated '${url}'`;
	} else message = `Successfully added '${url}' to cluster`;
	if (target_node_response_error)
		message += ' but there was an error updating target node: ' + target_node_response_error.message;
	return message;
}

/**
 * Is called by other node when an add_node operation is requested
 * @param req
 */
export async function addNodeBack(req) {
	hdb_logger.trace('addNodeBack received request:', req);

	const certs = await signCertificate(req);
	// If the add_node req has a CSR attached, return the CA that was used to issue the CSR,
	// else return whatever CA this node is using for replication
	let origin_ca: string;
	if (!req.csr) {
		// If there is no CSR in the request there should be a CA, use this CA in the hdb_nodes record for origin node
		origin_ca = req?.cert_auth;
		hdb_logger.info('addNodeBack received CA from node:', req.url);
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
	else {
		node_record.replicates = true;
		node_record.subscriptions = null;
	}

	if (req.start_time) node_record.start_time = req.start_time;
	if (req.authorization) node_record.authorization = req.authorization;
	if (req.shard !== undefined) node_record.shard = req.shard;

	const rep_ca = await getReplicationCertAuth();
	if (node_record.replicates) {
		const this_node = {
			url: getThisNodeUrl(),
			ca: rep_ca?.certificate,
			replicates: true,
			subscriptions: null,
		};
		if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined) this_node.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);

		if (req.start_time) this_node.start_time = req.start_time;
		if (req.authorization) this_node.authorization = req.authorization;
		await ensureNode(getThisNodeName(), this_node);
	}
	await ensureNode(req.hostname, node_record);
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
