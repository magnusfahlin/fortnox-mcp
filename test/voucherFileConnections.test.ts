import { strict as assert } from "assert";
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { after, before, beforeEach, describe, it } from "node:test";

import { initializeTokenProvider } from "../src/auth/index.js";
import { registerInboxTools } from "../src/tools/inbox.js";

type Handler = (params: Record<string, unknown>) => Promise<any>;

// Capture tool handlers without starting a real MCP server
const handlers = new Map<string, Handler>();
registerInboxTools({
  registerTool: (name: string, _config: unknown, handler: Handler) => {
    handlers.set(name, handler);
  }
} as any);
const listConnections = handlers.get("fortnox_list_voucher_file_connections")!;

// Stub HTTP: every request is answered by `respond`, nothing reaches Fortnox
let requests: InternalAxiosRequestConfig[] = [];
let respond: (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
const originalAdapter = axios.defaults.adapter;

const stubAdapter: AxiosAdapter = async (config) => {
  requests.push(config);
  const { status, data } = respond(config);
  const response = { status, statusText: "", headers: {}, config, data };
  if (status >= 400) {
    throw new AxiosError("Request failed", undefined, config, undefined, response);
  }
  return response;
};

const connection = {
  FileId: "abc-123",
  Name: "kvitto.pdf",
  VoucherSeries: "A",
  VoucherNumber: "42",
  VoucherYear: 3,
  VoucherDescription: "Kvitto"
};

describe("fortnox_list_voucher_file_connections", () => {
  before(() => {
    initializeTokenProvider({
      getAccessToken: async () => "test-token",
      isAuthenticated: () => true,
      getTokenInfo: () => null
    });
    axios.defaults.adapter = stubAdapter;
  });

  after(() => {
    axios.defaults.adapter = originalAdapter;
  });

  beforeEach(() => {
    requests = [];
  });

  it("reports a connected file with its voucher", async () => {
    respond = () => ({ status: 200, data: { VoucherFileConnection: connection } });

    const result = await listConnections({ file_id: "abc-123", response_format: "json" });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "get");
    assert.match(requests[0].url!, /\/3\/voucherfileconnections\/abc-123$/);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      file_id: "abc-123",
      connected: true,
      connections: [{
        file_id: "abc-123",
        filename: "kvitto.pdf",
        voucher_series: "A",
        voucher_number: "42",
        voucher_year: 3,
        voucher_description: "Kvitto"
      }]
    });
  });

  it("reports not connected when Fortnox returns 400 with code 2000704", async () => {
    // Observed live response for an Inbox file with no voucher connection
    respond = () => ({
      status: 400,
      data: { ErrorInformation: { error: 1, message: "Filen kunde inte hittas.", code: 2000704 } }
    });

    const result = await listConnections({ file_id: "abc-123", response_format: "markdown" });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.connected, false);
    assert.deepEqual(result.structuredContent.connections, []);
    assert.match(result.content[0].text, /not connected/);
  });

  it("returns an error, not 'not connected', for other failures", async () => {
    const failures = [
      { status: 400, code: 2000588 },
      { status: 403, code: 2000704 },
      { status: 404, code: undefined },
      { status: 500, code: undefined }
    ];
    for (const { status, code } of failures) {
      respond = () => ({ status, data: { ErrorInformation: { message: "boom", code } } });

      const result = await listConnections({ file_id: "abc-123", response_format: "json" });

      assert.equal(result.isError, true, `status ${status}, code ${code}`);
      assert.equal(result.structuredContent, undefined);
    }
  });

  it("lists one page of connections when no file_id is given", async () => {
    respond = () => ({
      status: 200,
      data: {
        MetaInformation: { "@TotalResources": 1290, "@TotalPages": 645, "@CurrentPage": 2 },
        VoucherFileConnections: [connection, { ...connection, FileId: "def-456" }]
      }
    });

    const result = await listConnections({ limit: 2, page: 2, response_format: "json" });

    assert.equal(requests.length, 1);
    assert.match(requests[0].url!, /\/3\/voucherfileconnections$/);
    assert.deepEqual(requests[0].params, { limit: 2, page: 2 });
    assert.equal(result.structuredContent.total, 1290);
    assert.equal(result.structuredContent.count, 2);
    assert.equal(result.structuredContent.has_more, true);
    assert.equal(result.structuredContent.connections[1].file_id, "def-456");
  });

  it("URL-encodes the file id", async () => {
    respond = () => ({ status: 400, data: { ErrorInformation: { code: 2000704 } } });

    await listConnections({ file_id: "a/b?c", response_format: "json" });

    assert.match(requests[0].url!, /\/3\/voucherfileconnections\/a%2Fb%3Fc$/);
  });
});
