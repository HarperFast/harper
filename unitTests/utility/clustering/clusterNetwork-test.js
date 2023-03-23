'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const cluster_network = require('../../../utility/clustering/clusterNetwork');

const fake_server_list = [
	{
		server: {
			name: 'david_local-hub',
		},
		data: {
			cluster: {
				urls: ['3.142.255.78:12345'],
			},
		},
		response_time: 4,
	},
	{
		server: {
			name: 'david_local-hub',
		},
		statsz: {
			routes: [
				{
					rid: 5,
					name: 'ec2-3-142-255-78-hub',
					sent: {
						msgs: 475,
						bytes: 259519,
					},
					received: {
						msgs: 434,
						bytes: 293355,
					},
					pending: 109,
				},
			],
			active_servers: 4,
		},
		response_time: 5,
	},
	{
		server: {
			name: 'david_local-leaf',
		},
		data: {
			cluster: {
				name: 'david_local-leaf',
			},
			gateway: {},
		},

		response_time: 5,
	},
	{
		server: {
			name: 'david_local-leaf',
		},
		statsz: {},
		response_time: 5,
	},
	{
		server: {
			name: 'ec2-3-142-255-78-hub',
		},
		data: {
			connect_urls: ['172.31.14.55:9930'],

			cluster: {
				name: 'harperdb',
				addr: '0.0.0.0',
				cluster_port: 12345,
				auth_timeout: 3,
				tls_timeout: 2,
				tls_required: true,
				tls_verify: true,
			},
			gateway: {},
		},
		response_time: 57,
	},
	{
		server: {
			name: 'ec2-3-142-255-78-hub',
		},
		statsz: {
			routes: [
				{
					rid: 15,
					name: 'ec2-3-12-153-124-hub',
					sent: {
						msgs: 436,
						bytes: 276169,
					},
					received: {
						msgs: 375,
						bytes: 232409,
					},
					pending: 0,
				},
				{
					rid: 9,
					name: 'ec2-3-139-236-138-hub',
					sent: {
						msgs: 2661,
						bytes: 473522,
					},
					received: {
						msgs: 397,
						bytes: 246704,
					},
					pending: 0,
				},
				{
					rid: 17,
					name: 'david_local-hub',
					sent: {
						msgs: 434,
						bytes: 293355,
					},
					received: {
						msgs: 474,
						bytes: 259519,
					},
					pending: 0,
				},
			],
			active_servers: 8,
		},
		response_time: 57,
	},
	{
		server: {
			name: 'ec2-3-142-255-78-leaf',
		},
		response_time: 58,
	},
];

describe('Test clusterNetwork module', () => {
	const sandbox = sinon.createSandbox();

	before(() => {
		sandbox.stub(nats_utils, 'getServerList').resolves(fake_server_list);
	});

	after(() => {
		sandbox.restore();
	});

	it('Correct network status is returned', async () => {
		const result = await cluster_network({});
		expect(result).to.eql({
			nodes: [
				{
					name: 'david_local',
					response_time: 4,
					connected_nodes: ['ec2-3-142-255-78'],
					routes: [
						{
							host: '3.142.255.78',
							port: '12345',
						},
					],
				},
				{
					name: 'ec2-3-142-255-78',
					response_time: 57,
					connected_nodes: ['ec2-3-12-153-124', 'ec2-3-139-236-138', 'david_local'],
					routes: [],
				},
			],
		});
	});

	it('Happy path but with no connected_nodes', async () => {
		const result = await cluster_network({ connected_nodes: false });
		expect(result).to.eql({
			nodes: [
				{
					name: 'david_local',
					response_time: 4,
					routes: [
						{
							host: '3.142.255.78',
							port: '12345',
						},
					],
				},
				{
					name: 'ec2-3-142-255-78',
					response_time: 57,
					routes: [],
				},
			],
		});
	});

	it('Happy path but with no routes', async () => {
		const result = await cluster_network({ routes: false });
		expect(result).to.eql({
			nodes: [
				{
					name: 'david_local',
					response_time: 4,
					connected_nodes: ['ec2-3-142-255-78'],
				},
				{
					name: 'ec2-3-142-255-78',
					response_time: 57,
					connected_nodes: ['ec2-3-12-153-124', 'ec2-3-139-236-138', 'david_local'],
				},
			],
		});
	});
});
