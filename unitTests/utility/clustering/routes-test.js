'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const config_utils = require('../../../config/configUtils');
const routes = require('../../../utility/clustering/routes');

describe('Test routes module', () => {
	const sandbox = sinon.createSandbox();
	let update_config_stud;
	let get_clustering_routes_stub;

	before(() => {
		update_config_stud = sandbox.stub(config_utils, 'updateConfigValue');
		get_clustering_routes_stub = sandbox.stub(config_utils, 'getClusteringRoutes');
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	describe('Test setRoutes function', () => {
		it('Test hub routes are set when no other existing routes', () => {
			get_clustering_routes_stub.returns({
				hub_routes: [],
				leaf_routes: [],
			});
			const test_req = {
				operation: 'cluster_set_routes',
				server: 'hub',
				routes: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
					{
						host: '1.2.44.244',
						port: 7719,
					},
				],
			};
			const result = routes.setRoutes(test_req);
			expect(update_config_stud.args[0][0]).to.equal('clustering_hubServer_cluster_network_routes');
			expect(update_config_stud.args[0][1]).to.eql([
				{
					host: 'dev.chicken',
					port: 7718,
				},
				{
					host: '1.2.44.244',
					port: 7719,
				},
			]);
			expect(result).to.eql({
				message: 'cluster routes successfully set',
				set: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
					{
						host: '1.2.44.244',
						port: 7719,
					},
				],
				skipped: [],
			});
		});

		it('Test hub one hub route set and one skipped', () => {
			get_clustering_routes_stub.returns({
				hub_routes: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
				leaf_routes: [],
			});
			const test_req = {
				operation: 'cluster_set_routes',
				server: 'hub',
				routes: [
					{
						host: '1.2.44.244',
						port: 7719,
					},
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
			};
			const result = routes.setRoutes(test_req);
			expect(update_config_stud.args[0][0]).to.equal('clustering_hubServer_cluster_network_routes');
			expect(update_config_stud.args[0][1]).to.eql([
				{
					host: 'dev.chicken',
					port: 7718,
				},
				{
					host: '1.2.44.244',
					port: 7719,
				},
			]);
			expect(result).to.eql({
				message: 'cluster routes successfully set',
				set: [
					{
						host: '1.2.44.244',
						port: 7719,
					},
				],
				skipped: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
			});
		});

		it('Test one leaf route skipped because route exists in hub', () => {
			get_clustering_routes_stub.returns({
				hub_routes: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
				leaf_routes: [],
			});
			const test_req = {
				operation: 'cluster_set_routes',
				server: 'leaf',
				routes: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
			};
			const result = routes.setRoutes(test_req);
			expect(update_config_stud.args[0][0]).to.equal('clustering_leafServer_network_routes');
			expect(update_config_stud.args[0][1]).to.eql([]);
			expect(result).to.eql({
				message: 'cluster routes successfully set',
				set: [],
				skipped: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
			});
		});
	});

	describe('Test getRoutes function', () => {
		it('Test hub and leaf routes are returned', () => {
			get_clustering_routes_stub.returns({
				hub_routes: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
				leaf_routes: [
					{
						host: 'dev.wing',
						port: 7716,
					},
				],
			});
			const result = routes.getRoutes();
			expect(result).to.eql({
				hub: [
					{
						host: 'dev.chicken',
						port: 7718,
					},
				],
				leaf: [
					{
						host: 'dev.wing',
						port: 7716,
					},
				],
			});
		});
	});
});
