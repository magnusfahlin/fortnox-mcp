import { strict as assert } from "assert";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { createHash } from "crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
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
const upload = handlers.get("fortnox_upload_inbox_file")!;
const connect = handlers.get("fortnox_connect_file_to_voucher")!;

// Stub HTTP: every request is answered by `respond`, nothing reaches Fortnox
let requests: InternalAxiosRequestConfig[] = [];
let respond: (config: InternalAxiosRequestConfig) => unknown;
const originalAdapter = axios.defaults.adapter;
const originalUploadRoot = process.env.FORTNOX_UPLOAD_ROOT;

const stubAdapter: AxiosAdapter = async (config) => {
  requests.push(config);
  return { status: 200, statusText: "", headers: {}, config, data: respond(config) };
};

const uploadedFile = async (config: InternalAxiosRequestConfig) => {
  const file = (config.data as FormData).get("file") as File;
  return { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
};

describe("Inbox upload and voucher connection tools", () => {
  let base: string;
  let root: string;

  before(async () => {
    initializeTokenProvider({
      getAccessToken: async () => "test-token",
      isAuthenticated: () => true,
      getTokenInfo: () => null
    });
    axios.defaults.adapter = stubAdapter;

    base = await realpath(await mkdtemp(join(tmpdir(), "fortnox-mcp-upload-tool-")));
    root = join(base, "root");
    await mkdir(root);
    await mkdir(join(base, "outside"));
    await writeFile(join(root, "Kvitto åäö.pdf"), "%PDF receipt");
    await writeFile(join(base, "outside", "secret.txt"), "secret");
    await symlink(join(base, "outside", "secret.txt"), join(root, "link-out.txt"));
  });

  after(async () => {
    axios.defaults.adapter = originalAdapter;
    if (originalUploadRoot === undefined) delete process.env.FORTNOX_UPLOAD_ROOT;
    else process.env.FORTNOX_UPLOAD_ROOT = originalUploadRoot;
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    process.env.FORTNOX_UPLOAD_ROOT = root;
    respond = () => ({ File: { Id: "file-1", Name: "Kvitto åäö.pdf", Size: 12 } });
  });

  describe("fortnox_upload_inbox_file", () => {
    it("rejects both content_base64 and file_path", async () => {
      const result = await upload({
        filename: "x.pdf",
        content_base64: Buffer.from("x").toString("base64"),
        file_path: "Kvitto åäö.pdf",
        response_format: "json"
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /exactly one of content_base64 and file_path/);
      assert.equal(requests.length, 0);
    });

    it("rejects neither content_base64 nor file_path", async () => {
      const result = await upload({ filename: "x.pdf", response_format: "json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /exactly one of content_base64 and file_path/);
      assert.equal(requests.length, 0);
    });

    it("uploads a local file using its basename and returns sha256", async () => {
      const result = await upload({ file_path: join(root, "Kvitto åäö.pdf"), response_format: "json" });

      assert.equal(result.isError, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "post");
      const sent = await uploadedFile(requests[0]);
      assert.equal(sent.name, "Kvitto åäö.pdf");
      assert.equal(sent.bytes.toString(), "%PDF receipt");
      assert.deepEqual(
        { id: result.structuredContent.file_id, name: result.structuredContent.filename, size: result.structuredContent.size_bytes },
        { id: "file-1", name: "Kvitto åäö.pdf", size: 12 }
      );
      assert.equal(
        result.structuredContent.sha256,
        createHash("sha256").update("%PDF receipt").digest("hex")
      );
    });

    it("uses filename over the basename when given", async () => {
      await upload({ file_path: "Kvitto åäö.pdf", filename: "renamed.pdf", response_format: "json" });
      assert.equal((await uploadedFile(requests[0])).name, "renamed.pdf");
    });

    it("rejects a path outside the root without uploading", async () => {
      const result = await upload({ file_path: join(base, "outside", "secret.txt"), response_format: "json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /outside the allowed upload root/);
      assert.equal(requests.length, 0);
    });

    it("rejects a symlink out of the root without uploading", async () => {
      const result = await upload({ file_path: "link-out.txt", response_format: "json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /resolves outside/);
      assert.equal(requests.length, 0);
    });

    it("reports a missing file without uploading", async () => {
      const result = await upload({ file_path: "missing.pdf", response_format: "json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /File not found/);
      assert.equal(requests.length, 0);
    });

    it("rejects file_path when FORTNOX_UPLOAD_ROOT is not set", async () => {
      delete process.env.FORTNOX_UPLOAD_ROOT;
      const result = await upload({ file_path: "Kvitto åäö.pdf", response_format: "json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /FORTNOX_UPLOAD_ROOT is not set/);
      assert.equal(requests.length, 0);
    });

    it("still uploads base64 content, requiring filename", async () => {
      const content_base64 = Buffer.from("hello").toString("base64");

      const missingName = await upload({ content_base64, response_format: "json" });
      assert.equal(missingName.isError, true);
      assert.match(missingName.content[0].text, /filename is required/);

      const result = await upload({ content_base64, filename: "hello.txt", response_format: "json" });
      assert.equal(result.isError, undefined);
      assert.equal((await uploadedFile(requests[0])).name, "hello.txt");
      assert.equal(result.structuredContent.sha256, createHash("sha256").update("hello").digest("hex"));
    });
  });

  describe("fortnox_connect_file_to_voucher", () => {
    it("does not send VoucherYear", async () => {
      respond = () => ({
        VoucherFileConnection: { FileId: "file-1", VoucherSeries: "A", VoucherNumber: "19", VoucherYear: 3 }
      });

      const result = await connect({
        file_id: "file-1",
        voucher_series: "A",
        voucher_number: 19,
        response_format: "json"
      });

      assert.equal(result.isError, undefined);
      assert.equal(requests[0].method, "post");
      assert.deepEqual(JSON.parse(requests[0].data), {
        VoucherFileConnection: { FileId: "file-1", VoucherSeries: "A", VoucherNumber: "19" }
      });
      assert.equal(result.structuredContent.voucher_year, 3);
    });
  });
});
