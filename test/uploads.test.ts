import { strict as assert } from "assert";
import { createHash } from "crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { after, before, describe, it } from "node:test";

import { getUploadRoot, readUploadFile } from "../src/services/uploads.js";

const MAX = 1024;

describe("getUploadRoot", () => {
  it("is undefined when not configured", () => {
    assert.equal(getUploadRoot({}), undefined);
    assert.equal(getUploadRoot({ FORTNOX_UPLOAD_ROOT: "  " }), undefined);
  });

  it("resolves a configured path and expands ~", () => {
    assert.equal(getUploadRoot({ FORTNOX_UPLOAD_ROOT: "/tmp/x" }), resolve("/tmp/x"));
    assert.equal(getUploadRoot({ FORTNOX_UPLOAD_ROOT: "~/up" }), join(homedir(), "up"));
  });

  it("is ignored in remote mode", () => {
    assert.equal(getUploadRoot({ AUTH_MODE: "remote", FORTNOX_UPLOAD_ROOT: "/tmp/x" }), undefined);
  });
});

describe("readUploadFile", () => {
  let base: string;
  let root: string;
  let outside: string;

  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "fortnox-mcp-upload-")));
    root = join(base, "UTLÄGG");
    outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "sub", "kvitto.pdf"), "%PDF-1.4 receipt");
    await writeFile(join(root, "empty.pdf"), "");
    await writeFile(join(root, "big.pdf"), Buffer.alloc(MAX + 1));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "link-out.txt"));
    await symlink(outside, join(root, "dir-out"));
    await symlink(join(root, "sub", "kvitto.pdf"), join(root, "link-in.pdf"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reads a file inside the root and returns basename and sha256", async () => {
    const file = await readUploadFile(root, join(root, "sub", "kvitto.pdf"), MAX);
    assert.equal(file.filename, "kvitto.pdf");
    assert.equal(file.data.toString(), "%PDF-1.4 receipt");
    assert.equal(file.sha256, createHash("sha256").update("%PDF-1.4 receipt").digest("hex"));
  });

  it("accepts paths relative to the root", async () => {
    const file = await readUploadFile(root, "sub/kvitto.pdf", MAX);
    assert.equal(file.filename, "kvitto.pdf");
  });

  it("follows symlinks that stay inside the root", async () => {
    const file = await readUploadFile(root, "link-in.pdf", MAX);
    assert.equal(file.filename, "link-in.pdf");
    assert.equal(file.path, join(root, "sub", "kvitto.pdf"));
  });

  it("rejects paths outside the root", async () => {
    await assert.rejects(readUploadFile(root, join(outside, "secret.txt"), MAX), /outside the allowed upload root/);
    await assert.rejects(readUploadFile(root, "../outside/secret.txt", MAX), /outside the allowed upload root/);
    await assert.rejects(readUploadFile(root, "/etc/passwd", MAX), /outside the allowed upload root/);
    await assert.rejects(readUploadFile(root, root, MAX), /outside the allowed upload root/);
  });

  it("does not reveal whether files outside the root exist", async () => {
    await assert.rejects(readUploadFile(root, join(outside, "nope.txt"), MAX), /outside the allowed upload root/);
  });

  it("rejects symlinks pointing out of the root", async () => {
    await assert.rejects(readUploadFile(root, "link-out.txt", MAX), /resolves outside/);
    await assert.rejects(readUploadFile(root, "dir-out/secret.txt", MAX), /resolves outside/);
  });

  it("works when the root itself is reached through a symlink", async () => {
    const linkedRoot = join(base, "root-link");
    await symlink(root, linkedRoot);
    const file = await readUploadFile(linkedRoot, "sub/kvitto.pdf", MAX);
    assert.equal(file.filename, "kvitto.pdf");
    await assert.rejects(readUploadFile(linkedRoot, "link-out.txt", MAX), /resolves outside/);
  });

  it("reports missing files", async () => {
    await assert.rejects(readUploadFile(root, "sub/missing.pdf", MAX), /File not found/);
  });

  it("rejects directories, empty files and files over the limit", async () => {
    await assert.rejects(readUploadFile(root, "sub", MAX), /Not a regular file/);
    await assert.rejects(readUploadFile(root, "empty.pdf", MAX), /File is empty/);
    await assert.rejects(readUploadFile(root, "big.pdf", MAX), /too large/);
  });

  it("reports a missing upload root", async () => {
    await assert.rejects(readUploadFile(join(base, "no-such-root"), "x.pdf", MAX), /Upload root does not exist/);
  });
});
