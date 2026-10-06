# Marketplace source-backed Railway deployment

This directory is a reviewable deployment contract for the standalone public
Marketplace source. It is not a Railway import format and it does not claim
that a Railway template has been created or published. Portal owns template
creation, customer-project writes, deployment identity, and acceptance.

## Pinned source and build

Use the public repository
`https://github.com/Tealbrick/marketplace` at branch
`release-marketplace-v0.1.15`, resolved and recorded in the successor receipt.
The source snapshot used for the release is commit
`46abccb1b4b8548843b0ce66986c5adfd7d40cbd`. Do not connect `main`, the
rejected tag source, or another mutable branch. Set the service root directory
to `release/railway`; Railway then builds the tracked `Dockerfile` in that
directory.

Portal's actual `templateDeployV2` probe showed that `source.branch=v0.1.3`
fails with Branch not found and `source.commitSha` is ignored. Use
`source.branch=release-marketplace-v0.1.15`; the branch is fixed to the reviewed
runtime by the successor repository ruleset recorded in the receipt:

- target: `refs/heads/release-marketplace-v0.1.15`
- enforcement: `active`
- rules: `update`, `non_fast_forward`, `deletion`
- bypass actors: none; GitHub reports `current_user_can_bypass=never`

Portal must re-check that ruleset before template creation and record the
resolved branch SHA. Do not substitute `main` or rely on `source.commitSha`.

Railway builds the selected public source in the customer project. The build
does not pull GHCR and does not require private registry credentials. The
Dockerfile packages the tracked, release-verified Program and browser bundle;
it is not a development install. Before template creation, Portal should
resolve the tag to the exact commit and verify the release manifests:

```sh
shasum -a 256 -c release/railway/build-input-manifest.sha256
shasum -a 256 -c release/railway/bundle-manifest.sha256
git archive --format=tar 46abccb1b4b8548843b0ce66986c5adfd7d40cbd \
  | shasum -a 256
```

The archived source snapshot must hash to
`419b9b5714f2f742cf92000c2468fbe1ad6a26aec47c6e3d8388590f1f08ff39`. Record
the Railway-resolved commit and deployment ID separately from these local
checks; a health response is not source identity proof.

## Service and volume

Create one Marketplace service with public HTTP networking on port `5314`,
healthcheck `GET /healthz`, and one private persistent volume mounted at
`/data`. Leave the Dockerfile entrypoint in place and do not start
`program/src/index.ts` directly.

Railway mounts volumes as root. Set `RAILWAY_RUN_UID=0`. The tracked entrypoint
verifies the mount without following symlinks, prepares only `/data/state` and
`/data/logs` with private mode, changes those direct directories to uid/gid
`1000`, drops supplementary groups and starts the Program as uid/gid `1000`.
It does not recursively re-own customer volume contents.

Persist the SQLite database and provider settings under `/data/state`. Keep
debug logs under `/data/logs`. Do not put provider credentials, operator
sessions, tenant data, or the handoff key in the source repository or image.

## Runtime identity and variables

The complete machine-readable variable contract is in `recipe.json` and
`railway-blueprint.json`. In summary, Portal/customer provisioning must provide
the exact server-side Marketplace operator and organization identities, exact
HTTPS origins, Portal issuer/proof/deployment/org/workspace identities, and a
tenant-scoped Rules evaluation credential. `MARKETPLACE_HANDOFF_ENCRYPTION_KEY`
is a unique 32-byte hex or base64url secret held outside SQLite and reused for
retries, restarts, upgrades, and restores.

Browser clients receive redacted projections only. They never receive
`MARKETPLACE_INTERNAL_AUTH_TOKEN`, provider keys, Portal instance proof, Rules
credentials, or the handoff key. A browser-supplied workspace, actor or agent
label does not establish authority.

## Readiness and acceptance

1. Resolve and record the pinned source commit.
2. Build from the public source in the customer project and record the Railway
   service/deployment identity.
3. Verify `/healthz`, then verify protected `/api/status` with the intended
   internal or operator credential.
4. Call `/api/portal/readiness` only as a server-to-server request with
   `x-tealbrick-instance-proof`; no browser cookie, origin or authorization
   header is accepted on that route.
5. Verify tenant binding, Rules introspection, and private volume persistence.
6. Back up the database/settings/secrets through an approved consistent path,
   restore into an isolated instance with the same handoff key, and verify
   wrong-key startup fails without rewriting the database.
7. If a provider canary is separately approved, use only the existing
   `github-composio` / `github.list.repositories` / `connector.observe` path
   against a dedicated or community-scoped connected account. Request Portal
   consent for the exact agent, account and `account:<id>` resource. Record
   the provider response, Portal consent/lease identifiers, Marketplace audit
   event, and revocation result.

These checks do not by themselves prove provider authorization, real agent
reconnection, production readiness, or human UAT. No template ID or public
template URL is claimed until Portal creates and verifies one in an isolated
project.
