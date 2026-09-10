import { describe, expect, test } from "vitest";
import type { HttpRequest } from "@yaakapp/api";
import { convertOpenApi } from "./openapi";
import { computeSyncDiff, endpointKeyForRequest, mergeUrlParameters, type SyncManifest } from "./sync";

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return {
    id: "rq-1",
    workspaceId: "ws-1",
    folderId: null,
    name: "Existing request",
    method: "GET",
    url: "${[baseUrl]}/api/v1/widgets/:id",
    urlParameters: [{ enabled: true, name: ":id", value: "keep-me" }],
    headers: [],
    ...overrides,
  } as HttpRequest;
}

describe("OpenAPI conversion", () => {
  test("uses an operation summary as the imported request name", () => {
    const converted = convertOpenApi(`
openapi: 3.0.3
info:
  title: Example
  version: 1.0.0
paths:
  /widgets:
    get:
      operationId: listWidgets
      summary: List all widgets
      responses:
        "200":
          description: OK
`);
    expect(converted.requests[0]?.name).toBe("List all widgets");
  });

  test("converts all operations in a multi-operation document", () => {
    const converted = convertOpenApi(`
openapi: 3.0.3
info:
  title: Example
  version: 1.0.0
servers:
  - url: https://example.test
paths:
  /widgets:
    get:
      summary: List widgets
      responses:
        "200":
          description: OK
    post:
      summary: Create widget
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        "201":
          description: Created
`);
    expect(converted.requests).toHaveLength(2);
    expect(new Set(converted.requests.map((item) => item.key)).size).toBe(2);
    expect(converted.requests.map((item) => item.name)).toEqual(["List widgets", "Create widget"]);
  });
});

describe("sync diff", () => {
  test("normalizes environment URLs into endpoint keys", () => {
    expect(endpointKeyForRequest(request({ method: "GET", url: "${[baseUrl]}/api/v1/widgets/:id?unused=true" }))).toBe("GET /api/v1/widgets/:id");
    expect(endpointKeyForRequest(request({ method: "POST", url: "https://example.com/api/v1/widgets" }))).toBe("POST /api/v1/widgets");
  });

  test("does not propose untracked existing requests for deletion", () => {
    const existing = [request({ id: "rq-managed", url: "${[baseUrl]}/managed" }), request({ id: "rq-manual", url: "${[baseUrl]}/manual" })];
    const manifest: SyncManifest = { version: 1, sourcePath: "example-spec", sourceHash: "old", managedRequests: { "GET /managed": "rq-managed" } };
    const diff = computeSyncDiff(existing, [], manifest);
    expect(diff.deletions).toEqual([{ key: "GET /managed", id: "rq-managed", name: "Existing request" }]);
  });

  test("adopts an unambiguous existing request and proposes only missing parameters", () => {
    const existing = request({ id: "rq-1", url: "${[baseUrl]}/api/v1/widgets/:id", urlParameters: [{ enabled: true, name: ":id", value: "preserve-this" }] });
    const imported = [{
      key: "GET /api/v1/widgets/:id",
      method: "GET",
      path: "/api/v1/widgets/:id",
      name: "getWidget",
      folderPath: "Widgets",
      parameters: [
        { key: "path:id", name: "id", location: "path" as const, required: true, value: "<uuid>" },
        { key: "query:expand", name: "expand", location: "query" as const, required: false, value: "<string>" },
      ],
      request: { method: "GET", url: "${[baseUrl]}/api/v1/widgets/:id", urlParameters: [], headers: [] },
    }];
    const diff = computeSyncDiff([existing], imported, undefined);
    expect(diff.adopted).toEqual([{ key: "GET /api/v1/widgets/:id", id: "rq-1" }]);
    expect(diff.parameterAdditions.map((item) => item.key)).toEqual(["query:expand"]);
    expect(diff.parameterDeletions).toHaveLength(0);
    const merged = mergeUrlParameters(existing, diff.parameterAdditions, []);
    expect(merged).toEqual([
      { enabled: true, name: ":id", value: "preserve-this" },
      { enabled: true, name: "expand", value: "<string>" },
    ]);
  });
});
