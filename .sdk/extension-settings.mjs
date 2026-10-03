import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "doppelganger.capability-settings.v1";
const SECRET_NAME = /(token|secret|password|api.?key)$/iu;

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function validateSettingsDeclaration(value) {
  const declaration = record(value);
  if (!declaration || declaration.schemaVersion !== VERSION) {
    invalid(`settings declaration must use ${VERSION}`);
  }
  if (declaration.state === "none" || declaration.state === "unavailable") {
    if (!["dynamic-provider", "developer-only", "none"].includes(declaration.posture)) {
      invalid(`${declaration.state} settings declaration requires an explicit posture`);
    }
    if (typeof declaration.reason !== "string" || !declaration.reason.trim()) {
      invalid(`${declaration.state} settings declaration requires a reason`);
    }
    return declaration;
  }
  if (declaration.state !== "available") {
    invalid("settings declaration state must be available, unavailable, or none");
  }
  if (declaration.posture !== "operational") {
    invalid("available settings declarations must use the operational posture");
  }
  if (
    declaration.transport !== undefined &&
    !["gateway", "desktop-runtime-bridge"].includes(declaration.transport)
  ) {
    invalid("settings declaration transport must be gateway or desktop-runtime-bridge");
  }
  for (const key of ["settingsSurfaceId", "title", "audience", "applyMode"]) {
    if (typeof declaration[key] !== "string" || !declaration[key]) {
      invalid(`available settings declaration requires ${key}`);
    }
  }
  if (!record(declaration.jsonSchema) || declaration.jsonSchema.type !== "object") {
    invalid("settings jsonSchema must describe an object");
  }
  const read = record(declaration.endpoints)?.read;
  const apply = record(declaration.endpoints)?.apply;
  if (read?.method !== "GET" || apply?.method !== "PATCH") {
    invalid("settings endpoints must provide authenticated GET and PATCH descriptors");
  }
  if (read.authentication !== "bearer" || apply.authentication !== "bearer") {
    invalid("settings endpoints must require bearer authentication");
  }
  const credentialFields = new Set();
  for (const entry of declaration.credentialReferences ?? []) {
    if (!entry.field?.endsWith("CredentialRef") || !entry.statusField?.endsWith("CredentialStatus")) {
      invalid("secret settings may expose credential references and status fields only");
    }
    credentialFields.add(entry.field);
    credentialFields.add(entry.statusField);
  }
  for (const property of Object.keys(declaration.jsonSchema.properties ?? {})) {
    if (SECRET_NAME.test(property) && !credentialFields.has(property)) {
      invalid(`secret-shaped field ${property} must be represented as a credential reference/status`);
    }
  }
  return declaration;
}

function validateProperty(name, schema, value) {
  if (schema.type === "string" && typeof value !== "string") invalid(`${name} must be a string`);
  if (schema.type === "boolean" && typeof value !== "boolean") invalid(`${name} must be a boolean`);
  if (schema.type === "integer" && !Number.isInteger(value)) invalid(`${name} must be an integer`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid(`${name} must be an array`);
    for (const item of value) validateProperty(`${name} item`, schema.items ?? {}, item);
  }
  if (schema.enum && !schema.enum.includes(value)) invalid(`${name} has an unsupported value`);
  if (schema.format === "uri") {
    try { new URL(value); } catch { invalid(`${name} must be a valid URI`); }
  }
  if (typeof value === "string" && schema.minLength && value.length < schema.minLength) {
    invalid(`${name} is too short`);
  }
  return value;
}

export function validateSettingsPatch(declarationValue, value) {
  const declaration = validateSettingsDeclaration(declarationValue);
  if (declaration.state !== "available") invalid("extension settings are not writable");
  const patch = record(value);
  if (!patch) invalid("settings patch must be an object");
  const properties = declaration.jsonSchema.properties ?? {};
  const output = {};
  for (const [name, fieldValue] of Object.entries(patch)) {
    const schema = properties[name];
    if (!schema) invalid(`unknown settings field: ${name}`);
    output[name] = validateProperty(name, schema, fieldValue);
  }
  return output;
}

function publicResult(declaration, settings) {
  const credentialStatus = {};
  const publicSettings = { ...settings };
  for (const entry of declaration.credentialReferences ?? []) {
    const configured = typeof publicSettings[entry.field] === "string" && publicSettings[entry.field].length > 0;
    delete publicSettings[entry.field];
    delete publicSettings[entry.statusField];
    credentialStatus[entry.statusField] = configured ? "configured" : "missing";
  }
  return {
    settings: publicSettings,
    credentialStatus,
    restartRequired: declaration.applyMode === "restart-required",
  };
}

export function createExtensionSettingsStore({ declaration: value, filePath, defaults = {} }) {
  const declaration = validateSettingsDeclaration(value);
  if (declaration.state !== "available") throw new Error("cannot create a store for unavailable settings");
  let cache;
  async function load() {
    if (cache) return cache;
    try {
      cache = { ...defaults, ...JSON.parse(await readFile(filePath, "utf8")) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      cache = { ...defaults };
    }
    return cache;
  }
  return {
    async read() {
      return publicResult(declaration, await load());
    },
    async patch(value) {
      const next = { ...(await load()), ...validateSettingsPatch(declaration, value) };
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
      cache = next;
      return publicResult(declaration, next);
    },
  };
}
