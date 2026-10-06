# Easy!Appointments provenance

- App: Easy!Appointments 1.6.0 (`alextselegidis/easyappointments:1.6.0`, upstream latest stable). Captured 2026-10-06.
- Upstream spec: tag `1.6.0`, `openapi.yml` (https://raw.githubusercontent.com/alextselegidis/easyappointments/1.6.0/openapi.yml), sha256 `2500409c8414e311b13318272fb3ff62aa63f53efce81add39d0b7170f6c70d1`.
- Vendored `openapi.json` is that YAML converted to JSON (YAML 1.2 parser, no content changes), sha256 `2827831e11421f6bd22bc85f9af848cc4916c8dce7c921df063da244f2660962`. The upstream spec matches the controllers in `application/controllers/api/v1` at the tag (13 controllers).
- Operations: 59 across 25 paths (GET 25, POST 11, PUT 12, DELETE 11). Exposed 51, excluded 8.
- Excluded, each with its reason in `entry.json`: `/admins` (5 ops, administrator accounts and credentials) and `/settings` (3 ops, instance settings incl. API token and SMTP credentials). Research marks both as to be excluded.
- Outward (held for approval): appointment create/update/delete (customer and provider emails, calendar sync) and webhook create/update (outbound HTTP to arbitrary URLs). DELETE operations are also destructive.
- Auth: `Authorization: Bearer <api-token>`; token is generated in Settings > API in the app. Basic auth with an admin login exists upstream but is not offered.
- Base URL at install: the app origin. The adapter appends the spec's `/index.php/api/v1` prefix. Deployed on the `neuu` node behind tailscale serve: `https://neuu.<tailnet>.ts.net:8515`. If the instance serves clean URLs without `index.php`, confirm before install.
- Reads: none. Every POST/PUT/DELETE changes data (the availability lookup is already a GET).
- Health: `GET /services`.
