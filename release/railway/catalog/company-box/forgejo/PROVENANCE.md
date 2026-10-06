# Forgejo provenance

- App: Forgejo 13.0.5 (`codeberg.org/forgejo/forgejo:13-rootless`, `13.0.5+gitea-1.22.0`, GPL-3.0), deployed on `fed-main`. Captured 2026-10-06.
- Source: Swagger 2.0 `swagger.json`. At tag `v13.0.5` the spec is the template `templates/swagger/v1_json.tmpl` (sha256 `f50792db8baa0320d60c397bcb59074fdd3111674bc5c719667230ca3e93a2d9`), whose only placeholders are `{{AppVer}}` and `{{AppSubUrl}}`. Rendering it with `13.0.5+gitea-1.22.0` and an empty sub-URL gives a document identical (parsed) to the one the instance serves unauthenticated at `/swagger.v1.json`, so the instance file is vendored byte for byte, sha256 `f266cd74476051c4c45fb0ce6d5ef9a76aa10046a5b69c100257b6e16ce834de`. The engine reads Swagger 2.0 itself (`basePath` `/api/v1`), no conversion step and no overlay.
- Operations: 469 (GET 241, POST 93, DELETE 77, PATCH 29, PUT 29): 459 exposed, 10 excluded. Exposure: discovery.
- Why `openapi` and not the community MCP: forgejo-mcp (GPL-3.0, 156 tools) covers about a third of the API and leaves out webhooks, mirrors, collaborators, packages, secrets and the admin API.
- Excluded (10), each with its reason in `entry.json`:
  - Host-dangerous: `adminCronRun` (runs a maintenance task on the host), `adminCreateHook` and `adminEditHook` (server-wide webhooks receiving every repository's events), `repoEditGitHook` (writes a server-side hook script the host executes on push).
  - Cannot work with a token: `userGetTokens`, `userCreateToken`, `userDeleteAccessToken` need the account password over HTTP Basic, and `activitypubInstanceActorInbox`, `activitypubRepositoryInbox`, `activitypubPersonInbox` take HTTP-signature deliveries from remote servers. Exposing them would only produce refused calls.
- Outward (21, held): webhooks (repo, org, user create and edit, repo hook test), push mirror add and sync, pull mirror sync, migration from a URL, workflow dispatch, pull request merge, release create and edit and release asset upload, repository transfer, collaborator and team member add (invitation mail), admin user create, user email add (confirmation mail). Judgement call: issue, comment, pull request and review writes email watchers, but they are ordinary collaboration inside the forge, so they are plain writes, not held.
- Destructive beyond DELETE: `repoTransfer`, `repoConvert`, `repoMergePullRequest`, `adminEditUser`, `adminRenameUser`, `renameOrg`. The 77 DELETE operations are admin-capability by rule.
- Reads (3): `renderMarkdown`, `renderMarkdownRaw`, `renderMarkup` (render text, change nothing).
- Auth: `Authorization: token <PAT>` (Settings > Applications > Access Tokens; scopes per category, an `admin` scope is needed for `/admin/*`). Use a token scoped to what the agent should do.
- Health: `GET /version` (`getVersion`), which needs a valid token.
- Base URL at install: the public `https://` address of the forge. The tailnet port answers 400 to a Host it does not know, so use the hostname the serve config expects.
