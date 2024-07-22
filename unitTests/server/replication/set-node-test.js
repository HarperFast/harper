'use strict';

require('../../test_utils');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const set_node = require('../../../server/replication/setNode');
const replicator = require('../../../server/replication/replicator');
const sub_mgr = require('../../../server/replication/subscriptionManager');
const keys = require('../../../security/keys');
const known_nodes = require('../../../server/replication/knownNodes');

const test_this_node_name = '127.0.0.4';
const test_response_node_name = '127.0.0.8';
const test_signing_ca =
	'-----BEGIN CERTIFICATE-----\r\nMIIFlzCCA3+gAwIBAgIEaDmXUzANBgkqhkiG9w0BAQsFADB7MS4wLAYDVQQDEyVI\r\nYXJwZXJEQi1DZXJ0aWZpY2F0ZS1BdXRob3JpdHktbm9kZS0xMQwwCgYDVQQGEwNV\r\nU0ExETAPBgNVBAgTCENvbG9yYWRvMQ8wDQYDVQQHEwZEZW52ZXIxFzAVBgNVBAoT\r\nDkhhcnBlckRCLCBJbmMuMB4XDTI0MDcxNjE5MDAwMloXDTM0MDcxNDE5MDAwMlow\r\nezEuMCwGA1UEAxMlSGFycGVyREItQ2VydGlmaWNhdGUtQXV0aG9yaXR5LW5vZGUt\r\nMTEMMAoGA1UEBhMDVVNBMREwDwYDVQQIEwhDb2xvcmFkbzEPMA0GA1UEBxMGRGVu\r\ndmVyMRcwFQYDVQQKEw5IYXJwZXJEQiwgSW5jLjCCAiIwDQYJKoZIhvcNAQEBBQAD\r\nggIPADCCAgoCggIBALXe6ZKtfL8fULSyfMLPiBNF1++fAlyrjIhDwcphNIV8kinY\r\ndR1vmbNesOfzUQjg5s8ybbyZ05UI97wLftrkgeYZpv3/zt9CdBBG5FAhvA7xhMK3\r\nxtDq/iFyTjWiP9hEMClNS7nvOiFbmU4CsItG2PeIALsvlelrYxRJgTIgXTeA2sJ8\r\nyQZcmaV0+h4WsT/bK7qrLI9KoDctyljq3v8vCcp2ZxHlspqxio/o3pOjmozwzXeS\r\n6RBf6U0EEvD7JoTlMWm3E2LhNeWNdMAN6QUwOE6cbvyizRsKALEZgWi5EwB3QL2/\r\nc3CNBXChprQjTw9fb/B/RRbOlnzE+yJdDabY8dD1BVoWIrv7VCUTGTmn8Pc4qsTv\r\nb3JXfyfM0mWzIJv+u4/fEOWD+BqTixqdjxh0JoeUu1C4L3/G+axsSI0acxFGgzPd\r\nA4JqyVBM476gGRWVufadc51YXca1q875+0qdJ7i1xWR6h4n+wQBNaNaqegYJ8MGK\r\nJNHQKz94AYJ3epn3/fBfLsOpuOHWA4Hwsb6lEtlyEiyfPn3PAXgjuwQyh7ayudzx\r\nAuLBfY9Y7lOuCYrCBMZO2/PdJtl3Rg5lCcIFifOc+ayGC0bNNYgkbuoJDllim6i2\r\nw28T4zQ9QkUSmyiII1LYleb/fJJQw1qcxPP8Pam/j/Y6nK28HTtbu+UJqKHbAgMB\r\nAAGjIzAhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgIEMA0GCSqGSIb3\r\nDQEBCwUAA4ICAQCkJTowQ6rheHs1vTU1WFQwSrAUp5lVWDKi66GTpTEmCiwEcBNr\r\nKjG8tbNxbhJjHWMjFdaqyQ0w53h998wTAUHG+avPAOBIO1dmBXJfTmNEFLbHxWIr\r\n9Uw62A4IPWVWGm+6xmJW3W4xi1PzFaFO7C0vlmvt+g9VHe2yNKdseXjIzrVgraUa\r\nA/dNLAfDCyKTsEzpPkurof8ypt85DN0cMKAXvOoT8EIt8G7r6UGRu0Bs/HxwwNWm\r\nTzO2Qw/sqqxw5xAcfYc1Y9ZDRa1U2xzyD5+IXf8fsf3ujfuRZHsfgowrQxCoza32\r\naDMc5fTn3heDYaomA0tMrBVcpw+GSorUBs1jKtzUyli3UPEREFXcrFOjGyxLfwr5\r\nThlpYmhHjHqqNGDyakkztkHM7pcFSwMLERaFy0rgyfKCVFfKioXWloldRyhGNRZn\r\nhVfsvt15hzFqBmzQylZpULIbqQgGS9+YV72Zwz7c35NCDqh6vQKbEEH9da49yQ1K\r\nvV4/7EYx829MhWqFLk4/qG8obV3YjU+HXHfuCVXERVZ2d0jgQrcD6QQiYtGksPtW\r\njqPbJ6xfDiTCu3Ymn4573mkvcC9cTIxtg6R5aqurcwzSz/gyCukKTn0Y3kOaL2al\r\noWs+nxyffWS55Cqm/mH5A12QpAQWjASZfkpvr/fKWMlPJAehRCjkOZY+dQ==\r\n-----END CERTIFICATE-----\r\n';
