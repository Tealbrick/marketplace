import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrandMark, Button, CheckboxField, Dialog, Feedback, PageHeader, SelectField, SettingsPage, Sidebar, Tag, TextField, TextareaField, SectionNavigation } from "../src/index";
import type { FeedbackState } from "../src/index";
import "../src/tokens.css";
import "../src/components.css";
import "./style.css";

function Gallery() {
  const [route, setRoute] = useState(location.hash || "#/components");
  const [dark, setDark] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [alert, setAlert] = useState(false);
  const [name, setName] = useState("Research workspace");
  const [savedName, setSavedName] = useState(name);
  const [notice, setNotice] = useState("");
  const [settingsSection, setSettingsSection] = useState("workspace");
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);
  const dirty = name !== savedName;
  useEffect(() => { const listener = () => setRoute(location.hash || "#/components"); window.addEventListener("hashchange", listener); return () => window.removeEventListener("hashchange", listener); }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  const states: [FeedbackState, string, string][] = [
    ["loading", "Reading the latest state", "Wait for the Program response. No result has been confirmed."],
    ["empty", "Nothing needs your attention", "An empty result is different from a disconnected service."],
    ["error", "The request did not complete", "Keep the operation reference and reconcile before retrying a write."],
    ["forbidden", "This action is not permitted", "The Program denied this operation for the current identity."],
    ["unavailable", "Optional peer is unavailable", "Core local work remains available. This integration cannot run yet."],
    ["pending", "Waiting for a human decision", "No downstream action has been performed."],
    ["success", "Operation confirmed", "Only a verified result gets the confirmed state."],
  ];
  return <div className="gallery-frame" onClickCapture={event => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    const href = target?.getAttribute("href");
    if (dirty && href?.startsWith("#/") && href !== route) { event.preventDefault(); setPendingRoute(href); }
  }}>
    <a className="gallery-skip" href="#main-content">Skip to content</a>
    <Sidebar label="Interface system" brand={<><BrandMark /><span>Teal Brick<small>Interface system / 01</small></span></>} items={[
      { id: "components", label: "Components", href: "#/components", current: route === "#/components" },
      { id: "states", label: "System states", href: "#/states", current: route === "#/states" },
      { id: "settings", label: "Settings", href: "#/settings", current: route === "#/settings" },
    ]} footer={<>Shared primitives. Independent apps.<br />Local review gallery — no live data.</>} />
    <main id="main-content" tabIndex={-1} className="gallery-main">
      <div className="gallery-topline"><span>LABS / SHARED UI</span><Button size="small" onClick={() => setDark(!dark)}>{dark ? "Use light theme" : "Use dark theme"}</Button></div>
      {route === "#/settings" ? <SettingsPage description="A permanent page with explicit save and discard, shared across every miniapp. These sample values are in-memory only." dirty={dirty} actions={<><Button onClick={() => { setName(savedName); setNotice(""); }} disabled={!dirty}>Discard changes</Button><Button tone="primary" disabled={!dirty || !name.trim()} onClick={() => { setSavedName(name); setNotice("Sample settings saved in this gallery only."); }}>Save changes</Button></>}>
        <SectionNavigation items={[{ id: "workspace", label: "Workspace" }, { id: "access", label: "Access & permissions" }, { id: "unavailable", label: "Unavailable integration", disabled: true }]} current={settingsSection} onSelect={setSettingsSection} />
        {settingsSection === "workspace" ? <TextField label="Workspace display name" description="Presentation only. A name does not confer identity or permissions." value={name} onChange={e => setName(e.target.value)} error={!name.trim() ? "Enter a display name." : undefined} required /> : <Feedback state="unavailable" title="No authority service in this gallery">This sample cannot grant access or change permissions.</Feedback>}
        <p className="gallery-note" role="status">{notice || "No service credentials or account settings are stored here."}</p>
      </SettingsPage> : route === "#/states" ? <><PageHeader eyebrow="02 / Honest feedback" title="Every state has a meaning." description="No empty screen for a failed request. No success message for a pending effect. One vocabulary throughout the ecosystem." /><div className="gallery-state-grid">{states.map(([state, title, detail]) => <Feedback key={state} state={state} title={title}>{detail}</Feedback>)}</div></> : <>
        <PageHeader eyebrow="01 / Shared foundations" title="One interface. Thirteen independent apps." description="The same controls, spacing and interaction rules, whether you are reviewing a decision, configuring a connector or curating research." actions={<Tag tone="accent">Implementation preview</Tag>} />
        <section className="gallery-section"><div className="gallery-section-heading"><span>01</span><div><h2>Actions with a consistent weight</h2><p>One primary action. Distinct danger, pending and disabled states.</p></div></div><div className="gallery-actions"><Button tone="primary">Primary action</Button><Button>Secondary action</Button><Button tone="danger" onClick={() => setAlert(true)}>Review removal</Button><Button tone="ghost">Quiet action</Button><Button pending>Saving…</Button><Button disabled>Unavailable action</Button></div></section>
        <section className="gallery-section"><div className="gallery-section-heading"><span>02</span><div><h2>Forms that explain themselves</h2><p>Persistent labels, explicit validation, and one control geometry.</p></div></div><div className="gallery-form-grid"><TextField label="Display name" defaultValue="Research agent" description="A human-readable label, never an authorization claim." /><SelectField label="Review mode" defaultValue="manual"><option value="manual">Manual review</option><option value="assisted">Assisted review</option></SelectField><TextField label="Required reference" placeholder="Enter a reference" error="A reference is required to continue." required /><TextField label="Read-only identifier" defaultValue="example-workspace" disabled /><CheckboxField label="Show technical details" description="Identifiers remain readable in the shared technical typeface." defaultChecked /></div></section>
        <section className="gallery-section"><div className="gallery-form-grid"><TextareaField label="Decision context" defaultValue="A multiline explanation stays readable across miniapps." description="The same field styling as single-line inputs; resize vertically as needed." /><TextareaField label="Required rationale" error="Explain the decision before continuing." required /><TextareaField label="Recorded explanation" defaultValue="This sample is read-only, not a saved product record." readOnly /><TextareaField label="Unavailable notes" defaultValue="Waiting for permission." disabled /></div></section>
        <section className="gallery-section"><div className="gallery-section-heading"><span>03</span><div><h2>Bounded tasks, predictable dialogs</h2><p>Native modal focus containment, Escape, labeled context and focus return.</p></div></div><div className="gallery-actions"><Button onClick={() => setDialog(true)}>Open shared dialog</Button><a className="dg-button dg-button--ghost" href="#/settings">Open settings page →</a></div></section>
      </>}
      <footer className="gallery-footnote">CONTROL 4 PX / SURFACE 6 PX / DIALOG 8 PX <span>No app-specific overrides.</span></footer>
    </main>
    <Dialog open={dialog} onOpenChange={setDialog} title="Add a connection reference" description="A bounded form uses the same dialog everywhere. This gallery does not connect a real service." footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button tone="primary" onClick={() => setDialog(false)}>Keep sample reference</Button></>}><TextField label="Connection reference" autoFocus placeholder="connection-example" /><CheckboxField label="I understand this is a local sample" /></Dialog>
    <Dialog open={alert} onOpenChange={setAlert} kind="alertdialog" title="Remove this sample reference?" description="Only a gallery sample is affected. In a product, name the exact object and explain retention and reversibility." footer={<><Button autoFocus onClick={() => setAlert(false)}>Keep reference</Button><Button tone="danger" onClick={() => setAlert(false)}>Remove sample reference</Button></>} />
    <Dialog open={pendingRoute !== null} onOpenChange={open => { if (!open) setPendingRoute(null); }} title="Discard unsaved changes?" description="Your sample display-name edit has not been saved." kind="alertdialog" footer={<><Button autoFocus onClick={() => setPendingRoute(null)}>Keep editing</Button><Button tone="danger" onClick={() => { setName(savedName); location.hash = pendingRoute ?? "#/components"; setPendingRoute(null); }}>Discard and leave</Button></>} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<Gallery />);
