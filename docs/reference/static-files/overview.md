---
id: overview
title: Static Files
---

<!-- Source: versioned_docs/version-4.7/reference/components/built-in-extensions.md (primary - static section) -->
<!-- Source: versioned_docs/version-4.6/reference/components/built-in-extensions.md (for pre-v4.7 behavior comparison) -->
<!-- Source: versioned_docs/version-4.5/developers/components/built-in.md (for early v4 behavior) -->
<!-- Source: release_notes/v4-tucker/4.7.2.md (index.html default change) -->
<!-- Source: release_notes/v4-tucker/4.7.3.md (trailing slash fix) -->

# Static Files

- Added in: v4.5.0
- Changed in: v4.7.0 - (Migrated to Plugin API and new options added)
- Changed in: v5.2.0 - (`before` / `after` handler ordering options)

The `static` built-in plugin serves static files from your Harper application over HTTP. Use it to host websites, SPAs, downloadable assets, or any static content alongside your Harper data and API endpoints.

`static` does **not** need to be installed — it is built into Harper and only needs to be declared in your `config.yaml`.

## Basic Usage

Configure `static` with the `files` option pointing to the files you want to serve:

```yaml
static:
  files: 'site/**'
```

Given a component with this structure:

```
my-app/
├─ site/
│  ├─ index.html
│  ├─ about.html
│  ├─ blog/
│     ├─ post-1.html
│     ├─ post-2.html
├─ config.yaml
```

Files are accessed relative to the matched directory root, so `GET /index.html` returns `site/index.html` and `GET /blog/post-1.html` returns `site/blog/post-1.html`.

## `files` and `urlPath` Options

<VersionBadge version="v4.5" />

`static` is a [Plugin](../components/overview.md) and supports the standard `files` and `urlPath` configuration options for controlling which files to serve and at what URL path.

Use `urlPath` to mount the files at a specific URL prefix:

```yaml
static:
  files: 'site/**'
  urlPath: 'app'
```

Now `GET /app/index.html` returns `site/index.html` and `GET /app/blog/post-1.html` returns `site/blog/post-1.html`.

See [Components Overview](../components/overview.md) for full `files` glob pattern and `urlPath` documentation.

## Additional Options

<VersionBadge version="v4.7" />

In addition to the standard `files`, `urlPath`, and `timeout` options, `static` supports these configuration options:

- **`index`** - `boolean` - _optional_ - If `true`, automatically serves `index.html` when a request targets a directory. Defaults to `false`.

- **`extensions`** - `string[]` - _optional_ - File extensions to try when an exact path match is not found. For example, `extensions: ['html']` means a request for `/page-1` will also try `/page-1.html`.

- **`fallthrough`** - `boolean` - _optional_ - If `true`, passes the request to the next handler when the requested file is not found. Set to `false` when using `notFound` to customize 404 responses. Defaults to `true`.

