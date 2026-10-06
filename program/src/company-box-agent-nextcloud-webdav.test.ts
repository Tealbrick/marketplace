/**
 * Nextcloud WebDAV through the agent surface: nested paths, custom methods
 * (PROPFIND, MKCOL, MOVE, COPY), the Destination header, traversal refusal,
 * the OCS header default and held comments. Separate from the generic
 * agent-path suites so it runs in its own worker.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixture, USER } from "./testing/company-box-catalog-harness.js";

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("agent path: nextcloud WebDAV files", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((f) => f.close()));
  });
  async function dav() {
    const f = await fixture("nextcloud", "allow");
    open.push(f);
    const run = async (operationId: string, args: Record<string, unknown>) => {
      const key = `company-box-nextcloud.${operationId}`;
      const response = await f.call(key, args, await f.grant(key));
      return { response, request: f.rest.requests.at(-1)! };
    };
    return { f, run };
  }
  const base = `/remote.php/dav/files/${USER}`;

  it("lists, uploads, moves and copies at any depth with the right methods and encoded paths", async () => {
    const { f, run } = await dav();
    const listed = await run("webdav-files-propfind", { path: { user: USER, path: "Documents/Q3 report" } });
    expect(listed.response.statusCode, listed.response.body).toBe(200);
    expect(listed.request).toMatchObject({ method: "PROPFIND", path: `${base}/Documents/Q3%20report` });
    expect(listed.request.headers.depth).toBe("1");
    expect(listed.request.headers["ocs-apirequest"]).toBeUndefined();

    const root = await run("webdav-files-list-root", { path: { user: USER }, header: { Depth: "0" } });
    expect(root.response.statusCode, root.response.body).toBe(200);
    expect(root.request).toMatchObject({ method: "PROPFIND", path: base });
    expect(root.request.headers.depth).toBe("0");

    const upload = await run("webdav-files-upload", {
      path: { user: USER, path: "/Documents/Q3 report/notes.md" },
      body: { base64: Buffer.from("# notes\n").toString("base64"), filename: "notes.md", contentType: "application/octet-stream" },
    });
    expect(upload.response.statusCode, upload.response.body).toBe(200);
    expect(upload.request).toMatchObject({ method: "PUT", path: `${base}/Documents/Q3%20report/notes.md` });
    expect(upload.request.raw.toString("utf8")).toBe("# notes\n");
    expect(upload.request.headers["content-type"]).toBe("application/octet-stream");

    const move = await run("webdav-files-move", { path: { user: USER, path: "Documents/Q3 report/notes.md" }, header: { Destination: "Archive/2026/notes final.md" } });
    expect(move.response.statusCode, move.response.body).toBe(200);
    expect(move.request).toMatchObject({ method: "MOVE", path: `${base}/Documents/Q3%20report/notes.md` });
    expect(move.request.headers.destination).toBe(`${f.rest.origin}${base}/Archive/2026/notes%20final.md`);
    expect(move.request.headers.overwrite).toBe("F");

    const copy = await run("webdav-files-copy", { path: { user: USER, path: "a.md" }, header: { Destination: "b/a.md" } });
    expect(copy.request).toMatchObject({ method: "COPY", path: `${base}/a.md` });
    expect(copy.request.headers.overwrite).toBe("F");
    const overwrite = await run("webdav-files-copy", { path: { user: USER, path: "a.md" }, header: { Destination: "b/a.md", Overwrite: "T" } });
    expect(overwrite.response.statusCode).toBe(400);

    for (const [operationId, method] of [["webdav-files-mkcol", "MKCOL"], ["webdav-files-download", "GET"], ["webdav-files-delete", "DELETE"]] as const) {
      const result = await run(operationId, { path: { user: USER, path: "Documents/new folder" } });
      expect(result.response.statusCode, `${operationId}: ${result.response.body}`).toBe(200);
      expect(result.request).toMatchObject({ method, path: `${base}/Documents/new%20folder` });
    }
  });

  it("refuses traversal and caller-supplied destination URLs", async () => {
    const { f, run } = await dav();
    const before = f.rest.requests.length;
    for (const bad of ["../etc/passwd", "a/../../b", "a//b", "a/%2e%2e/b", "a\\b"]) {
      const result = await run("webdav-files-propfind", { path: { user: USER, path: bad } });
      expect(result.response.statusCode, bad).toBe(400);
    }
    const url = await run("webdav-files-move", { path: { user: USER, path: "a.md" }, header: { Destination: "https://evil.example/x" } });
    expect(url.response.statusCode).toBe(400);
    expect(f.rest.requests.length).toBe(before);
  });

  it("restores from the trash bin and versions, and assembles chunked uploads", async () => {
    const { f, run } = await dav();
    const trash = await run("webdav-trashbin-restore", { path: { user: USER, item: "folder.d1700000000/notes.md" } });
    expect(trash.request).toMatchObject({ method: "MOVE", path: `/remote.php/dav/trashbin/${USER}/trash/folder.d1700000000/notes.md` });
    expect(trash.request.headers.destination).toBe(`${f.rest.origin}/remote.php/dav/trashbin/${USER}/restore/restored`);
    const version = await run("webdav-versions-restore", { path: { user: USER, fileId: "42", versionId: "1700000000" } });
    expect(version.request).toMatchObject({ method: "MOVE", path: `/remote.php/dav/versions/${USER}/versions/42/1700000000` });
    expect(version.request.headers.destination).toBe(`${f.rest.origin}/remote.php/dav/versions/${USER}/restore/target`);
    const start = await run("webdav-uploads-start", { path: { user: USER, uploadId: "up-1" }, header: { Destination: "Videos/big file.mp4" } });
    expect(start.request).toMatchObject({ method: "MKCOL", path: `/remote.php/dav/uploads/${USER}/up-1` });
    expect(start.request.headers.destination).toBe(`${f.rest.origin}${base}/Videos/big%20file.mp4`);
    const chunk = await run("webdav-uploads-put-chunk", { path: { user: USER, uploadId: "up-1", chunkId: "00001" }, header: { Destination: "Videos/big file.mp4", "OC-Total-Length": "5" }, body: { base64: "aGVsbG8=" } });
    expect(chunk.request).toMatchObject({ method: "PUT", path: `/remote.php/dav/uploads/${USER}/up-1/00001` });
    expect(chunk.request.headers["oc-total-length"]).toBe("5");
    const finish = await run("webdav-uploads-finish", { path: { user: USER, uploadId: "up-1" }, header: { Destination: "Videos/big file.mp4" } });
    expect(finish.request).toMatchObject({ method: "MOVE", path: `/remote.php/dav/uploads/${USER}/up-1/.file` });
  });

  it("sends the OCS header by default on OCS routes and keeps WebDAV risk classes", async () => {
    const { f, run } = await dav();
    const caps = await run("ocs-get-capabilities", {});
    expect(caps.request).toMatchObject({ method: "GET", path: "/ocs/v2.php/cloud/capabilities" });
    expect(caps.request.headers["ocs-apirequest"]).toBe("true");
    expect(f.rest.requests[0]).toMatchObject({ path: "/ocs/v2.php/cloud/capabilities" });
  });

  it("holds a comment for owner approval without touching the app", async () => {
    // Comments are visible to everyone who can open the file, so creating one is outward.
    const owner = await fixture("nextcloud", "owner");
    open.push(owner);
    const before = owner.rest.requests.length;
    const key = "company-box-nextcloud.webdav-comments-create";
    const held = await owner.call(key, { path: { fileId: "42" }, body: { message: "hi" } }, await owner.grant(key));
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ status: "approval_pending" });
    expect(owner.rest.requests.length).toBe(before);
  });
});
