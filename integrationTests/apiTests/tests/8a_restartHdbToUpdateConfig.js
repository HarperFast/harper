import { describe, it } from 'node:test';
import request from 'supertest';
import assert from 'node:assert';
import { envUrl, generic, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';

describe('8a. Restart HDB to update config', () => {
	//Restart HDB to update config Folder

	it('Drop cluster_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'drop_user',
				username: 'cluster_user1'
			})
			.expect([200, 404]);
	});

	it('Create new cluster_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'cluster_user',
				username: 'cluster_user1',
				password: 'cluster_user1',
				active: true
			})
			.expect(200);
	});

	it('Get Configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.rootPath);
				generic.rootPath = r.body.rootPath;
			})
			.expect(200)
	});

	it('Set Nats clustering configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_configuration',
				clustering_enabled: true,

				clustering_hubServer_cluster_name: 'harperdb',
				clustering_hubServer_cluster_network_port: '9932',
				clustering_hubServer_cluster_network_routes: null,

				clustering_hubServer_leafNodes_network_port: '9931',

				clustering_hubServer_network_port: '9930',

				clustering_leafServer_network_port: '9940',
				clustering_leafServer_network_routes: null,

				clustering_leafServer_streams_maxAge: null,
				clustering_leafServer_streams_maxBytes: null,
				clustering_leafServer_streams_maxMsgs: null,
				clustering_leafServer_streams_maxConsumeMsgs: '100',
				clustering_leafServer_streams_maxIngestThreads: '2',

				clustering_nodeName: 'local',

				clustering_republishMessages: false,
				clustering_databaseLevel: false,

				clustering_user: 'cluster_user1',

				clustering_tls_certificate: `${generic.rootPath}/keys/natsCertificate.pem`,
				clustering_tls_certificateAuthority: `${generic.rootPath}/keys/natsCaCertificate.pem`,
				clustering_tls_privateKey: `${generic.rootPath}/keys/privateKey.pem`,
				clustering_tls_insecure: true,
				clustering_tls_verify: true,
			})
			.expect(200);
	});

	it('Turn on log audit and custom functions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_configuration',
				logging_auditLog: true,
				customFunctions_enabled: true,
				localStudio_enabled: true,
				replication_url: null
			})
			.expect(200);
	});

	it('Restart for new settings', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'restart' })
			.expect((r) => assert.ok(r.body.message.includes('Restarting')))
			.expect(200);
		await setTimeout(generic.restartTimeout);
	});
});
