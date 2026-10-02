import { strict as assert } from "assert";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { after, before, describe, it } from "node:test";

import {
  getDownloadDir,
  sanitizeFilename,
  saveDownloadedFile
} from "../src/services/downloads.js";

describe("getDownloadDir", () => {
  it("is undefined when not configured", () => {
    assert.equal(getDownloadDir({}), undefined);
    assert.equal(getDownloadDir({ FORTNOX_DOWNLOAD_DIR: "   " }), undefined);
  });

  it("resolves a configured path and expands ~", () => {
    assert.equal(getDownloadDir({ FORTNOX_DOWNLOAD_DIR: "/tmp/x" }), resolve("/tmp/x"));
    assert.equal(getDownloadDir({ FORTNOX_DOWNLOAD_DIR: "~/dl" }), join(homedir(), "dl"));
  });

  it("is ignored in remote mode", () => {
    assert.equal(
      getDownloadDir({ AUTH_MODE: "remote", FORTNOX_DOWNLOAD_DIR: "/tmp/x" }),
      undefined
    );
  });
});

describe("sanitizeFilename", () => {
  it("keeps ordinary names, including spaces and non-ASCII", () => {
    assert.equal(sanitizeFilename("Ride invoice from Bolt.pdf", "f"), "Ride invoice from Bolt.pdf");
    assert.equal(sanitizeFilename("Kvitto åäö.pdf", "f"), "Kvitto åäö.pdf");
  });

  it("strips directory components (path traversal)", () => {
    assert.equal(sanitizeFilename("../../etc/passwd", "f"), "passwd");
    assert.equal(sanitizeFilename("..\\..\\win\\x.pdf", "f"), "x.pdf");
    assert.equal(sanitizeFilename("/abs/path/x.pdf", "f"), "x.pdf");
  });

  it("never returns empty, '.' or '..'", () => {
    assert.equal(sanitizeFilename("..", "file-123"), "file-123");
    assert.equal(sanitizeFilename(".", "file-123"), "file-123");
    assert.equal(sanitizeFilename("", "file-123"), "file-123");
    assert.equal(sanitizeFilename(undefined, "file-123"), "file-123");
    assert.equal(sanitizeFilename("///", "file-123"), "file-123");
  });

  it("replaces control and reserved characters and leading dots", () => {
    assert.equal(sanitizeFilename("a\u0000b:c*d?.pdf", "f"), "a_b_c_d_.pdf");
    assert.equal(sanitizeFilename(".hidden.pdf", "f"), "hidden.pdf");
  });

  it("shortens long names but keeps the extension", () => {
    const result = sanitizeFilename("a".repeat(500) + ".pdf", "f");
    assert.ok(result.length <= 200);
    assert.ok(result.endsWith(".pdf"));
  });

  it("sanitizes the fallback too", () => {
    assert.equal(sanitizeFilename("", "../x y"), "_x_y");
  });
});

describe("saveDownloadedFile", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "fortnox-mcp-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes binary content byte-for-byte", async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const saved = await saveDownloadedFile(join(dir, "nested", "sub"), "all-bytes.bin", data);

    assert.equal(saved.status, "saved");
    assert.equal(saved.filename, "all-bytes.bin");
    assert.deepEqual(await readFile(saved.path), data);
  });

  it("reuses an identical existing file instead of duplicating it", async () => {
    const data = Buffer.from("same content");
    const first = await saveDownloadedFile(dir, "same.pdf", data);
    const second = await saveDownloadedFile(dir, "same.pdf", data);

    assert.equal(first.status, "saved");
    assert.equal(second.status, "already_exists");
    assert.equal(second.path, first.path);
  });

  it("never overwrites a different existing file", async () => {
    const original = Buffer.from("original");
    const other = Buffer.from("different");
    const first = await saveDownloadedFile(dir, "clash.pdf", original);
    const second = await saveDownloadedFile(dir, "clash.pdf", other);

    assert.equal(second.status, "saved_renamed");
    assert.equal(second.filename, "clash (1).pdf");
    assert.deepEqual(await readFile(first.path), original);
    assert.deepEqual(await readFile(second.path), other);
  });

  it("does not write through a pre-existing symlink", async () => {
    const decoy = join(dir, "decoy.txt");
    await writeFile(decoy, "decoy");
    await symlink(decoy, join(dir, "link.pdf"));

    const saved = await saveDownloadedFile(dir, "link.pdf", Buffer.from("new"));

    assert.equal(saved.filename, "link (1).pdf");
    assert.equal(await readFile(decoy, "utf-8"), "decoy");
  });

  it("refuses names that escape the directory", async () => {
    await assert.rejects(
      () => saveDownloadedFile(dir, "../escape.txt", Buffer.from("x")),
      /outside the download directory/
    );
    assert.ok(!(await readdir(resolve(dir, ".."))).includes("escape.txt"));
  });
});
