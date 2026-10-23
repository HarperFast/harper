'use strict';

const assert = require('node:assert');
const { previewSlug, defaultPreviewDomain, planPreviewDeploy, formatPreviewList } = require('#src/bin/preview');

describe('harper preview (harper#3054)', () => {
	describe('previewSlug', () => {
		it('turns a branch into one lowercase DNS label', () => {
			assert.strictEqual(previewSlug('david/1778-custom-regions', 12), 'david-1778-custom-regions');
			assert.strictEqual(previewSlug('Feature/Ünïcödé__Branch!!', 3), 'feature-unicode-branch');
			assert.strictEqual(previewSlug('--leading/and/trailing--', 3), 'leading-and-trailing');
		});

		it('falls back to pr-<n> for an empty or reserved slug', () => {
			assert.strictEqual(previewSlug('///', 7), 'pr-7');
			assert.strictEqual(previewSlug('WWW', 7), 'pr-7');
			assert.strictEqual(previewSlug('api', 7), 'pr-7');
		});

		it('cuts a long slug to the limit with a hash of the branch, so two long branches stay apart', () => {
			const a = previewSlug(`feature/${'x'.repeat(60)}-a`, 1);
			const b = previewSlug(`feature/${'x'.repeat(60)}-b`, 1);
			assert.strictEqual(a.length, 40);
			assert.match(a, /^feature-x+-[0-9a-f]{6}$/);
			assert.notStrictEqual(a, b);
		});
	});

	it('derives the preview domain from the target host', () => {
		assert.strictEqual(
			defaultPreviewDomain('https://shop.acme.harperfabric.com:9925'),
			'app.shop.acme.harperfabric.com'
		);
		assert.strictEqual(defaultPreviewDomain('https://127.0.0.1:9925'), undefined);
		assert.strictEqual(defaultPreviewDomain(undefined), undefined);
	});

	describe('planPreviewDeploy', () => {
		const now = Date.parse('2026-10-23T00:00:00.000Z');
		const target = 'https://shop.acme.harperfabric.com';

		it('deploys <app>-pr-<n> as an isolated, branched application at its host, with its preview metadata', () => {
			const { request, host, project } = planPreviewDeploy(
				{ app: 'shop', pr: 12, branch: 'david/1778-custom-regions', sha: 'abc1234', repository: 'acme/shop' },
				{ resolvedTarget: target, now }
			);
			assert.strictEqual(project, 'shop-pr-12');
			assert.strictEqual(host, 'david-1778-custom-regions.app.shop.acme.harperfabric.com');
			assert.deepStrictEqual(request, {
				operation: 'deploy_component',
				project: 'shop-pr-12',
				host,
				isolated: true,
				branchedDatabases: true,
				restart: true,
				preview: {
					app: 'shop',
					pr: 12,
					branch: 'david/1778-custom-regions',
					expiresAt: '2026-10-30T00:00:00.000Z',
					repository: 'acme/shop',
					sha: 'abc1234',
				},
			});
		});

		it('carries a label, honors overrides, and passes deploy fields through', () => {
			const { request, host } = planPreviewDeploy(
				{
					app: 'studio',
					pr: 3,
					branch: 'fix',
					label: 'studio',
					domain: 'previews.example.com',
					ttl: 1,
					branchedDatabases: false,
					by_ref: true,
					ref: 'deadbeef',
				},
				{ now }
			);
			assert.strictEqual(host, 'fix-studio.previews.example.com');
			assert.deepStrictEqual(request.branchedDatabases, [], 'an empty list clears what a redeploy would keep');
			assert.strictEqual(request.by_ref, true);
			assert.strictEqual(request.preview.sha, 'deadbeef', 'a commit ref is the commit');
			assert.strictEqual(request.preview.expiresAt, '2026-10-24T00:00:00.000Z');
		});

		it("appends -pr<n> when another preview already holds the slug's host", () => {
			const components = [{ name: 'shop-pr-9', host: 'fix.app.shop.acme.harperfabric.com' }];
			const plan = (pr) =>
				planPreviewDeploy({ app: 'shop', pr, branch: 'fix' }, { components, resolvedTarget: target, now });
			assert.strictEqual(plan(12).host, 'fix-pr12.app.shop.acme.harperfabric.com');
			assert.strictEqual(plan(9).host, 'fix.app.shop.acme.harperfabric.com', 'its own host is not a collision');
			components.push({ name: 'shop-pr-13', host: 'Fix-PR12.App.Shop.Acme.HarperFabric.com' });
			assert.throws(() => plan(12), /already the host of another preview/);
		});

		it('references the credential granted to every preview of the app', () => {
			const { request } = planPreviewDeploy(
				{ app: 'shop', pr: 12, branch: 'fix', by_ref: true, credential: true },
				{ resolvedTarget: target, now }
			);
			assert.deepStrictEqual(request.credentials, [{ host: 'github.com', secret: 'deploy.shop-pr-_.git.github.com' }]);
			assert.strictEqual(request.credential, undefined);
		});

		it('reads branch and sha as typed, not as JSON', () => {
			const args = { app: 'shop', pr: 12, branch: 1, sha: 1234567 };
			Object.defineProperty(args, '_rawArgs', { value: { branch: '1.0', sha: '1234567' } });
			const { request } = planPreviewDeploy(args, { resolvedTarget: target, now });
			assert.strictEqual(request.preview.branch, '1.0');
			assert.strictEqual(request.preview.sha, '1234567');
		});

		for (const [description, args, message] of [
			['no app', { pr: 1, branch: 'b' }, /app=<component>/],
			['a PR that is not a number', { app: 'shop', pr: 'x', branch: 'b' }, /pr=<n>/],
			['no branch', { app: 'shop', pr: 1 }, /branch=<name>/],
			['no domain for a target that is not a host name', { app: 'shop', pr: 1, branch: 'b' }, /domain=/],
			['a label that is not a DNS label', { app: 'shop', pr: 1, branch: 'b', domain: 'x.com', label: 'a.b' }, /label=/],
		]) {
			it(`refuses ${description}`, () => assert.throws(() => planPreviewDeploy(args, { now }), message));
		}
	});

	it('lists previews with their PR, branch, commit, URL and expiry', () => {
		const entries = [
			{
				name: 'shop-pr-12',
				host: 'fix.app.example.com',
				preview: { app: 'shop', pr: 12, branch: 'fix', sha: 'abc1234def567890', expiresAt: '2026-10-30T00:00:00.000Z' },
			},
			{ name: 'shop', host: 'shop.example.com' },
			{ name: 'docs-pr-1', preview: { app: 'docs', pr: 1, branch: 'main' } },
		];
		assert.strictEqual(
			formatPreviewList(entries, 'shop'),
			'shop-pr-12  PR 12  fix  abc1234def56  https://fix.app.example.com/  expires 2026-10-30T00:00:00.000Z'
		);
		assert.strictEqual(formatPreviewList(entries).split('\n').length, 2);
		assert.strictEqual(formatPreviewList(entries, 'studio'), 'No previews of studio.');
	});
});
