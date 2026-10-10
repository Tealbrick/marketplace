import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, UserMinus, Users } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { listChannelPeople, revokeChannelPerson, updatePeoplePolicy } from "./channels-api";
import { PROVIDER_LABEL } from "./channels-model";
import type { ChannelProviderId, ChannelsBrowseResponse, PeoplePolicyMode, PeoplePolicyView } from "./types";
import { formatWhen, InlineError } from "./ui";

// Routes v2 (review R5): who agents may send direct messages to, per connection, and the people the owner approved.
// Agents never see these lists: they ask for one person by email or handle and get one opaque reference back.

const MODE_COPY: Record<PeoplePolicyMode, { label: string; detail: string }> = {
  none: { label: "Nobody", detail: "Agents can't find or message anyone on this connection." },
  allowlist: { label: "Only listed people", detail: "Agents can find and message only the people you list: verified emails and email domains (Slack, Teams), or platform ids (Slack U…, Teams object id, Discord user id, Buzz npub). Display names and nicknames never match." },
  workspace: { label: "Anyone in the workspace", detail: "Agents can find and message anyone the connected workspace or tenant can reach." },
};

const PEOPLE_HINT: Partial<Record<ChannelProviderId, string>> = {
  slack: "Slack finds people by email only.",
  discord: "Discord finds people by handle (username, display name or server nickname).",
  teams: "Teams finds people by email or user principal name.",
  buzz: "Buzz finds members of the agent's channels by npub or exact name.",
};

const lines = (value: string) => value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);

function PeopleList({ connectionId, onNotice }: { connectionId: string; onNotice: (notice: string) => void }) {
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ["channel-people", connectionId], queryFn: () => listChannelPeople(connectionId), retry: false });
  const revoke = useMutation({
    mutationFn: (personRef: string) => revokeChannelPerson(connectionId, personRef),
    onSuccess: (result) => {
      onNotice(`Revoked ${result.person.displayName} for ${result.person.agentId}. That agent's next message to them waits for your approval.`);
      void queryClient.invalidateQueries({ queryKey: ["channel-people", connectionId] });
    },
  });
  if (people.isLoading) return <span className="muted-detail">Loading people…</span>;
  if (people.error) return <InlineError error={people.error} />;
  const rows = people.data?.people ?? [];
  if (!rows.length) return <p className="muted-detail">No agent has looked anyone up on this connection yet.</p>;
  return <>
    <table className="caps-table" aria-label="People agents found">
      <thead><tr><th scope="col">Person</th><th scope="col">Agent</th><th scope="col">Found by</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead>
      <tbody>{rows.map((person) => <tr key={person.personRef}>
        <th scope="row">{person.displayName}<small className="muted-detail"> <code>{person.platformUserId}</code></small></th>
        <td><code>{person.agentId}</code></td>
        <td><code>{person.lookup.value}</code></td>
        <td>{person.approved
          ? <Tag tone="success">Approved {formatWhen(person.approvedAt)}</Tag>
          : <Tag>{person.revokedAt ? `Revoked ${formatWhen(person.revokedAt)}` : "First message needs approval"}</Tag>}</td>
        <td>{person.approved && <Button size="small" disabled={revoke.isPending} onClick={() => revoke.mutate(person.personRef)} aria-label={`Revoke ${person.displayName} for ${person.agentId}`}><UserMinus size={14} />Revoke</Button>}</td>
      </tr>)}</tbody>
    </table>
    {revoke.error && <InlineError error={revoke.error} />}
  </>;
}

function PeoplePolicyForm({ connectionId, provider, policy, onNotice }: { connectionId: string; provider: ChannelProviderId; policy: PeoplePolicyView; onNotice: (notice: string) => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<PeoplePolicyMode>(policy.mode);
  const [people, setPeople] = useState(policy.people.join("\n"));
  const [domains, setDomains] = useState(policy.domains.join("\n"));
  const save = useMutation({
    mutationFn: () => updatePeoplePolicy(connectionId, mode === "allowlist" ? { mode, people: lines(people), domains: lines(domains) } : { mode }),
    onSuccess: (result) => {
      onNotice(`${PROVIDER_LABEL[provider]} direct messages: ${MODE_COPY[result.policy.mode].label.toLowerCase()}.`);
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
      void queryClient.invalidateQueries({ queryKey: ["channel-people", connectionId] });
    },
  });
  return <form className="people-policy" aria-labelledby={`${id}-title`} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <h4 id={`${id}-title`}>Who agents may message</h4>
    <div role="radiogroup" aria-label="People policy" className="checkbox-grid">
      {(Object.keys(MODE_COPY) as PeoplePolicyMode[]).map((value) => <label key={value} className="confirm-check">
        <input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} />
        <span><strong>{MODE_COPY[value].label}</strong><small className="muted-detail"> {MODE_COPY[value].detail}</small></span>
      </label>)}
    </div>
    {mode === "allowlist" && <div className="form-grid two">
      <label>Emails or platform ids (one per line)<textarea rows={3} value={people} onChange={(event) => setPeople(event.target.value)} placeholder="ana@example.com" /></label>
      <label>Email domains (one per line)<textarea rows={3} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="example.com" /></label>
    </div>}
    <p className="muted-detail">{PEOPLE_HINT[provider] ?? ""} Each agent's first message to each person always waits for your approval of the exact message; after that, a standing grant with direct messages can cover that agent's later ones.</p>
    {save.error && <InlineError error={save.error} />}
    <div className="dialog-actions"><Button size="small" tone="primary" type="submit" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save</Button></div>
  </form>;
}

/** Per connection whose provider offers direct messages: the people policy and the people agents found. */
export function PeoplePanels({ browse, onNotice }: { browse: ChannelsBrowseResponse; onNotice: (notice: string) => void }) {
  const entries = browse.providers.flatMap((entry) => {
    const provider = entry.id as ChannelProviderId;
    const connection = browse.connections[provider];
    return connection && entry.capabilities?.dm?.open && browse.readiness[provider] === "available" ? [{ provider, connection }] : [];
  });
  if (!entries.length) return null;
  return <section className="channel-section" aria-labelledby="channel-people-heading">
    <div className="section-heading"><div><p className="eyebrow">Direct messages</p><h2 id="channel-people-heading"><Users size={16} aria-hidden="true" /> People</h2></div></div>
    {entries.map(({ provider, connection }) => {
      const policy: PeoplePolicyView = connection.peoplePolicy ?? { mode: "none", people: [], domains: [], updatedBy: null, updatedAt: null };
      return <article key={provider} className="people-connection" aria-label={`${PROVIDER_LABEL[provider]} people`}>
        <h3>{PROVIDER_LABEL[provider]}</h3>
        <PeoplePolicyForm key={`${connection.connectionId}-${policy.updatedAt ?? "unset"}`} connectionId={connection.connectionId} provider={provider} policy={policy} onNotice={onNotice} />
        <PeopleList connectionId={connection.connectionId} onNotice={onNotice} />
      </article>;
    })}
  </section>;
}
