#!/usr/bin/env python3
"""Generate the hand-authored Nextcloud source docs (webdav, activity, serverinfo). Output dir = argv[1] (default ../sources)."""
import json, sys, os
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sources")
os.makedirs(out, exist_ok=True)
DOCS = "https://docs.nextcloud.com/server/31/developer_manual/client_apis/WebDAV"
def ext(page, anchor=""): return {"description": "Nextcloud developer manual", "url": f"{DOCS}/{page}.html{anchor}"}
S = {"type": "string"}
def hdr(name, schema=None, required=False, description=None, **extra):
    p = {"name": name, "in": "header", "required": required, "schema": schema or S}
    if description: p["description"] = description
    p.update(extra); return p
def path(name, multi=False, description=None):
    p = {"name": name, "in": "path", "required": True, "schema": S}
    if multi: p["x-multi-segment"] = True
    if description: p["description"] = description
    return p
USER = path("user", description="The Nextcloud user id whose storage is addressed; use the connector's own user.")
DEPTH = hdr("Depth", {"type": "string", "default": "1"}, description="0 = the item itself, 1 = the item and its children. infinity is normally refused by the server.")
OVERWRITE = hdr("Overwrite", {"type": "string", "default": "F"}, description="T replaces an existing target, F (default) fails if it exists.")
XML_BODY = lambda required, desc: {"required": required, "description": desc, "content": {"application/xml": {"schema": S}}}
BIN_BODY = {"required": True, "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}
BIN_RESP = {"200": {"description": "File content", "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}}
MS = {"207": {"description": "Multistatus XML", "content": {"application/xml": {"schema": S}}}}
def op(opid, summary, area, docs, **kw):
    o = {"operationId": opid, "summary": summary, "tags": [area], "externalDocs": docs}
    o.update(kw); o.setdefault("responses", {"200": {"description": "OK"}}); return o
PROPFIND_BODY = XML_BODY(False, "Optional PROPFIND request body (`<d:propfind>` with the requested properties); omit for all properties.")
paths = {}
# ---- files
files_doc = ext("basic")
paths["/remote.php/dav/files/{user}"] = {
  "parameters": [USER],
  "x-propfind": op("webdav-files-list-root", "List or stat the root folder of a user's files", "files", files_doc, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "x-report": op("webdav-files-search-report", "Search files by favorite or system tag (REPORT oc:filter-files)", "files", ext("basic", "#listing-favorites"), requestBody=XML_BODY(True, "`<oc:filter-files>` with `<oc:filter-rules>` (e.g. `<oc:favorite>1</oc:favorite>` or `<oc:systemtag>`) and the properties to return."), responses=MS,
      description="Files filtered by favorite flag or system tag. Free-text SEARCH (DASL) is not available in this connector."),
}
paths["/remote.php/dav/files/{user}/{path}"] = {
  "parameters": [USER, path("path", True, "Path below the user's root, e.g. `Documents/Q3 report/notes.md`. Segments are encoded for you.")],
  "get": op("webdav-files-download", "Download a file", "files", files_doc, responses=BIN_RESP, description="Binary responses are returned base64 and capped at 512 KB."),
  "put": op("webdav-files-upload", "Upload (create or replace) a file", "files", files_doc,
      parameters=[hdr("X-OC-MTime", {"type": "string", "pattern": "^[0-9]+$"}, description="Optional modification time as a Unix timestamp."), hdr("OC-Checksum", description="Optional checksum, e.g. `SHA256:<hex>`, verified by the server.")],
      requestBody=BIN_BODY, responses={"201": {"description": "Created"}, "204": {"description": "Replaced"}},
      description="Creates the file or replaces an existing one (the previous content stays as a version when the Versions app is on). The parent folder must exist (use MKCOL). Content is a base64 file object, up to 25 MB per call; larger files use the chunked upload operations."),
  "delete": op("webdav-files-delete", "Delete a file or folder (moves it to the trash bin)", "files", files_doc, responses={"204": {"description": "Deleted"}}),
  "x-propfind": op("webdav-files-propfind", "List a folder or stat a file", "files", files_doc, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "x-proppatch": op("webdav-files-proppatch", "Set or remove file properties (favorite, tags, custom)", "files", files_doc, requestBody=XML_BODY(True, "`<d:propertyupdate>` with `<d:set>` / `<d:remove>`, e.g. `<oc:favorite>1</oc:favorite>`."), responses=MS),
  "x-mkcol": op("webdav-files-mkcol", "Create a folder", "files", files_doc, responses={"201": {"description": "Created"}}, description="The parent folder must exist."),
  "x-move": op("webdav-files-move", "Move or rename a file or folder", "files", files_doc,
      parameters=[hdr("Destination", required=True, description="Target path below the user's root, e.g. `Archive/notes.md`.", **{"x-destination-template": "/remote.php/dav/files/{user}/{Destination}"}), OVERWRITE],
      responses={"201": {"description": "Moved"}, "204": {"description": "Moved over an existing target"}}),
  "x-copy": op("webdav-files-copy", "Copy a file or folder (fails if the target exists)", "files", files_doc,
      parameters=[hdr("Destination", required=True, description="Target path below the user's root; it must not exist yet.", **{"x-destination-template": "/remote.php/dav/files/{user}/{Destination}"}), hdr("Overwrite", {"type": "string", "const": "F"}, description="Fixed to F: a copy never replaces an existing file. Delete the target first, or use MOVE with Overwrite T, to replace it.")],
      responses={"201": {"description": "Copied"}, "412": {"description": "The target exists"}}),
}
# ---- chunked upload v2
up = ext("chunking")
CHUNK_DEST = hdr("Destination", required=True, description="Final file path below the user's root, e.g. `Videos/big.mp4`.", **{"x-destination-template": "/remote.php/dav/files/{user}/{Destination}"})
TOTAL = lambda req: hdr("OC-Total-Length", {"type": "string", "pattern": "^[0-9]+$"}, req, description="Total size in bytes of the final file.")
paths["/remote.php/dav/uploads/{user}/{uploadId}"] = {
  "parameters": [USER, path("uploadId", description="A unique id you choose for this upload session.")],
  "x-mkcol": op("webdav-uploads-start", "Start a chunked upload (v2)", "uploads", up, parameters=[CHUNK_DEST, TOTAL(False)], responses={"201": {"description": "Upload session created"}}),
  "x-propfind": op("webdav-uploads-list-chunks", "List the chunks uploaded so far", "uploads", up, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "delete": op("webdav-uploads-abort", "Abort a chunked upload and discard its chunks", "uploads", up, responses={"204": {"description": "Discarded"}}),
}
paths["/remote.php/dav/uploads/{user}/{uploadId}/{chunkId}"] = {
  "parameters": [USER, path("uploadId"), path("chunkId", description="Chunk number, 1 to 10000; chunks are assembled in numeric order.")],
  "put": op("webdav-uploads-put-chunk", "Upload one chunk", "uploads", up, parameters=[CHUNK_DEST, TOTAL(True)], requestBody=BIN_BODY, responses={"201": {"description": "Chunk stored"}},
      description="Chunks other than the last must be at least 5 MB (server default) and at most 5 GB; each call carries up to 25 MB here."),
}
paths["/remote.php/dav/uploads/{user}/{uploadId}/.file"] = {
  "parameters": [USER, path("uploadId")],
  "x-move": op("webdav-uploads-finish", "Assemble the chunks into the destination file", "uploads", up,
      parameters=[CHUNK_DEST, TOTAL(False), hdr("X-OC-MTime", {"type": "string", "pattern": "^[0-9]+$"}, description="Optional modification time as a Unix timestamp.")], responses={"201": {"description": "Created"}, "204": {"description": "Replaced"}}),
}
# ---- trashbin
tb = ext("trashbin", "")
paths["/remote.php/dav/trashbin/{user}/trash"] = {
  "parameters": [USER],
  "x-propfind": op("webdav-trashbin-list", "List the trash bin", "trashbin", tb, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "delete": op("webdav-trashbin-empty", "Empty the trash bin permanently", "trashbin", tb, responses={"204": {"description": "Emptied"}}, description="Permanently removes every item in the trash bin."),
}
paths["/remote.php/dav/trashbin/{user}/trash/{item}"] = {
  "parameters": [USER, path("item", True, "A trash item as listed by PROPFIND, e.g. `notes.md.d1700000000` (inside a trashed folder: `folder.d1700000000/file.md`).")],
  "get": op("webdav-trashbin-download", "Download a trashed file", "trashbin", tb, responses=BIN_RESP),
  "x-propfind": op("webdav-trashbin-item-propfind", "Stat a trashed item or list a trashed folder", "trashbin", tb, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "x-move": op("webdav-trashbin-restore", "Restore a trashed item to its original location", "trashbin", tb,
      parameters=[hdr("Destination", {"type": "string", "default": "restored"}, description="Any name; the item is restored to its original location.", **{"x-destination-template": "/remote.php/dav/trashbin/{user}/restore/{Destination}"})],
      responses={"201": {"description": "Restored"}}),
  "delete": op("webdav-trashbin-delete", "Permanently delete a trashed item", "trashbin", tb, responses={"204": {"description": "Deleted"}}),
}
# ---- versions
vr = ext("versions", "")
paths["/remote.php/dav/versions/{user}/versions/{fileId}"] = {
  "parameters": [USER, path("fileId", description="Numeric file id (the `oc:fileid` property from PROPFIND).")],
  "x-propfind": op("webdav-versions-list", "List the versions of a file", "versions", vr, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
}
paths["/remote.php/dav/versions/{user}/versions/{fileId}/{versionId}"] = {
  "parameters": [USER, path("fileId"), path("versionId", description="A version id as listed by PROPFIND (a Unix timestamp).")],
  "get": op("webdav-versions-download", "Download one version of a file", "versions", vr, responses=BIN_RESP),
  "x-move": op("webdav-versions-restore", "Restore a version, replacing the current file content", "versions", vr,
      parameters=[hdr("Destination", {"type": "string", "default": "target"}, description="Any name; the file is restored in place.", **{"x-destination-template": "/remote.php/dav/versions/{user}/restore/{Destination}"})],
      responses={"201": {"description": "Restored"}}),
}
# ---- system tags
st = {"description": "Server source of the system tags DAV endpoints (no developer-manual page)", "url": "https://github.com/nextcloud/server/tree/v31.0.14/apps/dav/lib/SystemTag"}
JSON_TAG = {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": S, "userVisible": {"type": "boolean", "default": True}, "userAssignable": {"type": "boolean", "default": True}, "canAssign": {"type": "boolean", "default": True}}}}}}
paths["/remote.php/dav/systemtags"] = {
  "x-propfind": op("webdav-systemtags-list", "List system tags", "systemtags", st, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "post": op("webdav-systemtags-create", "Create a system tag", "systemtags", st, requestBody=JSON_TAG, responses={"201": {"description": "Created; the Content-Location header holds the new tag"}}),
}
paths["/remote.php/dav/systemtags/{tagId}"] = {
  "parameters": [path("tagId", description="Numeric tag id.")],
  "x-propfind": op("webdav-systemtags-get", "Get one system tag", "systemtags", st, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
  "x-proppatch": op("webdav-systemtags-update", "Rename or change a system tag", "systemtags", st, requestBody=XML_BODY(True, "`<d:propertyupdate>` setting `<oc:display-name>`, `<oc:user-visible>`, `<oc:user-assignable>`."), responses=MS),
  "delete": op("webdav-systemtags-delete", "Delete a system tag (removes it from every file)", "systemtags", st, responses={"204": {"description": "Deleted"}}),
}
paths["/remote.php/dav/systemtags-relations/files/{fileId}"] = {
  "parameters": [path("fileId", description="Numeric file id.")],
  "x-propfind": op("webdav-systemtags-file-tags", "List the system tags of a file", "systemtags", st, parameters=[DEPTH], requestBody=PROPFIND_BODY, responses=MS),
}
paths["/remote.php/dav/systemtags-relations/files/{fileId}/{tagId}"] = {
  "parameters": [path("fileId"), path("tagId")],
  "put": op("webdav-systemtags-assign", "Assign a system tag to a file", "systemtags", st, responses={"201": {"description": "Assigned"}}),
  "delete": op("webdav-systemtags-unassign", "Remove a system tag from a file", "systemtags", st, responses={"204": {"description": "Removed"}}),
}
# ---- comments
cm = {"description": "Nextcloud developer manual", "url": "https://docs.nextcloud.com/server/31/developer_manual/client_apis/WebDAV/comments.html"}
paths["/remote.php/dav/comments/files/{fileId}"] = {
  "parameters": [path("fileId", description="Numeric file id.")],
  "x-report": op("webdav-comments-list", "List the comments on a file (REPORT)", "comments", cm, requestBody=XML_BODY(True, "Report body with `<oc:limit>`, `<oc:offset>` and optional `<oc:datetime>` (see the docs example)."), responses=MS),
  "post": op("webdav-comments-create", "Comment on a file", "comments", cm, requestBody={"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["message"], "properties": {"actorType": {"type": "string", "default": "users"}, "verb": {"type": "string", "default": "comment"}, "message": {"type": "string", "maxLength": 1000}}}}}}, responses={"201": {"description": "Created"}},
      description="Visible to everyone who can open the file; an `@user` mention notifies that user."),
}
paths["/remote.php/dav/comments/files/{fileId}/{commentId}"] = {
  "parameters": [path("fileId"), path("commentId")],
  "x-proppatch": op("webdav-comments-update", "Edit a comment", "comments", cm, requestBody=XML_BODY(True, "`<d:propertyupdate>` setting `<oc:message>`."), responses=MS),
  "delete": op("webdav-comments-delete", "Delete a comment", "comments", cm, responses={"204": {"description": "Deleted"}}),
}
webdav = {"openapi": "3.0.3", "info": {"title": "Nextcloud WebDAV (hand-authored)", "version": "31.0.14", "x-source": "hand-authored",
  "description": "Hand-authored OpenAPI description of Nextcloud's WebDAV endpoints (files, chunked upload v2, trash bin, versions, system tags, comments), written from the developer manual at https://docs.nextcloud.com/server/31/developer_manual/client_apis/WebDAV/ . WebDAV methods are declared as x-<method> operations on the path item (Marketplace spec extension). Not verified against a live server."},
  "paths": paths, "components": {}}
OCS = {"name": "OCS-APIRequest", "in": "header", "required": True, "description": "Required to be true for the API request to pass", "schema": {"type": "boolean", "default": True}}
def ocsop(opid, summary, params, doc, desc=None):
    return {"operationId": opid, "summary": summary, **({"description": desc} if desc else {}), "tags": ["api"], "externalDocs": {"description": doc[0], "url": doc[1]}, "parameters": [OCS] + params,
            "responses": {"200": {"description": "OK", "content": {"application/json": {"schema": {"type": "object", "additionalProperties": True}}}}, "304": {"description": "Not modified"}}}
def q(name, schema, desc=None): 
    p = {"name": name, "in": "query", "required": False, "schema": schema}
    if desc: p["description"] = desc
    return p
ACT_DOC = ("Activity API v2", "https://github.com/nextcloud/activity/blob/stable31/docs/endpoint-v2.md")
since = q("since", {"type": "integer"}, "Id of the last activity you have seen.")
limit = q("limit", {"type": "integer", "default": 50, "minimum": 1}, "How many activities to return.")
sort = q("sort", {"type": "string", "enum": ["asc", "desc"], "default": "desc"})
activity = {"openapi": "3.0.3", "info": {"title": "Nextcloud Activity API v2 (hand-authored)", "version": "4.0.0", "x-source": "hand-authored",
  "description": "Hand-authored from https://github.com/nextcloud/activity/blob/stable31/docs/endpoint-v2.md (activity app 4.0.0, tag v31.0.14); the app publishes no OpenAPI document."},
  "paths": {
    "/ocs/v2.php/apps/activity/api/v2/activity": {"get": ocsop("activity-get-default", "Get the activity stream", [since, limit, sort], ACT_DOC, "Pagination: pass the `X-Activity-Last-Given` response header as `since`.")},
    "/ocs/v2.php/apps/activity/api/v2/activity/filters": {"get": ocsop("activity-list-filters", "List the activity type filters", [], ACT_DOC)},
    "/ocs/v2.php/apps/activity/api/v2/activity/{filter}": {"get": ocsop("activity-get-filter", "Get the activity stream for one filter", [{"name": "filter", "in": "path", "required": True, "schema": S, "description": "A filter id from the filters list, e.g. `all`, `self`, `by`, `filter`, `files_favorites`. `filter` is the only one that accepts object_type and object_id."}, since, limit, sort,
        q("object_type", S, "Only with filter `filter` and together with object_id, e.g. `files`."), q("object_id", S, "Only with filter `filter` and together with object_type, e.g. a file id.")], ACT_DOC)},
  }, "components": {}}
SI_DOC = ("serverinfo README", "https://github.com/nextcloud/serverinfo/blob/stable31/README.md")
serverinfo = {"openapi": "3.0.3", "info": {"title": "Nextcloud serverinfo API (hand-authored)", "version": "3.0.0", "x-source": "hand-authored",
  "description": "Hand-authored from https://github.com/nextcloud/serverinfo/blob/stable31/README.md and the app's routes.php (serverinfo app 3.0.0, tag v31.0.14); the app publishes no OpenAPI document. The endpoints need an administrator account (or the app's monitoring token header, which this connector does not send)."},
  "paths": {
    "/ocs/v2.php/apps/serverinfo/api/v1/info": {"get": ocsop("serverinfo-info", "Server information (system, storage, shares, PHP, database, active users)", [q("skipApps", {"type": "boolean", "default": True}, "Omit app update information (listing app updates calls the app store)."), q("skipUpdate", {"type": "boolean", "default": True}, "Omit server update information.")], SI_DOC)},
    "/ocs/v2.php/apps/serverinfo/api/v1/basicdata": {"get": ocsop("serverinfo-basic-data", "Server time, uptime and thermal zones", [], SI_DOC)},
    "/ocs/v2.php/apps/serverinfo/api/v1/diskdata": {"get": ocsop("serverinfo-disk-data", "Disk devices and usage", [], SI_DOC)},
  }, "components": {}}
for name, doc in [("webdav", webdav), ("activity", activity), ("serverinfo", serverinfo)]:
    json.dump(doc, open(f"{out}/{name}.json", "w"), indent=2); open(f"{out}/{name}.json", "a").write("\n")
n = sum(1 for d in (webdav, activity, serverinfo) for i in d["paths"].values() for k in i if k != "parameters")
print("hand-authored ops:", n)