const test_cert =
	'-----BEGIN CERTIFICATE-----\r\n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\r\nM5JGIxs+WsUncJARw0rSkIWVFTN0AD1Oyg==\r\n-----END CERTIFICATE-----\r\n';
const test_using_ca =
	'-----BEGIN CERTIFICATE-----\r\nMIIFlzCCA3+gAwIBAgIEaDmXUzANBgkqhkiG9w0BAQsFADB7MS4wLAYDVQQDEyVI\r\nYXJwZXJEQi1DZXJ0aWZpY2F0ZS1BdXRob3JpdHktbm9kZS0xMQwwCgYDVQQGEwNV\r\nU0ExETAPBgNVBAgTCENvbG9yYWRvMQ8wDQYDVQQHEwZEZW52ZXIxFzAVBgNVBAoT\r\nDkhhcnBlckRCLCBJbmMuMB4XDTI0MDcxNjE5MDAwMloXDTM0MDcxNDE5MDAwMlow\r\nezEuMCwGA1UEAxMlSGFycGVyREItQ2VydGlmaWNhdGUtQXV0aG9yaXR5LW5vZGUt\r\nMTEMMAoGA1UEBhMDVVNBMREwDwYDVQQIEwhDb2xvcmFkbzEPMA0GA1UEBxMGRGVu\r\ndmVyMRcwFQYDVQQKEw5IYXJwZXJEQiwgSW5jLjCCAiIwDQYJKoZIhvcNAQEBBQAD\r\nggIPADCCAgoCggIBALXe6ZKtfL8fULSyfMLPiBNF1++fAlyrjIhDwcphNIV8kinY\r\ndR1vmbNesOfzUQjg5s8ybbyZ05UI97wLftrkgeYZpv3/zt9CdBBG5FAhvA7xhMK3\r\nxtDq/iFyTjWiP9hEMClNS7nvOiFbmU4CsItG2PeIALsvlelrYxRJgTIgXTeA2sJ8\r\nyQZcmaV0+h4WsT/bK7qrLI9KoDctyljq3v8vCcp2ZxHlspqxio/o3pOjmozwzXeS\r\n6RBf6U0EEvD7JoTlMWm3E2LhNeWNdMAN6QUwOE6cbvyizRsKALEZgWi5EwB3QL2/\r\nc3CNBXChprQjTw9fb/B/RRbOlnzE+yJdDabY8dD1BVoWIrv7VCUTGTmn8Pc4qsTv\r\nb3JXfyfM0mWzIJv+u4/fEOWD+BqTixqdjxh0JoeUu1C4L3/G+axsSI0acxFGgzPd\r\nA4JqyVBM476gGRWVufadc51YXca1q875+0qdJ7i1xWR6h4n+wQBNaNaqegYJ8MGK\r\nJNHQKz94AYJ3epn3/fBfLsOpuOHWA4Hwsb6lEtlyEiyfPn3PAXgjuwQyh7ayudzx\r\nAuLBfY9Y7lOuCYrCBMZO2/PdJtl3Rg5lCcIFifOc+ayGC0bNNYgkbuoJDllim6i2\r\nw28T4zQ9QkUSmyiII1LYleb/fJJQw1qcxPP8Pam/j/Y6nK28HTtbu+UJqKHbAgMB\r\nAAGjIzAhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgIEMA0GCSqGSIb3\r\nDQEBCwUAA4ICAQCkJTowQ6rheHs1vTU1WFQwSrAUp5lVWDKi66GTpTEmCiwEcBNr\r\nKjG8tbNxbhJjHWMjFdaqyQ0w53h998wTAUHG+avPAOBIO1dmBXJfTmNEFLbHxWIr\r\n9Uw62A4IPWVWGm+6xmJW3W4xi1PzFaFO7C0vlmvt+g9VHe2yNKdseXjIzrVgraUa\r\nA/dNLAfDCyKTsEzpPkurof8ypt85DN0cMKAXvOoT8EIt8G7r6UGRu0Bs/HxwwNWm\r\nTzO2Qw/sqqxw5xAcfYc1Y9ZDRa1U2xzyD5+IXf8fsf3ujfuRZHsfgowrQxCoza32\r\naDMc5fTn3heDYaomA0tMrBVcpw+GSorUBs1jKtzUyli3UPEREFXcrFOjGyxLfwr5\r\nThlpYmhHjHqqNGDyakkztkHM7pcFSwMLERaFy0rgyfKCVFfKioXWloldRyhGNRZn\r\nhVfsvt15hzFqBmzQylZpULIbqQgGS9+YV72Zwz7c35NCDqh6vQKbEEH9da49yQ1K\r\nvV4/7EYx829MhWqFLk4/qG8obV3YjU+HXHfuCVXERVZ2d0jgQrcD6QQiYtGksPtW\r\njqPbJ6xfDiTCu3Ymn4573mkvcC9cTIxtg6R5aqurcwzSz/gyCukKTn0Y3kOaL2al\r\noWs+nxyffWS55Cqm/mH5A12QpAQWjASZfkpvr/fKWMlPJAehRCjkOZY+dQ==\r\n-----END CERTIFICATE-----\r\n';