- **`notFound`** - `string | { file: string; statusCode: number }` - _optional_ - A custom file (or file + status code) to return when a path is not found. Useful for serving a custom 404 page or for SPAs that use client-side routing. See [Handler Ordering](#handler-ordering) — combine with `after: 'rest'` if your application also serves an API.

- **`before`** - `string | false` - _optional_ - <VersionBadge version="v5.2.0" /> Run this handler before the named handler in the HTTP middleware chain. Defaults to `'authentication'` so plain file requests skip credential parsing. Set to `false` to clear the default without adding a new constraint (registration order applies).

- **`after`** - `string` - _optional_ - <VersionBadge version="v5.2.0" /> Run this handler after the named handler, e.g. `after: 'rest'` to let REST resources match before static fallbacks. Setting `after` overrides the default `before: 'authentication'`.

## Handler Ordering

<VersionBadge version="v5.2.0" />

By default, `static` handles GET requests **before** authentication — and therefore before the [REST](../rest/overview.md) handler, which runs after authentication. This keeps plain file requests fast, and with the default `fallthrough: true` it is invisible: requests that do not match a file simply pass to the next handler.

It matters as soon as you set `fallthrough: false`: the static handler then responds to every unmatched GET itself — including GETs for your exported REST resources, which never get a chance to run. Harper logs a startup warning when it detects this combination.

If your application serves both static files and an API, order the static handler after REST:

```yaml
rest: true

static:
  files: 'dist/**'
  # Let the REST handler match first; only unmatched URLs get the fallback.
  after: 'rest'
  notFound:
    file: 'dist/index.html'
    statusCode: 200
  fallthrough: false
```

```
GET /Dog/1          -> 200 application/json   (REST resource)
GET /assets/app.js  -> 200 text/javascript    (static file)
GET /app/settings   -> 200 text/html          (index.html - client-side route)
```

Note the tradeoff: `after: 'rest'` runs the static handler after authentication, so every static-asset request now incurs the credential parsing that the default ordering skips. This is worth it when you serve an API alongside your files, but for an app serving a high volume of assets, choose it deliberately rather than as a free fix.

> **Note:** Handler names are case-sensitive and must match the registered config key — use `rest`, not the legacy `REST` alias. Watch for typos: setting `after` (or `before`) to any value suppresses the default `before: 'authentication'` hoist, so if the name matches no registered handler the constraint is ignored (Harper logs a warning) and the handler falls back to registration order — **not** its default pre-authentication position. In other words, `after: 'REST'` behaves like neither the working `after: 'rest'` nor the default.

Ordering is applied when the component loads; changing `before` or `after` in `config.yaml` automatically restarts the component so the new ordering takes effect.

### Cache Headers

<VersionBadge version="v5.2.0" />

Static files are served before authentication runs, so they are public by construction. Use the following options to control the `Cache-Control` header Harper emits for served files:

- **`maxAge`** - `number` (seconds) or `string` (duration) - _optional_ - Freshness lifetime for served files. A number is treated as seconds; a string like `'5m'` or `'1d'` is parsed as a duration. Emits `Cache-Control: public, max-age=<seconds>`. Defaults to `0` (revalidate on every request via ETag/Last-Modified). Malformed values throw at startup rather than silently degrading. Duration suffixes are `y` (year), `M` (30-day month), `d` (day), `h` (hour), and `m` (minute) — note the case-sensitive distinction between `M` (month) and `m` (minute).

- **`immutable`** - `boolean` - _optional_ - When `true`, appends the `immutable` directive to the `Cache-Control` header. Use this for content-hashed assets whose URL changes when the content changes, so browsers and CDNs never revalidate them. Defaults to `false`.

- **`cacheControl`** - `string | false` - _optional_ - Full `Cache-Control` override string. Takes precedence over `maxAge` and `immutable` when set. Set to `false` to suppress the `Cache-Control` header entirely.

- **`cacheOverrides`** - `object` - _optional_ - A map of glob pattern → per-file cache options (any of `maxAge`, `immutable`, `cacheControl`), letting specific files opt out of the top-level defaults. The typical case is long-lived `immutable` defaults for content-hashed assets while `index.html` gets a short window or `stale-while-revalidate`. Patterns use the same [`micromatch`](https://github.com/micromatch/micromatch) engine as `files`, and are matched against both the request URL path (relative to the mount) and the served file's basename — so `index.html` also targets the directory-index (`/`) response. Entries are tested in config order and the **first match wins**; each entry is a partial — options it sets replace the top-level default, options it omits are inherited, with the same `cacheControl`-over-`maxAge`/`immutable` precedence.

The `notFound` fallback always uses `max-age=0` regardless of `maxAge`, which is correct for SPA index fallbacks — a `200 index.html` response should revalidate so updated builds are picked up promptly.

Example: serve a build directory with long-lived immutable caching for hashed assets, while the entry `index.html` revalidates every request (optionally serving stale content while it does):

```yaml
static:
  files: 'web/**'
  maxAge: '1y'
  immutable: true
  cacheOverrides:
    # First match wins; index.html is matched by basename on the `/` serve.
    'index.html':
      cacheControl: 'public, max-age=0, stale-while-revalidate=60'
    '*.html':
      maxAge: '5m'
      immutable: false
```

> `stale-while-revalidate` support varies by CDN — CloudFront and Cloudflare honor it, Azure CDN does not. Where it is unsupported the directive is simply ignored (the resource is treated as `max-age=0`), so it is safe to set.

## Auto-Updates

<VersionBadge version="v4.7.0" />

Because `static` uses the Plugin API, it automatically responds to changes without requiring a Harper restart. Adding, removing, or modifying files — or updating `config.yaml` — takes effect immediately. The one exception is [handler ordering](#handler-ordering): changing `before` or `after` automatically restarts the component to rebuild the middleware chain, rather than taking effect in place.

## Examples

### Basic static file serving

Serve all files in the `static/` directory. Requests must match file names exactly.

```yaml
static:
  files: 'static/**'
```

### Automatic `index.html` serving

Serve `index.html` automatically when a request targets a directory:

```yaml
static:
  files: 'static/**'
  index: true
```

With this structure:

```
my-app/
├─ static/
│  ├─ index.html
│  ├─ blog/
│     ├─ index.html
│     ├─ post-1.html
```

Request mappings:

```
GET /            -> static/index.html
GET /blog        -> static/blog/index.html
GET /blog/post-1.html -> static/blog/post-1.html
```

### Automatic extension matching

Combine `index` and `extensions` for clean URLs without file extensions:

```yaml
static:
  files: 'static/**'
  index: true
  extensions: ['html']
```

Request mappings with the same structure:

```
GET /            -> static/index.html
GET /blog        -> static/blog/index.html
GET /blog/post-1 -> static/blog/post-1.html
```

### Custom 404 page

Return a specific file when a requested path is not found:

```yaml
static:
  files: 'static/**'
  notFound: 'static/404.html'
  fallthrough: false
```

A request to `/non-existent` returns the contents of `static/404.html` with a `404` status code.

> **Note:** When using `notFound`, set `fallthrough: false` so the request does not pass through to another handler before the custom 404 response is returned. If the application also serves an API, add `after: 'rest'` — see [Handler Ordering](#handler-ordering).

### SPA client-side routing

For SPAs that handle routing in the browser with the History API, return the main application file for any path that does not match an API route or a static file:

```yaml
rest: true

static:
  files: 'static/**'
  after: 'rest'
  fallthrough: false
  notFound:
    file: 'static/index.html'
    statusCode: 200
```

A request to any unmatched path returns `static/index.html` with a `200` status code, allowing the client-side router to handle navigation. The `after: 'rest'` ordering (added in v5.2.0) allows REST resources to be matched first; without it, the fallback would intercept API GETs too — see [Handler Ordering](#handler-ordering).

Alternatively, SPAs that use hash-based routing (e.g. React Router's `createHashRouter` or Vue Router's `createWebHashHistory`) need no fallback at all: every page loads from `/`, which also keeps `index.html` cacheable at a single URL. This works on every Harper version.

## Dynamic Applications

The `static` plugin handles pure static file hosting. If you need server-side rendering, API routes, or other dynamic behavior, consider using a plugin designed for that purpose:

- [`@harperfast/nextjs`](../components/nextjs.md) - Run a full Next.js application (SSR, ISR, API routes) directly on Harper

## Related

- [Components Overview](../components/overview.md)
