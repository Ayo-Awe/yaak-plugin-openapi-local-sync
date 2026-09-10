# Yaak OpenAPI Local Sync

This plugin adds a workspace action that synchronizes Yaak HTTP requests with a local OpenAPI 3.x or Swagger 2.0 file.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

The current Yaak CLI can also run the plugin during development:

```sh
yaak plugin dev
```

## Usage

1. Install or load the plugin in Yaak.
2. Open a workspace and run `Configure local OpenAPI link...` from the workspace actions.
3. Select the OpenAPI YAML or JSON file using the file picker.
4. Enter the Yaak environment variable name used for the API base URL, usually `baseUrl`.
5. Run `Sync local OpenAPI` and review the proposed additions, parameter changes, and managed deletions.

The first run never deletes existing requests. Matching existing requests are adopted only when the endpoint is unambiguous. Later runs can delete only requests previously managed by this plugin and only after explicit confirmation. Existing request values, headers, bodies, authentication, environments, and manually-created requests are preserved.

The source path and base URL variable are persisted per workspace. The sync action reuses the linked file without prompting again, and the configure action can change it. The action is intentionally manual for the first version; it does not watch the filesystem in the background.

## Current limitations

- External `$ref` files are rejected; local references such as `#/components/schemas/User` are supported.
- The importer creates useful request skeletons from schemas and examples, but does not attempt to reproduce every OpenAPI vendor extension.
- Authentication is not generated automatically. Existing authentication on adopted requests is retained.
