# Marketplace 0.2.0 release notes (draft)

Draft only. This file does not cut a release; the version files, release
bundle and manifests change in the release commit (Lead · Miniapps).

## Upgrade and rollback

* New channel tables are additive; 0.1.19 starts on the same data directory
  and ignores them.
* Scheduled channel posts do not fire while on 0.1.19; after the upgrade back
  a post more than 15 minutes late becomes `expired`.
* Do not approve channel holds in an older Marketplace during a rollback; they
  are skipped after the upgrade back.
