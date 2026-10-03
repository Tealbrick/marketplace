# Marketplace Agent Tools

The compatibility adapter exposes Marketplace capabilities to the Doppelganger
Agent after the Micro-app is installed, enabled, scoped, and allowed by policy.

## Read And Status

- `marketplace_health`: `GET /healthz`
- `marketplace_status`: `GET /api/status`
- `marketplace_events`: `GET /events`
- `marketplace_catalog_list`: `GET /api/marketplace/catalog`
- `marketplace_listing_get`: `GET /api/marketplace/plugins/:pluginId`
- `marketplace_provider_health`: `GET /api/marketplace/provider-health`
- `marketplace_audit_list`: `GET /api/marketplace/audit`
- `marketplace_agent_capabilities`: `GET /api/agent/capabilities`
- `marketplace_debug_events`: `GET /api/debug/events`
- `marketplace_debug_logs`: `GET /api/debug/logs`
- `marketplace_composio_catalog`: `GET /api/marketplace/catalog/composio`
- `marketplace_composio_tools`: `GET /api/marketplace/catalog/composio/tools?toolkit=<slug>`

## Governed Mutation And Execution

- `marketplace_plugin_install`: requires `connector.admin`
- `marketplace_plugin_uninstall`: requires `connector.admin`
- `marketplace_plugin_register`: requires `connector.admin`
- `marketplace_plugin_unregister`: requires `connector.admin`
- `marketplace_connection_register`: requires `connector.admin`
- `marketplace_capability_bind`: requires `connector.admin`
- `marketplace_action_bind`: requires `connector.admin`
- `marketplace_plugin_execute`: requires the requested connector capability
- `marketplace_activepieces_scaffold`: requires `connector.admin`
- `marketplace_composio_import`: requires `connector.admin`

When Rules Approvals is missing, these governed tools return a fail-closed
error. Provider-backed tools also fail closed when their external engine is not
configured.

Agent-facing connector capabilities are exposed separately after registration,
installation, and capability binding. Use `marketplace_agent_capabilities` to
discover the projected tools. Then call `marketplace_agent_tool_call` with the
advertised `toolName`, `pluginId`, `workspaceSlug`, and `input`. For example,
`github-native` with `connector.observe` bound exposes
`marketplace.github.repositories.list` through
`POST /api/agent/tools/marketplace.github.repositories.list`.
