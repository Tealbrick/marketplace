import { Plug, Unplug } from "lucide-react";
import { Tag } from "@tealbrick/ui";

import { CustomConnectorsSection } from "./CustomConnectors";
import type { BrowserProviderHealth, ConnectionSummary } from "./types";
import { formatWhen, ProviderDot, statusTone, words } from "./ui";

export function ConnectionsPage({ connections, providers, onChanged }: { connections: ConnectionSummary[]; providers: Record<string, BrowserProviderHealth>; onChanged: () => void }) {
  return <section className="collection-page">
    <header><div><p className="eyebrow">External capability fabric</p><h1>Connections</h1><p>Reachability, credentials, and connected-account state are separate evidence. Healthy transport does not prove external execution.</p></div><Tag>{connections.length} records</Tag></header>
    <div className="provider-grid">{Object.entries(providers).map(([name, provider]) => <article key={name}><div><ProviderDot provider={provider} /><h2>{words(name)}</h2><Tag tone={statusTone(provider.state)}>{provider.state}</Tag></div><p>{provider.detail}</p><dl><dt>Configured</dt><dd>{provider.configured ? "Yes" : "No"}</dd><dt>Reachable</dt><dd>{provider.reachable ? `Yes${provider.statusCode ? ` · HTTP ${provider.statusCode}` : ""}` : "No"}</dd><dt>Checked</dt><dd>{formatWhen(provider.checkedAt)}</dd></dl></article>)}</div>
    <CustomConnectorsSection onChanged={onChanged} />
    <div className="connection-register"><div className="section-heading"><div><p className="eyebrow">Workspace state</p><h2>Plugin connections</h2></div></div>{connections.length ? connections.map((item) => <article key={item.pluginId}><span className="catalog-monogram">{item.displayName.slice(0, 2).toUpperCase()}</span><div><strong>{item.displayName}</strong><code>{item.pluginId}</code><p>{item.detail}</p></div><Tag tone={statusTone(item.state)}>{item.state}</Tag><span>{item.backend}</span></article>) : <div className="collection-empty compact"><Unplug /><h3>No connection records</h3><p>Install a plugin and start its provider connection from the catalog.</p></div>}</div>
    <section className="contract-gap"><Plug size={18} /><div><strong>Connection status is evidence, not execution proof</strong><p>A connected account can still be denied by Rules, a disabled binding, or the provider at dispatch time.</p></div></section>
  </section>;
}
