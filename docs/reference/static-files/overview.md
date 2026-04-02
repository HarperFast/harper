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

- **`notFound`** - `string | { file: string; statusCode: number }` - _optional_ - A custom file (or file + status code) to return when a path is not found. Useful for serving a custom 404 page or for SPAs that use client-side routing.

## Auto-Updates

<VersionBadge version="v4.7.0" />

Because `static` uses the Plugin API, it automatically responds to changes without requiring a Harper restart. Adding, removing, or modifying files — or updating `config.yaml` — takes effect immediately.

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

> **Note:** When using `notFound`, set `fallthrough: false` so the request does not pass through to another handler before the custom 404 response is returned.

### SPA client-side routing

For SPAs that handle routing in the browser, return the main application file for any unmatched path:

```yaml
static:
  files: 'static/**'
  fallthrough: false
  notFound:
    file: 'static/index.html'
    statusCode: 200
```

A request to any unmatched path returns `static/index.html` with a `200` status code, allowing the client-side router to handle navigation.

## Related

- [Components Overview](../components/overview.md)
