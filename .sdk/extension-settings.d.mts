export type ExtensionSettingsEndpoint<Method extends "GET" | "PATCH"> = {
  method: Method;
  path: `/${string}`;
  authentication: "bearer";
};

export type ExtensionSettingsDeclaration =
  | {
      schemaVersion: "doppelganger.capability-settings.v1";
      state: "none" | "unavailable";
      posture: "dynamic-provider" | "developer-only" | "none";
      reason: string;
    }
  | {
      schemaVersion: "doppelganger.capability-settings.v1";
      state: "available";
      posture: "operational";
      settingsSurfaceId: string;
      title: string;
      description?: string;
      audience: "normal" | "developer";
      jsonSchema: Record<string, unknown>;
      uiSchema?: Record<string, unknown>;
      credentialReferences?: Array<{
        field: `${string}CredentialRef`;
        statusField: `${string}CredentialStatus`;
      }>;
      endpoints: {
        read: ExtensionSettingsEndpoint<"GET">;
        apply: ExtensionSettingsEndpoint<"PATCH">;
      };
      applyMode: "live" | "reload-required" | "restart-required";
    };

export function validateSettingsDeclaration(value: unknown): ExtensionSettingsDeclaration;
export function validateSettingsPatch(
  declaration: ExtensionSettingsDeclaration,
  value: unknown,
): Record<string, unknown>;
export function createExtensionSettingsStore(options: {
  declaration: ExtensionSettingsDeclaration;
  filePath: string;
  defaults?: Record<string, unknown>;
}): {
  read(): Promise<{ settings: Record<string, unknown>; credentialStatus: Record<string, string>; restartRequired: boolean }>;
  patch(value: unknown): Promise<{ settings: Record<string, unknown>; credentialStatus: Record<string, string>; restartRequired: boolean }>;
};
