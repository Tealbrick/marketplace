# Marketplace Extension Surface

This Extension is manifest-first. The primitive operator UI is served by the
Program at `/` and is reachable through the `marketplace-api` data transport
once the App runtime starts the packaged sidecar.

The App should mount a first-party surface from the manifest rather than import
Program files directly.
