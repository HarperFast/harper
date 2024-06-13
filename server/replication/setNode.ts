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
	// TODO: improve the validation here
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

		// we delete record and req that other node also deletes record
		// we do not wait for the other node to respond, it may not even be online anymore
		sendOperationToNode(
			{ url: record.url },
			{
				operation: OPERATIONS_ENUM.REMOVE_NODE_BACK,
				name:
					record?.subscriptions?.length > 0
						? getThisNodeName() // if we are doing a removal with explicit subscriptions, we only want to the other node to remove the record for this node
						: node_record_id, // if we are doing a removal with full replication, we want the other node to remove its own record
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

	let csr;
	let cert_auth;
	if (url?.startsWith('wss:')) {
		const { rep, rep_ca } = await getCertsKeys();
		if (rep.name === 'default') {
			// Create the certificate signing request that will be sent to the other node
			csr = await createCsr();
			hdb_logger.info('Sending CSR to target node:', url);
		} else {
			cert_auth = rep_ca;
			hdb_logger.info('Sending CA named', rep_ca.name, 'to target node', url);
		}
	}

	// TODO: test adding a node to an instance without previous replication config.
	const this_url = getThisNodeUrl();
	if (this_url == null) {
		throw new Error('replication url is missing from harperdb-config.yaml');
	}

	// TODO: Do we need to do all the cert things for update_node
	// This is the record that will be added to the other nodes hdb_nodes table
	const target_add_node_obj = {
		operation: OPERATIONS_ENUM.ADD_NODE_BACK,
		node_name: get(CONFIG_PARAMS.REPLICATION_NODENAME),
		target_node_name: req.node_name,
		url: this_url,
		csr,
		cert_auth,
		//certificate: await readFile(get(CONFIG_PARAMS.TLS_CERTIFICATE), 'utf8'), //TODO: what cert should we pass here?
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
			name: `issued by ${urlToNodeName(url)}-ca`,
			certificate: target_node_response.ca_certificate,
			is_authority: true,
		});

		if (target_node_response.certificate) {
			await setCertTable({
				name: `issued by ${urlToNodeName(url)}`,
				uses: ['https', 'operations', 'wss'],
				certificate: target_node_response.certificate,
				private_key_name: 'privateKey.pem', // TODO: this needs to be the name of the private key file that was used for CSR
				is_authority: false,
			});
		}
	}

	const node_record = { url, ca: target_node_response.ca_certificate };
	if (req.node_name) node_record.name = req.node_name;
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	else node_record.replicates = true;

	if (node_record.replicates) {
		await ensureNode(getThisNodeName(), {
			url: this_url,
			ca: target_node_response.ca_certificate,
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
	if (req.target_node_name && req.target_node_name !== get(CONFIG_PARAMS.REPLICATION_NODENAME)) {
		return { error: 'node_name does not match configured node name' };
	}

	const certs = await signCertificate(req);
	// If the add_node req has a CSR attached, return the CA that was used to issue the CSR,
	// else return whatever CA this node is using for replication
	let origin_ca;
	if (!req.csr) {
		// If there is no CSR in the request there should be a CA, use this CA in the hdb_nodes record for origin node
		origin_ca = req.cert_auth.cert;
		hdb_logger.info('addNodeBack received CA name:', req.cert_auth.cert.name, 'from node:', req.url);
	} else {
		origin_ca = certs.ca_certificate;
		hdb_logger.info(
			'addNodeBack received CSR from node:',
			req.url,
			'this node will use and respond with CA that was used to issue CSR'
		);
	}

	const node_record = { url: req.url, ca: origin_ca };
	if (req.subscriptions) node_record.subscriptions = req.subscriptions;
	else node_record.replicates = true;
	if (node_record.replicates) {
		await ensureNode(getThisNodeName(), {
			url: getThisNodeUrl(),
			ca: certs.ca_certificate,
			replicates: true,
		});
	}
	await ensureNode(req.node_name, node_record);
	certs.nodeName = getThisNodeName();

	const { rep_ca } = await getCertsKeys();
	certs.ca_certificate = rep_ca.cert;
	hdb_logger.info('addNodeBack responding to:', req.url, 'with CA named:', rep_ca.name);

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