const test_response = {
	signingCA: test_signing_ca,
	certificate: test_cert,
	nodeName: test_response_node_name,
	usingCA: test_using_ca,
	requestId: 1,
};
const test_csr =
	'-----BEGIN CERTIFICATE REQUEST-----\r\nMIIDVTCCAj0CAQAwXzESMBAGA1UEAxMJMTI3LjAuMC4xMQwwCgYDVQQGEwNVU0Ex\r\nETAPBgNVBAgTCENvbG9yYWRvMQ8wDQYDVQQHEwZEZW52ZXIxFzAVBgNVBAoTDkhh\r\ncnBlckRCLCBJbmMuMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA87D9\r\nAUBJSSwnpzdmU4auIqhbRrqRmdjF76+nGwxfplhx3oUpvKBS281TUuYSbo+alrU3\r\n5i/1vhA1hK2vVL3wnAxeocHA8Zd8JF3cAab/7AX9sKzKuYaNz39bDQdgWS8yFC8L\r\nsX0QR3DvFrOK/20rykRvdMFkwyJs/FqId7UveMN/jbkZ1fUTpYgoNgUOLcV5UZtB\r\nlWFuK+3B/QCDFs3dQIc5XzNVdkAJpXczDpfYKpZeXOxxXU5XeKV/IegyVvyT05XM\r\n5Xl1gJ2mn/1YM+LR2eEWyXXX40q6tQbndLpdrBO6WSxUBF/nejQXyejdRawPNYa0\r\nLFwQyaVQaCdCOftYowIDAQABoIGwMB0GCSqGSIb3DQEJAjEQDA5IYXJwZXJEQiwg\r\nSW5jLjCBjgYJKoZIhvcNAQkOMYGAMH4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8E\r\nBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMBEGCWCGSAGG+EIB\r\nAQQEAwIGwDAsBgNVHREEJTAjhwR/AAABgglsb2NhbGhvc3SHEAAAAAAAAAAAAAAA\r\nAAAAAAEwDQYJKoZIhvcNAQEFBQADggEBADFY/OGAl+NXByIvzvzDBjE2CaPudyC+\r\nV9dSsrBm6AMCHtRM7ny6C5PtwSf2583KKl0dxw4GUtjh5DdfJh0qw7MB+Hlf+Xo3\r\nY93x/0nZL7r69f6d+zJo1UJUbIGO+I/V10ftuiViHgAFRivQg/NvhxIdPZiADznD\r\nHMuGSemaxSSKFHZ9+Gklc9uFssomvvjjluZ1A8+Py1mm/N55BjlnG1SuaoB9/yVL\r\nWoAa629kcKFTeQXvgsRsT07GkSF9IwfUI3097stzts2fUg4V8JNHWPcnxzp+cM/O\r\nBd/AOFT1Kn0K8NwH4W2cPHjEAaIlUSeYlwPSEL7BH1iaf6bOREQs3G4=\r\n-----END CERTIFICATE REQUEST-----\r\n';

