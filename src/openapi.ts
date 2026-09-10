import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export type OpenApiObject = Record<string, unknown>;

export interface SourceParameter {
  key: string;
  name: string;
  location: "path" | "query" | "header" | "cookie";
  required: boolean;
  value: string;
}

export interface ImportedRequest {
  key: string;
  method: string;
  path: string;
  name: string;
  description?: string;
  folderPath: string | null;
  parameters: SourceParameter[];
  request: {
    method: string;
    url: string;
    urlParameters: Array<{ enabled: boolean; name: string; value: string }>;
    headers: Array<{ enabled: boolean; name: string; value: string }>;
    body?: { text: string } | { form: Array<{ enabled: boolean; name: string; value: string }> };
    bodyType?: string;
  };
}

export interface ConvertedSpec {
  title: string;
  version: string;
  requests: ImportedRequest[];
}

interface ConvertOptions {
  baseUrlVariable?: string;
}

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]);

function asObject(value: unknown): OpenApiObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OpenApiObject)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveLocalReference(root: OpenApiObject, value: unknown): OpenApiObject {
  const object = asObject(value);
  const reference = asString(object.$ref);
  if (!reference) return object;
  if (!reference.startsWith("#/")) {
    throw new Error(`External OpenAPI reference is not supported: ${reference}`);
  }

  let current: unknown = root;
  for (const part of reference.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    current = asObject(current)[key];
  }
  return asObject(current);
}

function schemaValue(root: OpenApiObject, schemaValue: unknown): OpenApiObject {
  return resolveLocalReference(root, schemaValue);
}

function scalarExample(root: OpenApiObject, parameter: OpenApiObject): string {
  const schema = schemaValue(root, parameter.schema);
  const candidate = parameter.example ?? schema.example ?? parameter.default ?? schema.default;
  if (candidate !== undefined && candidate !== null) return String(candidate);
  const enumValues = asArray(parameter.enum ?? schema.enum);
  if (enumValues.length > 0) return String(enumValues[0]);

  const type = asString(schema.type) ?? asString(parameter.type) ?? "string";
  const format = asString(schema.format) ?? asString(parameter.format);
  if (format) return `<${format}>`;
  if (type === "integer" || type === "number") return "0";
  if (type === "boolean") return "false";
  return `<${type}>`;
}

function sampleFromSchema(root: OpenApiObject, value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  const schema = schemaValue(root, value);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  const enumValues = asArray(schema.enum);
  if (enumValues.length > 0) return enumValues[0];

  const oneOf = asArray(schema.oneOf ?? schema.anyOf);
  if (oneOf.length > 0) return sampleFromSchema(root, oneOf[0], depth + 1);

  const allOf = asArray(schema.allOf);
  if (allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const item of allOf) {
      const sample = sampleFromSchema(root, item, depth + 1);
      if (sample && typeof sample === "object" && !Array.isArray(sample)) Object.assign(merged, sample);
    }
    return merged;
  }

  const type = asString(schema.type);
  if (type === "object" || schema.properties) {
    const result: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(asObject(schema.properties))) {
      result[name] = sampleFromSchema(root, property, depth + 1);
    }
    return result;
  }
  if (type === "array") return [sampleFromSchema(root, schema.items, depth + 1)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  const format = asString(schema.format);
  return format ? `<${format}>` : "<string>";
}

function chooseMediaType(content: OpenApiObject): [string, OpenApiObject] | undefined {
  const entries = Object.entries(content);
  if (entries.length === 0) return undefined;
  const preferred = entries.find(([mediaType]) => mediaType === "application/json") ?? entries[0];
  return [preferred[0], asObject(preferred[1])];
}

function sanitizeFolderName(value: string): string {
  const name = value.trim().replace(/[\\/:]+/g, "-");
  return name || "OpenAPI";
}

function pathWithParameters(pathTemplate: string): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, ":$1");
}

function requestUrl(root: OpenApiObject, apiPath: string, baseUrlVariable: string | undefined): string {
  if (baseUrlVariable?.trim()) return `\${[${baseUrlVariable.trim()}]}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;

  const servers = asArray(root.servers);
  const server = servers.length > 0 ? asObject(servers[0]) : {};
  const serverUrl = asString(server.url);
  if (serverUrl) return `${serverUrl.replace(/\/$/, "")}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;

  const schemes = asArray(root.schemes).map(asString).filter((value): value is string => Boolean(value));
  const scheme = schemes[0] ?? "http";
  const host = asString(root.host);
  const basePath = asString(root.basePath) ?? "";
  if (host) return `${scheme}://${host}${basePath.replace(/\/$/, "")}${apiPath}`;
  return apiPath;
}

function operationParameters(root: OpenApiObject, pathItem: OpenApiObject, operation: OpenApiObject): OpenApiObject[] {
  const parameters = new Map<string, OpenApiObject>();
  for (const source of [...asArray(pathItem.parameters), ...asArray(operation.parameters)]) {
    const parameter = resolveLocalReference(root, source);
    const name = asString(parameter.name);
    const location = asString(parameter.in);
    if (!name || !location) continue;
    parameters.set(`${location}:${name}`, parameter);
  }
  return [...parameters.values()];
}

