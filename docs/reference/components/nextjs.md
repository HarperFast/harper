---
title: Next.js Plugin
---

# Next.js Plugin (`@harperfast/nextjs`)

`@harperfast/nextjs` is a Harper [Plugin](./plugin-api.md) for running [Next.js](https://nextjs.org/) applications directly on Harper. It supports Next.js v14, v15, and v16.

Source: [github.com/HarperFast/nextjs](https://github.com/HarperFast/nextjs) — [Example app](https://github.com/HarperFast/nextjs-example)

## Setup

### 1. Install

```sh
npm install @harperfast/nextjs
```

### 2. Wrap your Next.js config

Use `withHarper()` to wrap your existing Next.js config. All config formats are supported:

```js
// next.config.js (CommonJS)
const { withHarper } = require('@harperfast/nextjs');

module.exports = withHarper({
	// your existing Next.js config
});
```

```js
// next.config.mjs (ESM)
import { withHarper } from '@harperfast/nextjs';

export default withHarper({
	// your existing Next.js config
});
```

```ts
// next.config.ts (TypeScript)
import { withHarper } from '@harperfast/nextjs';

export default withHarper({
	// your existing Next.js config
});
```

`withHarper()` automatically adds `harper` and `harper-pro` to `serverExternalPackages` so Harper's native dependencies are handled correctly by the Next.js bundler.

### 3. Configure in `config.yaml`

```yaml
'@harperfast/nextjs':
  package: '@harperfast/nextjs'
```

### 4. Run

```sh
harper run nextjs-app
```

## Using Harper Globals

Within any server-side code path, import `harper` to access Harper's global APIs and interact with Harper tables directly:

> Ensure you are using `withHarper()`, or have manually added `harper` (or `harper-pro`) to the `serverExternalPackages` list in your Next.js config.

```js
// app/actions.js
'use server';

import 'harper';

export async function listDogs() {
	const dogs = [];
	for await (const dog of tables.Dog.search()) {
		dogs.push({ id: dog.id, name: dog.name });
	}
	return dogs;
}
```

```jsx
// app/dogs/[id]/page.jsx
import { getDog, listDogs } from '@/app/actions';

export async function generateStaticParams() {
	const dogs = await listDogs();
	return dogs;
}

export default async function Dog({ params }) {
	const dog = await getDog(params.id);

	return (
		<section>
			<h1>{dog.name}</h1>
			<p>Breed: {dog.get('breed')}</p>
		</section>
	);
}
```

## Options

All options are configured in `config.yaml` under the `@harperfast/nextjs` key. All options are optional.

### `bundler`

Type: `'webpack' | 'turbopack'`

Selects the bundler used for building and serving the Next.js application. The default depends on the Next.js version:

- Next.js v16: defaults to `turbopack` (matching the Next.js v16 default)
- Next.js v15: defaults to `webpack` (matching the Next.js v15 default)
- Next.js v14: always `webpack` (Turbopack is not supported)

```yaml
'@harperfast/nextjs':
  package: '@harperfast/nextjs'
  bundler: webpack
```

### `dev`

Type: `boolean`

Default: `false`

Enables Next.js development mode with hot module replacement (HMR).

> Dev mode relies on WebSockets. If you encounter an `Invalid WebSocket frame:` error, disable other WebSocket services running on the same port.

### `prebuilt`

Type: `boolean`

Default: `false`

When `true`, the plugin looks for an existing `.next` directory and skips the build step. Useful when the app is pre-built before deployment.

### `buildOnly`

Type: `boolean`

Default: `false`

Builds the Next.js application and then exits, including shutting down Harper. Useful as a CI build step.

### `port`

Type: `number`

Default: Harper default port (`9926`)

Custom HTTP port for the Next.js server.

### `securePort`

Type: `number`

Default: Harper default secure port

Custom HTTPS port for the Next.js server.

### `runFirst`

Type: `boolean`

Default: `false`

When `true`, the Next.js request handler runs before any other Harper HTTP middleware. Useful for scenarios where Next.js handles authentication directly.

Note: enabling `runFirst` conflicts with Harper's REST API on the same port. Use a dedicated `port` to avoid conflicts.

## Caching

`@harperfast/nextjs` includes a Harper-backed cache handler for Next.js [Incremental Static Regeneration (ISR)](https://nextjs.org/docs/app/guides/incremental-static-regeneration), the [Data Cache](https://nextjs.org/docs/app/deep-dive/caching#data-cache), and [`unstable_cache`](https://nextjs.org/docs/app/api-reference/functions/unstable_cache).

Cached entries live in Harper instead of the worker's local filesystem, so a cache write on one cluster node is immediately visible to every other node.

> **Note:** The cache handler is currently a work in progress.

### Enabling

Use the `cacheHandlerPath()` helper to set the `cacheHandler` path. This helper resolves the path relative to your config file, which is required for Turbopack compatibility:

```js
// next.config.js (CommonJS)
const { withHarper, cacheHandlerPath } = require('@harperfast/nextjs');

module.exports = withHarper({
	cacheHandler: cacheHandlerPath(__dirname),
});
```

```js
// next.config.mjs (ESM)
import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper({
	cacheHandler: cacheHandlerPath(import.meta.dirname),
});
```

```ts
// next.config.ts (TypeScript)
import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper({
	cacheHandler: cacheHandlerPath(import.meta.dirname),
});
```

### Tag Invalidation

[`revalidateTag()`](https://nextjs.org/docs/app/api-reference/functions/revalidateTag) is supported and propagates across the cluster automatically. A typical flow:

```js
// app/products/[id]/page.js
import { unstable_cache } from 'next/cache';

const getProduct = unstable_cache(
	async (id) => {
		const res = await fetch(`https://api.example.com/products/${id}`);
		return res.json();
	},
	['product'],
	{ tags: ['products'], revalidate: 3600 }
);

export default async function ProductPage({ params }) {
	const product = await getProduct(params.id);
	return <h1>{product.name}</h1>;
}
```

```js
// app/api/revalidate/route.js
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export async function POST(request) {
	const tag = new URL(request.url).searchParams.get('tag');
	revalidateTag(tag);
	return NextResponse.json({ revalidated: true });
}
```

`fetch()` calls with `next: { tags: [...] }` and the `'use cache'` directive (with `cacheTag()`) are also supported - anywhere Next.js attaches tags to a cached value, the handler picks them up.

### How Invalidation Works

The cache handler uses a soft-invalidation model:

1. `revalidateTag(tag)` writes a `{ tag, timestamp }` row to the `nextjs_cache_invalidation` table and updates an in-memory map in the calling worker.
2. Every other Harper worker subscribes to that table and updates its own map when the row is replicated - typically within milliseconds.
3. On the next `cache.get()`, if any of the cached entry's tags has an invalidation timestamp newer than the entry's `lastModified`, the handler returns `null` and Next.js regenerates the entry.

The `nextjs_cache_invalidation` rows expire after 7 days so abandoned tags do not accumulate indefinitely.

### Cache Tables

Enabling the cache handler adds two tables to the `harperfast_nextjs` database:

| Table                       | Purpose                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `nextjs_isr_cache`          | One row per cached entry. Stores `data` (the Next.js `IncrementalCacheValue`), `tags`, and `lastModified`.               |
| `nextjs_cache_invalidation` | One row per invalidated tag. `id` is the tag; `timestamp` is when `revalidateTag` was called. Auto-expires after 7 days. |

## See Also

- [Components Overview](./overview.md)
- [Plugin API](./plugin-api.md)
- [Next.js Example App](https://github.com/HarperFast/nextjs-example)
