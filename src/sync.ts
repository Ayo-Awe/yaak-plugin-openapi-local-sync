import type { Folder, HttpRequest, HttpUrlParameter } from "@yaakapp/api";
import type { ImportedRequest, SourceParameter } from "./openapi";

export interface SyncManifest {
  version: 1;
  sourcePath: string;
  sourceHash: string;
  managedRequests: Record<string, string>;
}

export interface ManagedDeletion {
  key: string;
  id: string;
  name: string;
}

export interface ParameterChange {
  requestId: string;
  requestName: string;
  key: string;
  name: string;
  location: SourceParameter["location"];
  value?: string;
}

export interface SyncDiff {
  additions: ImportedRequest[];
  deletions: ManagedDeletion[];
  parameterAdditions: ParameterChange[];
  parameterDeletions: ParameterChange[];
  adopted: Array<{ key: string; id: string }>;
  duplicateKeys: string[];
}

export function normalizeUrlPath(value: string): string {
  let path = value.trim();
  path = path.replace(/\$\{\[[^\]]+\]\}/g, "");
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    // Fall through to the path normalization below for malformed URLs.
  }
  path = path.split(/[?#]/, 1)[0] || "/";
  path = path.replace(/\{([^}]+)\}/g, ":$1").replace(/\/+/g, "/");
  return `${path.startsWith("/") ? "" : "/"}${path}`.replace(/\/$/, "") || "/";
}

export function endpointKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeUrlPath(url)}`;
}

export function endpointKeyForRequest(request: Pick<HttpRequest, "method" | "url">): string {
  return endpointKey(request.method, request.url);
}

function parameterKey(parameter: Pick<HttpUrlParameter, "name">): string {
  return parameter.name.startsWith(":") ? `path:${parameter.name.slice(1)}` : `query:${parameter.name}`;
}

function sourceParameterKey(parameter: SourceParameter): string {
  return `${parameter.location}:${parameter.name}`;
}

function requestParameters(request: HttpRequest): Map<string, HttpUrlParameter> {
  return new Map((request.urlParameters ?? []).map((parameter) => [parameterKey(parameter), parameter]));
}

export function computeSyncDiff(
  requests: HttpRequest[],
  imported: ImportedRequest[],
  manifest: SyncManifest | undefined,
): SyncDiff {
  const existingByKey = new Map<string, HttpRequest[]>();
  for (const request of requests) {
    const key = endpointKeyForRequest(request);
    const list = existingByKey.get(key) ?? [];
    list.push(request);
    existingByKey.set(key, list);
  }

  const importedByKey = new Map<string, ImportedRequest>();
  for (const request of imported) {
    if (!importedByKey.has(request.key)) importedByKey.set(request.key, request);
  }

  const duplicateKeys = [...existingByKey.entries()].filter(([, value]) => value.length > 1).map(([key]) => key);
  const additions = imported.filter((request) => !existingByKey.has(request.key));
  const adopted: Array<{ key: string; id: string }> = [];
  const parameterAdditions: ParameterChange[] = [];
  const parameterDeletions: ParameterChange[] = [];

  for (const [key, source] of importedByKey) {
    const matches = existingByKey.get(key) ?? [];
    if (matches.length !== 1) continue;
    const existing = matches[0];
    adopted.push({ key, id: existing.id });

    const current = requestParameters(existing);
    const desired = new Map(source.parameters.filter((parameter) => parameter.location === "path" || parameter.location === "query").map((parameter) => [sourceParameterKey(parameter), parameter]));
    for (const [sourceKey, parameter] of desired) {
      if (!current.has(sourceKey)) {
        parameterAdditions.push({ requestId: existing.id, requestName: existing.name, key: sourceKey, name: parameter.location === "path" ? `:${parameter.name}` : parameter.name, location: parameter.location, value: parameter.value });
      }
    }
    for (const [currentKey, parameter] of current) {
      if (!desired.has(currentKey)) {
        parameterDeletions.push({ requestId: existing.id, requestName: existing.name, key: currentKey, name: parameter.name, location: parameter.name.startsWith(":") ? "path" : "query" });
      }
    }
  }

  const deletions: ManagedDeletion[] = [];
  for (const [key, id] of Object.entries(manifest?.managedRequests ?? {})) {
    if (importedByKey.has(key)) continue;
    const request = requests.find((candidate) => candidate.id === id && endpointKeyForRequest(candidate) === key);
    if (request) deletions.push({ key, id, name: request.name });
  }

  return { additions, deletions, parameterAdditions, parameterDeletions, adopted, duplicateKeys };
}

export function mergeUrlParameters(
  request: HttpRequest,
  additions: ParameterChange[],
  deletions: ParameterChange[],
): HttpUrlParameter[] {
  const deleted = new Set(deletions.map((change) => change.key));
  const result = (request.urlParameters ?? []).filter((parameter) => !deleted.has(parameterKey(parameter))).map((parameter) => ({ ...parameter }));
  const existing = new Set(result.map(parameterKey));
  for (const change of additions) {
    if (existing.has(change.key)) continue;
    result.push({ enabled: true, name: change.name, value: change.value ?? "" });
    existing.add(change.key);
  }
  return result;
}

export function emptyManifest(sourcePath: string, sourceHash: string): SyncManifest {
  return { version: 1, sourcePath, sourceHash, managedRequests: {} };
}

export function manifestKey(workspaceId: string, sourcePath: string): string {
  return `openapi-local-sync:${workspaceId}:${sourcePath}`;
}

export function formatChange(change: ParameterChange): string {
  return `${change.requestName}: ${change.location} parameter \`${change.name}\``;
}

export type FolderLike = Pick<Folder, "id" | "name" | "folderId">;
