import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Folder, HttpRequest, PluginDefinition } from "@yaakapp/api";
import { convertOpenApiFile } from "./openapi";
import {
  computeSyncDiff,
  emptyManifest,
  formatChange,
  manifestKey,
  mergeUrlParameters,
  type SyncDiff,
  type SyncManifest,
} from "./sync";

const PATH_KEY = (workspaceId: string) => `openapi-local-sync:path:${workspaceId}`;
const BASE_VARIABLE_KEY = (workspaceId: string) => `openapi-local-sync:base-variable:${workspaceId}`;

type DynamicPromptFormArg = Record<string, unknown>;
type WorkspaceActionArgs = { workspace: { id: string } };
type OpenApiLink = { filePath: string; baseUrlVariable: string };
type RuntimeContext = {
  prompt: {
    text(args: Record<string, unknown>): Promise<string | null>;
    form(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  };
  store: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
  toast: { show(args: { color: string; message: string }): Promise<void> };
  folder: {
    list(): Promise<Folder[]>;
    create(args: { workspaceId: string; name: string; folderId: string | null }): Promise<Folder>;
  };
  httpRequest: {
    list(): Promise<HttpRequest[]>;
    create(args: { workspaceId: string } & Partial<HttpRequest>): Promise<HttpRequest>;
    update(args: { id: string } & Partial<HttpRequest>): Promise<HttpRequest>;
    delete(args: { id: string }): Promise<void>;
  };
};

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function promptForLink(ctx: RuntimeContext, workspaceId: string): Promise<OpenApiLink | null> {
  const previousPath = textValue(await ctx.store.get(PATH_KEY(workspaceId)));
  const fileForm = await ctx.prompt.form({
    id: "openapi-local-sync-file",
    title: "Sync local OpenAPI",
    inputs: [{
      type: "file",
      name: "filePath",
      label: "OpenAPI YAML or JSON file",
      title: "Choose an OpenAPI file",
      defaultPath: previousPath ?? undefined,
      filters: [{ name: "OpenAPI files", extensions: ["yaml", "yml", "json"] }],
      optional: false,
    }],
    confirmText: "Continue",
    cancelText: "Cancel",
  });
  const selectedFilePath = fileForm?.filePath;
  const filePath = typeof selectedFilePath === "string"
    ? selectedFilePath
    : Array.isArray(selectedFilePath) && typeof selectedFilePath[0] === "string"
      ? selectedFilePath[0]
      : null;
  if (!filePath) return null;

  const previousBaseVariable = textValue(await ctx.store.get(BASE_VARIABLE_KEY(workspaceId)));
  const baseUrlVariable = textValue(await ctx.prompt.text({
    id: "openapi-local-sync-base-variable",
    title: "Sync local OpenAPI",
    label: "Yaak base URL variable (leave empty to use the server URL from the spec)",
    defaultValue: previousBaseVariable ?? "baseUrl",
    placeholder: "baseUrl",
    required: false,
    confirmText: "Review changes",
  }));
  if (baseUrlVariable === null) return null;

  return { filePath: filePath.trim(), baseUrlVariable: baseUrlVariable.trim() };
}

async function storedLink(ctx: RuntimeContext, workspaceId: string): Promise<OpenApiLink | null> {
  const filePath = textValue(await ctx.store.get(PATH_KEY(workspaceId)));
  if (!filePath) return null;
  return {
    filePath,
    baseUrlVariable: textValue(await ctx.store.get(BASE_VARIABLE_KEY(workspaceId))) ?? "baseUrl",
  };
}

async function persistLink(ctx: RuntimeContext, workspaceId: string, link: OpenApiLink, sourcePath: string): Promise<OpenApiLink> {
  const persisted = { ...link, filePath: sourcePath };
  await ctx.store.set(PATH_KEY(workspaceId), persisted.filePath);
  await ctx.store.set(BASE_VARIABLE_KEY(workspaceId), persisted.baseUrlVariable);
  return persisted;
}

async function chooseAndPersistLink(ctx: RuntimeContext, workspaceId: string): Promise<{ link: OpenApiLink; sourcePath: string } | null> {
  const selected = await promptForLink(ctx, workspaceId);
  if (!selected) return null;
  const sourcePath = await realpath(absolutePath(selected.filePath));
  const link = await persistLink(ctx, workspaceId, selected, sourcePath);
  return { link, sourcePath };
}

async function sourceForWorkspace(ctx: RuntimeContext, workspaceId: string): Promise<{ link: OpenApiLink; sourcePath: string } | null> {
  const link = await storedLink(ctx, workspaceId);
  if (link) {
    try {
      return { link, sourcePath: await realpath(absolutePath(link.filePath)) };
    } catch {
      await ctx.toast.show({ color: "notice", message: "The linked OpenAPI file is no longer available. Choose a replacement." });
      return chooseAndPersistLink(ctx, workspaceId);
    }
  }
  return chooseAndPersistLink(ctx, workspaceId);
}

function absolutePath(value: string): string {
  const expanded = value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(expanded);
}

function reviewInputs(diff: SyncDiff): DynamicPromptFormArg[] {
  const inputs: DynamicPromptFormArg[] = [
    {
      type: "markdown",
      name: "summary",
      content: `Review the local OpenAPI sync. Existing requests not previously managed by this plugin are preserved.\n\n- ${diff.additions.length} new requests\n- ${diff.parameterAdditions.length} parameter additions\n- ${diff.parameterDeletions.length} parameter removals\n- ${diff.deletions.length} managed requests eligible for deletion`,
    },
  ];

  if (diff.additions.length > 0) {
    inputs.push({ type: "accordion", label: "New requests", inputs: diff.additions.map((request) => ({ type: "checkbox", name: `add:${request.key}`, label: `${request.method} ${request.path} — ${request.name}`, defaultValue: "true" })) });
  }
  if (diff.parameterAdditions.length > 0) {
    inputs.push({ type: "accordion", label: "Parameter additions", inputs: diff.parameterAdditions.map((change) => ({ type: "checkbox", name: `param-add:${change.requestId}:${change.key}`, label: `Add ${formatChange(change)}`, defaultValue: "true" })) });
  }
  if (diff.parameterDeletions.length > 0) {
    inputs.push({ type: "accordion", label: "Parameter removals", inputs: diff.parameterDeletions.map((change) => ({ type: "checkbox", name: `param-delete:${change.requestId}:${change.key}`, label: `Remove ${formatChange(change)}`, defaultValue: "false" })) });
  }
  if (diff.deletions.length > 0) {
    inputs.push({ type: "accordion", label: "Managed requests no longer in the spec", inputs: diff.deletions.map((change) => ({ type: "checkbox", name: `delete:${change.id}`, label: `Delete ${change.name} (${change.key})`, defaultValue: "false" })) });
  }
  return inputs;
}

function checked(values: Record<string, unknown> | null, name: string): boolean {
  return values?.[name] === true || values?.[name] === "true";
}

async function reviewDiff(ctx: RuntimeContext, diff: SyncDiff): Promise<Record<string, unknown> | null> {
  const values = await ctx.prompt.form({
    id: "openapi-local-sync-review",
    title: "Review local OpenAPI sync",
    size: "lg",
    inputs: reviewInputs(diff),
    confirmText: "Apply selected changes",
    cancelText: "Cancel",
  });
  return values as Record<string, unknown> | null;
}

async function ensureFolder(ctx: RuntimeContext, workspaceId: string, folderPath: string | null, folders: Folder[]): Promise<string | null> {
  if (!folderPath) return null;
  const existing = folders.find((folder) => folder.name === folderPath && folder.folderId === null);
  if (existing) return existing.id;
  const created = await ctx.folder.create({ workspaceId, name: folderPath, folderId: null });
  folders.push(created);
  return created.id;
}

function selectedAdditions(diff: SyncDiff, values: Record<string, unknown>): SyncDiff["additions"] {
  return diff.additions.filter((request) => checked(values, `add:${request.key}`));
}

async function applySync(
  ctx: RuntimeContext,
  workspaceId: string,
  sourcePath: string,
  sourceHash: string,
  existingRequests: HttpRequest[],
  folders: Folder[],
  previousManifest: SyncManifest | undefined,
  diff: SyncDiff,
  values: Record<string, unknown>,
): Promise<{ created: number; updated: number; deleted: number }> {
  const manifest = previousManifest ?? emptyManifest(sourcePath, sourceHash);
  const managedRequests = { ...manifest.managedRequests };
  const persistManifest = async () => ctx.store.set(manifestKey(workspaceId, sourcePath), {
    version: 1 as const,
    sourcePath,
    sourceHash,
    managedRequests: { ...managedRequests },
  });
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const match of diff.adopted) managedRequests[match.key] = match.id;

  for (const request of selectedAdditions(diff, values)) {
    const folderId = await ensureFolder(ctx, workspaceId, request.folderPath, folders);
    const createArgs: { workspaceId: string } & Partial<HttpRequest> = {
      workspaceId,
      folderId,
      name: request.name,
      description: request.description ?? "",
      method: request.request.method,
      url: request.request.url,
      urlParameters: request.request.urlParameters,
      headers: request.request.headers,
    };
    if (request.request.body !== undefined) createArgs.body = request.request.body;
    if (request.request.bodyType !== undefined) createArgs.bodyType = request.request.bodyType;
    const createdRequest = await ctx.httpRequest.create(createArgs);
    managedRequests[request.key] = createdRequest.id;
    await persistManifest();
    created += 1;
  }

  const additionsByRequest = new Map<string, typeof diff.parameterAdditions>();
  for (const change of diff.parameterAdditions) {
    if (!checked(values, `param-add:${change.requestId}:${change.key}`)) continue;
    const changes = additionsByRequest.get(change.requestId) ?? [];
    changes.push(change);
    additionsByRequest.set(change.requestId, changes);
  }
  const deletionsByRequest = new Map<string, typeof diff.parameterDeletions>();
  for (const change of diff.parameterDeletions) {
    if (!checked(values, `param-delete:${change.requestId}:${change.key}`)) continue;
    const changes = deletionsByRequest.get(change.requestId) ?? [];
    changes.push(change);
    deletionsByRequest.set(change.requestId, changes);
  }
  for (const request of existingRequests) {
    const additions = additionsByRequest.get(request.id) ?? [];
    const deletions = deletionsByRequest.get(request.id) ?? [];
    if (additions.length === 0 && deletions.length === 0) continue;
    await ctx.httpRequest.update({ id: request.id, urlParameters: mergeUrlParameters(request, additions, deletions) });
    updated += 1;
  }

  for (const change of diff.deletions) {
    if (!checked(values, `delete:${change.id}`)) continue;
    await ctx.httpRequest.delete({ id: change.id });
    delete managedRequests[change.key];
    await persistManifest();
    deleted += 1;
  }

  await persistManifest();
  return { created, updated, deleted };
}

