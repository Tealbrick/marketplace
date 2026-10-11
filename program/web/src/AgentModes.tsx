import { useState } from "react";
import { Bot, LoaderCircle, Pause, Play, ShieldCheck } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAgentModes, setAgentPaused, setAllAgentsPaused, setHoldFamily, updateAgentMode } from "./agent-grants-api";
import type { AgentApprovalMode, AgentModesResponse, AgentModeView } from "./types";
import { InlineError } from "./ui";

/** Owner copy; Lead · Website may refine it. */
export const MODE_COPY: Record<AgentApprovalMode, string> = {
  assistant:
    "Assistant: this agent sends and changes things without asking you. You see every action in Activity. Daily limits and Pause still apply. Deletes, payments, refunds, and sharing or permission changes still wait for you.",
  system: "System: every outward action waits for your approval.",
};

const AGENT_MODES_KEY = ["agent-modes"] as const;

/** Shown next to a family the owner turned off. */
export const FAMILY_OFF_WARNING = "Assistant agents will do this without asking you.";

function WhatStillWaits({ data }: { data: AgentModesResponse }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (input: { id: string; on: boolean }) => setHoldFamily(input.id, input.on),
    onSuccess: (next) => queryClient.setQueryData(AGENT_MODES_KEY, next),
  });
  return (
    <details className="technical-details agent-modes__waits">
      <summary>What still waits?</summary>
      <p>In Assistant mode these actions still wait for your approval. Actions are matched on the words in their name; Channels marks the last two itself. Turn a family off only if Assistant agents may do it without asking.</p>
      <div className="agent-modes__families">
        {data.holdFamilies.map((family) => (
          <div key={family.id} className="agent-modes__family" data-testid={`hold-family-${family.id}`}>
            <label className="agent-modes__family-toggle">
              <input type="checkbox" checked={family.on} disabled={toggle.isPending} onChange={(event) => toggle.mutate({ id: family.id, on: event.target.checked })} aria-label={`${family.label} waits for you`} />
              <span><strong>{family.label}</strong><small>{family.description}</small></span>
            </label>
            {family.words?.length ? <div className="agent-modes__words">{family.words.map((word) => <code key={word}>{word}</code>)}</div> : null}
            {!family.on && <p className="agent-modes__off" role="status">{FAMILY_OFF_WARNING}</p>}
          </div>
        ))}
        <div className="agent-modes__family"><strong>Always</strong><small>Actions a connector marks as destructive, actions that need full control, and every call over the daily limits. These cannot be turned off.</small></div>
      </div>
      {toggle.error && <InlineError error={toggle.error} />}
    </details>
  );
}

function LimitsForm({ agent, onSave, saving }: { agent: AgentModeView; onSave: (caps: { dailyCap: number; connectorDailyCap: number }) => void; saving: boolean }) {
  const [dailyCap, setDailyCap] = useState(String(agent.dailyCap));
  const [connectorDailyCap, setConnectorDailyCap] = useState(String(agent.connectorDailyCap));
  const valid = /^\d+$/u.test(dailyCap) && /^\d+$/u.test(connectorDailyCap) && Number(dailyCap) >= 1 && Number(connectorDailyCap) >= 1;
  return (
    <form className="agent-modes__limits" onSubmit={(event) => { event.preventDefault(); if (valid) onSave({ dailyCap: Number(dailyCap), connectorDailyCap: Number(connectorDailyCap) }); }}>
      <label>Outward actions per day<input inputMode="numeric" value={dailyCap} onChange={(event) => setDailyCap(event.target.value)} aria-label={`Daily limit for ${agent.agentId}`} /></label>
      <label>Per connector per day<input inputMode="numeric" value={connectorDailyCap} onChange={(event) => setConnectorDailyCap(event.target.value)} aria-label={`Per connector daily limit for ${agent.agentId}`} /></label>
      <Button size="small" type="submit" disabled={!valid || saving}>Save limits</Button>
    </form>
  );
}