describe('Test setNode', () => {
	const sandbox = sinon.createSandbox();
	let send_to_node_stub;
	let set_cert_table_stub;
	let ensure_node_stub;
	let get_this_node_name_stub;
	let get_this_node_url_stub;
	let get_rep_cert_stub;
	let get_rep_ca_stub;

	before(() => {
		get_this_node_url_stub = sandbox.stub(replicator, 'getThisNodeUrl').returns(`wss://${test_this_node_name}:9925`);
		send_to_node_stub = sandbox.stub(replicator, 'sendOperationToNode');
		set_cert_table_stub = sandbox.stub(keys, 'setCertTable');
		ensure_node_stub = sandbox.stub(sub_mgr, 'ensureNode');
		get_this_node_name_stub = sandbox.stub(replicator, 'getThisNodeName').returns(test_this_node_name);
		get_rep_cert_stub = sandbox
			.stub(keys, 'getReplicationCert')
			.resolves({ options: { is_self_signed: true, key_file: 'privateKey.pem' } });
		get_rep_ca_stub = sandbox.stub(keys, 'getReplicationCertAuth').resolves({ certificate: test_using_ca });
		keys.loadCertificates();
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test setNode can add a new node', async () => {
		send_to_node_stub.resolves(test_response);
		const res = await set_node.setNode({
			operation: 'add_node',
			url: 'wss://123.0.0.1:9925',
			rejectUnauthorized: false,
			authorization: {
				username: 'harper',
				password: 'i-like-sticks',
			},
		});

		expect(set_cert_table_stub.args[0][0]).to.eql({
			name: 'HarperDB-Certificate-Authority-node-1',
			certificate: test_signing_ca,
			is_authority: true,
		});
		expect(set_cert_table_stub.args[1][0]).to.eql({
			name: test_this_node_name,
			uses: ['https', 'operations', 'wss'],
			certificate: test_cert,
			private_key_name: 'privateKey.pem',
			is_authority: false,
			is_self_signed: false,
		});
		expect(ensure_node_stub.args[0]).to.eql([
			'127.0.0.4',
			{
				url: 'wss://127.0.0.4:9925',
				ca: test_signing_ca,
				replicates: true,
			},
		]);
		expect(ensure_node_stub.args[1]).to.eql([
			test_response_node_name,
			{
				url: 'wss://123.0.0.1:9925',
				ca: test_using_ca,
				replicates: true,
			},
		]);

		expect(res).to.equal("Successfully added 'wss://123.0.0.1:9925' to manifest");
	});

	it('Test addNodeBack', async () => {
		sandbox.stub(keys, 'signCertificate').resolves({ signingCA: test_signing_ca, usingCA: test_using_ca });
		const res = await set_node.addNodeBack({ url: 'wss://127.0.0.4:9925', csr: test_csr });
		expect(ensure_node_stub.args[0]).to.eql([
			'127.0.0.4',
			{
				url: 'wss://127.0.0.4:9925',
				ca: test_using_ca,
				replicates: true,
			},
		]);
		expect(ensure_node_stub.args[1]).to.eql([
			undefined,
			{
				url: 'wss://127.0.0.4:9925',
				ca: test_using_ca,
				replicates: true,
			},
		]);
	});

	it('Test setNode can remove a node', async () => {
		const fake_delete = sandbox.stub().callsFake(() => {});
		const hdb_nodes_fake = {
			get: () => {
				return { url: 'node-to-delete' };
			},
			delete: fake_delete,
		};
		sandbox.stub(known_nodes, 'getHDBNodeTable').returns(hdb_nodes_fake);
		const res = await set_node.setNode({
			operation: 'remove_node',
			node_name: 'node-to-delete',
		});
		expect(send_to_node_stub.args[0]).to.eql([
			{
				url: 'node-to-delete',
			},
			{
				operation: 'remove_node_back',
				name: 'node-to-delete',
			},
			undefined,
		]);
		expect(fake_delete.args[0][0]).to.equal('node-to-delete');
	});
});
