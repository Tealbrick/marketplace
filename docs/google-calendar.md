# Google Calendar for Tempo

Tempo reaches Google Calendar through Marketplace's Composio path (toolkit
`googlecalendar`, 50 tools). The tools cover 37 of the 38 Calendar API v3
methods; `calendars.transferOwnership`, added in discovery revision 20260925,
has no Composio tool yet (see
`program/catalog/composio-policy/COVERAGE.md`).

## Operator steps

1. **Composio key.** In Marketplace, open Settings → Composio, paste the
   Composio API key, choose Test, then Save. The key stays on the server.
2. **Install Google Calendar.** In Catalog, search "Google Calendar" and
   choose Install.
3. **Connect.** Choose Connect. Marketplace imports the whole
   `googlecalendar` toolkit (every tool becomes an action), then a Composio
   window opens for the Google sign-in (OAuth). Allow pop-ups for
   Marketplace. When the window closes, the card shows Connected.
4. **Grant Tempo per tool.** In Teal Brick Portal, request access for the
   Tempo agent to each Google Calendar action it needs (Agent grants in
   Marketplace shows what is granted). Grants are per tool: granting
   `events.list` does not allow `create.event`.
5. **Capabilities.** Destructive tools need the workspace's
   `connector.admin` binding; leave it off unless Tempo should be able to
   delete calendars or events.

## What is governed, and how

A curated policy (`program/catalog/composio-policy/googlecalendar.json`,
versioned) classifies the toolkit, on top of name-based inference:

- **Outward** (reaches people outside the workspace):
  - Event writes that notify attendees: CREATE_EVENT, UPDATE_EVENT,
    PATCH_EVENT, QUICK_ADD, EVENTS_MOVE, DELETE_EVENT. A call is outward
    unless it is explicitly quiet: `send_updates` (or `sendUpdates`) is
    `"none"`, it names no `attendees`, and `send_notifications` is not true.
    A call that leaves `send_updates` out counts as outward, because Composio
    or Google may default to notifying.
  - Always outward: BATCH_EVENTS (its contents are not inspected),
    EVENTS_IMPORT and REMOVE_ATTENDEE (no way to turn notifications off),
    ACL_INSERT / ACL_UPDATE / ACL_PATCH (sharing a calendar), and every
    `*_WATCH` tool (registers an external webhook address).
- **Destructive** (needs `connector.admin`): CALENDARS_DELETE,
  CLEAR_CALENDAR, ACL_DELETE, CALENDAR_LIST_DELETE, DELETE_EVENT, and
  BATCH_EVENTS (a batch can delete events).
- **Writes pinned to at least `connector.dispatch`**: tools whose names do
  not reveal that they write (`*_PATCH`, `*_INSERT`, `*_WATCH`,
  EVENTS_MOVE, CHANNELS_STOP, DUPLICATE_CALENDAR, BATCH_EVENTS). Without the
  policy they would infer as read-only.
- Everything else (lists, gets, free/busy, settings reads) follows the
  existing classification and runs on its grant alone.

Listings imported before the policy are re-classified when Marketplace
starts. A tool that moves to a higher capability stops being usable under an
older, lower grant until it is granted again.

## Approvals

- **Owner approval mode (no Rules service):** an outward call from Tempo is
  not run. It answers `202 { status: "approval_pending", approvalId }` and
  waits under Connections → Company Box → Approvals (badge on Connections),
  with the full arguments for review. Approve runs it exactly once; Deny
  records the refusal; requests expire after 7 days. Tempo polls the
  approval, or repeats the call with the same idempotency key, to get the
  result. Quiet event writes and reads run immediately on their grants.
- **Rules connected:** Rules receives `risk: { write, outward, destructive }`
  with every call and its decision stands (a `review` waits in the Rules
  approvals queue).

## Coverage

`pnpm run composio:coverage` (from `program/`) checks that every method in
the vendored `googlecalendar.api-methods.json` (from the Google discovery
document, revision and sha256 recorded) maps to a tool in the vendored
`googlecalendar.tools.json` snapshot, or is listed as unmapped with a reason;
that every policy pattern matches a real tool; and that no tool that is not
read-only upstream classifies as read-only. It writes `COVERAGE.md` and
`coverage.json` next to the policy and fails on any gap.
