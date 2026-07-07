// Custom MCP content resources (#1609): a tiny in-memory docs site. No table —
// pure author-defined content, the exact shape the issue's docs server needs.
const PAGES = {
	'guides/install.md': '# Install\n\nnpm install -g harper',
	'guides/deploy.md': '# Deploy\n\nharper deploy',
	'reference/config.md': '# Config\n\nSee harperdb-config.yaml',
};

export class DocsPages extends Resource {
	async readIndex() {
		return {
			text: Object.keys(PAGES)
				.map((p) => `- docs:///${p}`)
				.join('\n'),
			mimeType: 'text/markdown',
		};
	}

	async readPage(params) {
		const body = PAGES[params.path];
		if (!body) throw new Error(`no such page: ${params.path}`);
		return { text: body, mimeType: 'text/markdown' };
	}

	async readLogo() {
		// 1x1 transparent PNG
		return {
			blob: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
			mimeType: 'image/png',
		};
	}
}

DocsPages.mcpResources = [
	{
		uri: 'docs:///index',
		name: 'docs index',
		description: 'List of all documentation pages',
		mimeType: 'text/markdown',
		method: 'readIndex',
	},
	{
		uri: 'docs:///logo',
		name: 'docs logo',
		description: 'Site logo (binary content)',
		method: 'readLogo',
	},
	{
		uriTemplate: 'docs:///{+path}',
		name: 'docs page',
		description: 'A documentation page by path',
		mimeType: 'text/markdown',
		method: 'readPage',
		completions: { path: ['guides/install.md', 'guides/deploy.md', 'reference/config.md'] },
	},
];