function requestBody(root: OpenApiObject, operation: OpenApiObject, parameters: OpenApiObject[]): { body?: ImportedRequest["request"]["body"]; bodyType?: string } {
  const requestBodyObject = resolveLocalReference(root, operation.requestBody);
  const content = asObject(requestBodyObject.content);
  const selected = chooseMediaType(content);
  let mediaType: string | undefined;
  let schema: unknown;
  let example: unknown;

  if (selected) {
    mediaType = selected[0];
    schema = selected[1].schema;
    example = selected[1].example;
  } else {
    const bodyParameter = parameters.find((parameter) => parameter.in === "body");
    if (bodyParameter) {
      mediaType = asString(bodyParameter.consumes) ?? "application/json";
      schema = bodyParameter.schema;
      example = bodyParameter["x-example"] ?? bodyParameter.example;
    }
  }

  if (!mediaType && !schema && example === undefined) return {};
  const sample = example ?? sampleFromSchema(root, schema);
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    const values = sample && typeof sample === "object" && !Array.isArray(sample) ? sample : {};
    return {
      body: {
        form: Object.entries(values).map(([name, value]) => ({
          enabled: true,
          name,
          value: typeof value === "string" ? value : JSON.stringify(value),
        })),
      },
      bodyType: mediaType,
    };
  }
  return {
    body: { text: typeof sample === "string" ? sample : JSON.stringify(sample ?? {}, null, 2) },
    bodyType: mediaType ?? "application/json",
  };
}

function responseMediaType(root: OpenApiObject, operation: OpenApiObject): string | undefined {
  for (const response of Object.values(asObject(operation.responses))) {
    const content = asObject(resolveLocalReference(root, response).content);
    const selected = chooseMediaType(content);
    if (selected) return selected[0];
    const produces = asArray(resolveLocalReference(root, response).produces).map(asString).filter((value): value is string => Boolean(value));
    if (produces[0]) return produces[0];
  }
  return undefined;
}

export function normalizeOpenApiPath(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] || "/";
  const normalized = withoutQuery.replace(/\/+/g, "/").replace(/\/{2,}/g, "/");
  return `${normalized.startsWith("/") ? "" : "/"}${normalized}`.replace(/\/$/, "") || "/";
}

export function convertOpenApi(text: string, sourcePath = "openapi.yaml", options: ConvertOptions = {}): ConvertedSpec {
  const root = asObject(parse(text));
  const version = asString(root.openapi) ?? asString(root.swagger);
  if (!version || (!root.paths && !root.basePath)) throw new Error(`${path.basename(sourcePath)} is not a supported OpenAPI or Swagger document`);

  const info = asObject(root.info);
  const title = asString(info.title) ?? path.basename(sourcePath);
  const requests: ImportedRequest[] = [];

  for (const [rawPath, rawPathItem] of Object.entries(asObject(root.paths))) {
    const pathItem = resolveLocalReference(root, rawPathItem);
    for (const [rawMethod, rawOperation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const operation = resolveLocalReference(root, rawOperation);
      const normalizedPath = normalizeOpenApiPath(pathWithParameters(rawPath));
      const key = `${method.toUpperCase()} ${normalizedPath}`;
      const parameters = operationParameters(root, pathItem, operation);
      const urlParameters = parameters
        .filter((parameter) => parameter.in === "path" || parameter.in === "query")
        .map((parameter) => ({
          enabled: true,
          name: parameter.in === "path" ? `:${parameter.name}` : parameter.name,
          value: scalarExample(root, parameter),
        }));
      const headers = parameters
        .filter((parameter) => parameter.in === "header")
        .map((parameter) => ({ enabled: true, name: asString(parameter.name) ?? "", value: scalarExample(root, parameter) }));
      const body = requestBody(root, operation, parameters);
      const accept = responseMediaType(root, operation);
      if (accept && !headers.some((header) => header.name.toLowerCase() === "accept")) headers.push({ enabled: true, name: "Accept", value: accept });
      if (body.bodyType && !headers.some((header) => header.name.toLowerCase() === "content-type")) headers.push({ enabled: true, name: "Content-Type", value: body.bodyType });

      const tags = asArray(operation.tags).map(asString).filter((value): value is string => Boolean(value));
      const name = asString(operation.summary) ?? asString(operation.operationId) ?? `${method.toUpperCase()} ${normalizedPath}`;
      requests.push({
        key,
        method: method.toUpperCase(),
        path: normalizedPath,
        name,
        description: asString(operation.description) ?? asString(operation.summary),
        folderPath: tags[0] ? sanitizeFolderName(tags[0]) : "OpenAPI",
        parameters: parameters
          .filter((parameter) => ["path", "query", "header", "cookie"].includes(String(parameter.in)))
          .map((parameter) => ({
            key: `${parameter.in}:${parameter.name}`,
            name: asString(parameter.name) ?? "",
            location: parameter.in as SourceParameter["location"],
            required: Boolean(parameter.required),
            value: scalarExample(root, parameter),
          })),
        request: {
          method: method.toUpperCase(),
          url: requestUrl(root, normalizedPath, options.baseUrlVariable),
          urlParameters: urlParameters.map((parameter) => ({ ...parameter, name: String(parameter.name) })),
          headers,
          ...body,
        },
      });
    }
  }

  return { title, version, requests };
}

export async function convertOpenApiFile(filePath: string, options: ConvertOptions = {}): Promise<ConvertedSpec> {
  return convertOpenApi(await readFile(filePath, "utf8"), filePath, options);
}