function AgentModeRow({ agent, data }: { agent: AgentModeView; data: AgentModesResponse }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: AGENT_MODES_KEY });
  const mode = useMutation({ mutationFn: (next: AgentApprovalMode) => updateAgentMode(agent.agentId, { mode: next }), onSuccess: refresh });
  const caps = useMutation({ mutationFn: (next: { dailyCap: number; connectorDailyCap: number }) => updateAgentMode(agent.agentId, next), onSuccess: refresh });
  const pause = useMutation({ mutationFn: (paused: boolean) => setAgentPaused(agent.agentId, paused), onSuccess: refresh });
  const error = mode.error ?? caps.error ?? pause.error;
  const connectors = Object.entries(agent.today.byConnector);
  return (
    <article className="agent-grant-row agent-modes__row" data-testid={`agent-mode-${agent.agentId}`}>
      <header className="agent-grant-row__header">
        <div className="agent-grant-row__identity">
          <span className="agent-grant-row__icon"><Bot size={17} /></span>
          <div><strong>{agent.agentId}</strong><code>{agent.mode === "assistant" ? "Assistant" : "System"}{agent.paused ? " · paused" : ""}</code></div>
        </div>
        <div className="agent-grant-row__actions">
          <div className="agent-modes__toggle" role="group" aria-label={`Approval mode for ${agent.agentId}`}>
            {(["assistant", "system"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={agent.mode === value} disabled={mode.isPending} onClick={() => agent.mode !== value && mode.mutate(value)}>
                {value === "assistant" ? "Assistant" : "System"}
              </button>
            ))}
          </div>
          <Button size="small" tone={agent.paused ? "primary" : "danger"} disabled={pause.isPending} aria-label={`${agent.paused ? "Resume" : "Pause"} ${agent.agentId}`} onClick={() => pause.mutate(!agent.paused)}>
            {agent.paused ? <Play size={14} /> : <Pause size={14} />}{agent.paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </header>
      <p className="agent-modes__copy">{MODE_COPY[agent.mode]}</p>
      {agent.paused && <p className="agent-modes__paused" role="status">Paused: every call from this agent is refused until you resume it.</p>}
      <div className="agent-grant-row__scope">
        <div><span>Today (UTC day {agent.today.day})</span><code>{agent.today.executed} of {agent.dailyCap} outward actions</code></div>
        <div><span>Per connector limit</span><code>{agent.connectorDailyCap} per day</code></div>
        <div><span>By connector</span><code>{connectors.length ? connectors.map(([pluginId, used]) => `${pluginId}: ${used}`).join(", ") : "none yet"}</code></div>
        <div><span>Limits reset</span><code>{data.limitsReset}</code></div>
      </div>
      <LimitsForm key={`${agent.dailyCap}-${agent.connectorDailyCap}`} agent={agent} saving={caps.isPending} onSave={(next) => caps.mutate(next)} />
      {error && <InlineError error={error} />}
    </article>
  );
}

export function AgentModesPanel() {
  const queryClient = useQueryClient();
  const modes = useQuery({ queryKey: AGENT_MODES_KEY, queryFn: getAgentModes, retry: false, refetchInterval: 30_000 });
  const pauseAll = useMutation({
    mutationFn: (paused: boolean) => setAllAgentsPaused(paused),
    onSuccess: (data) => queryClient.setQueryData(AGENT_MODES_KEY, data),
  });
  if (modes.isLoading) return <section className="grant-subsection"><p className="grant-catalog-state" role="status"><LoaderCircle className="spin" size={15} />Loading agent approval modes…</p></section>;
  if (modes.error) return <section className="grant-subsection"><InlineError error={modes.error} /></section>;
  const data = modes.data;
  if (!data) return null;
  return (
    <section className="grant-subsection agent-modes" aria-label="Agent approval modes">
      <div className="section-heading">
        <div><p className="eyebrow">Approval mode</p><h2>Assistant and System agents</h2></div>
        <Button size="small" tone={data.pausedAll ? "primary" : "danger"} disabled={pauseAll.isPending} onClick={() => pauseAll.mutate(!data.pausedAll)}>
          {data.pausedAll ? <Play size={14} /> : <Pause size={14} />}{data.pausedAll ? "Resume all agents" : "Pause all agents"}
        </Button>
      </div>
      <p className="section-copy">{MODE_COPY.system} {MODE_COPY.assistant} Daily limits count outward actions per UTC day and reset at 00:00 UTC. New agents start in System.</p>
      {data.governanceMode === "rules" && <div className="credential-proof"><ShieldCheck size={18} /><div><strong>A Rules service decides outward actions</strong><p>Modes apply only when Marketplace runs without Rules. Pause still stops an agent.</p></div></div>}
      {data.pausedAll && <p className="agent-modes__paused" role="status">All agents are paused. No agent call runs until you resume them.</p>}
      <WhatStillWaits data={data} />
      {pauseAll.error && <InlineError error={pauseAll.error} />}
      {data.agents.length ? (
        <div className="agent-grants-list" aria-label="Agents">{data.agents.map((agent) => <AgentModeRow key={agent.agentId} agent={agent} data={data} />)}</div>
      ) : (
        <p className="muted-detail">No agents yet. An agent appears here once it has a grant or a Portal consent.</p>
      )}
      <Tag>{data.agents.length} agents</Tag>
    </section>
  );
}
