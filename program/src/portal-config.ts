export type PortalEnvironment = Record<string, string | undefined>;

export type PortalRuntimeConfiguration = {
  issuerUrl: string | null;
  instanceProof: string | null;
  deploymentId: string | null;
  portalOrgId: string | null;
  workspaceId: string | null;
};

type Candidate = {
  name: string;
  value: string | null | undefined;
};

function normalized(value: string | null | undefined, normalize: (value: string) => string) {
  const trimmed = value?.trim();
  return trimmed ? normalize(trimmed) : null;
}

function resolveCompatibleValue(
  label: string,
  candidates: Candidate[],
  normalize: (value: string) => string = (value) => value,
) {
  const present = candidates
    .map((candidate) => ({
      ...candidate,
      value: normalized(candidate.value, normalize),
    }))
    .filter((candidate): candidate is Candidate & { value: string } => Boolean(candidate.value));
  const distinct = new Set(present.map((candidate) => candidate.value));
  if (distinct.size > 1) {
    throw new Error(
      `${label} configuration conflicts between ${present.map((candidate) => candidate.name).join(", ")}.`,
    );
  }
  return present[0]?.value ?? null;
}

const normalizeOrigin = (value: string) => value.replace(/\/+$/u, "");

export function resolvePortalRuntimeConfiguration(input: {
  env?: PortalEnvironment;
  portalIssuerUrl?: string | null;
  portalInstanceProof?: string | null;
} = {}): PortalRuntimeConfiguration {
  const env = input.env ?? process.env;
  return {
    issuerUrl: resolveCompatibleValue(
      "Portal issuer URL",
      [
        { name: "options.portalIssuerUrl", value: input.portalIssuerUrl },
        { name: "MARKETPLACE_PORTAL_ISSUER_URL", value: env.MARKETPLACE_PORTAL_ISSUER_URL },
        { name: "MARKETPLACE_PORTAL_URL", value: env.MARKETPLACE_PORTAL_URL },
        { name: "MARKETPLACE_PORTAL_ORIGIN", value: env.MARKETPLACE_PORTAL_ORIGIN },
        // Contract deployments (tealbrick.app.json) name the same value TEALBRICK_PORTAL_URL.
        { name: "TEALBRICK_PORTAL_URL", value: env.TEALBRICK_PORTAL_URL },
      ],
      normalizeOrigin,
    ),
    instanceProof: resolveCompatibleValue("Portal instance proof", [
      { name: "options.portalInstanceProof", value: input.portalInstanceProof },
      { name: "MARKETPLACE_PORTAL_INSTANCE_PROOF", value: env.MARKETPLACE_PORTAL_INSTANCE_PROOF },
      { name: "MARKETPLACE_PORTAL_INSTANCE_TOKEN", value: env.MARKETPLACE_PORTAL_INSTANCE_TOKEN },
      { name: "TEALBRICK_PORTAL_INSTANCE_PROOF", value: env.TEALBRICK_PORTAL_INSTANCE_PROOF },
    ]),
    deploymentId: resolveCompatibleValue("Portal deployment identity", [
      { name: "MARKETPLACE_PORTAL_DEPLOYMENT_ID", value: env.MARKETPLACE_PORTAL_DEPLOYMENT_ID },
      { name: "TEALBRICK_DEPLOYMENT_ID", value: env.TEALBRICK_DEPLOYMENT_ID },
    ]),
    portalOrgId: resolveCompatibleValue("Portal organization identity", [
      { name: "MARKETPLACE_PORTAL_ORG_ID", value: env.MARKETPLACE_PORTAL_ORG_ID },
      { name: "TEALBRICK_PORTAL_ORG_ID", value: env.TEALBRICK_PORTAL_ORG_ID },
    ]),
    workspaceId: resolveCompatibleValue("Portal workspace identity", [
      { name: "MARKETPLACE_PORTAL_WORKSPACE_ID", value: env.MARKETPLACE_PORTAL_WORKSPACE_ID },
    ]),
  };
}