async function runSync(ctx: RuntimeContext, workspaceId: string): Promise<void> {
  const source = await sourceForWorkspace(ctx, workspaceId);
  if (!source) return;
  const { link, sourcePath } = source;
  const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const converted = await convertOpenApiFile(sourcePath, { baseUrlVariable: link.baseUrlVariable });
  const requests = await ctx.httpRequest.list();
  const folders = await ctx.folder.list();
  const manifest = await ctx.store.get<SyncManifest>(manifestKey(workspaceId, sourcePath));
  const diff = computeSyncDiff(requests, converted.requests, manifest);
  const values = await reviewDiff(ctx, diff);
  if (!values) return;
  const result = await applySync(ctx, workspaceId, sourcePath, sourceHash, requests, folders, manifest, diff, values);
  await ctx.toast.show({ color: "success", message: `OpenAPI sync complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted.` });
}

async function configureLink(ctx: RuntimeContext, workspaceId: string): Promise<void> {
  const configured = await chooseAndPersistLink(ctx, workspaceId);
  if (!configured) return;
  await ctx.toast.show({ color: "success", message: `Linked OpenAPI file: ${configured.sourcePath}` });
}

const workspaceActions = [
  {
    label: "Sync local OpenAPI",
    icon: "refresh-cw",
    async onSelect(ctx: RuntimeContext, args: WorkspaceActionArgs) {
      try {
        await runSync(ctx, args.workspace.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.toast.show({ color: "danger", message: `Local OpenAPI sync failed: ${message}` });
      }
    },
  },
  {
    label: "Configure local OpenAPI link...",
    icon: "info",
    async onSelect(ctx: RuntimeContext, args: WorkspaceActionArgs) {
      try {
        await configureLink(ctx, args.workspace.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.toast.show({ color: "danger", message: `OpenAPI link configuration failed: ${message}` });
      }
    },
  },
];

// @yaakapp/api 0.7 predates workspace actions and workspace CRUD in its published
// declarations. The current Yaak CLI/runtime supports this shape, so keep the
// compatibility cast isolated at the plugin boundary.
export const plugin = {
  workspaceActions,
} as unknown as PluginDefinition;
