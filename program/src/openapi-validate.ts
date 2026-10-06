/**
 * Argument validation for Company Box operations: every call's arguments are
 * checked against the operation's full input schema before any request is
 * built. Types are strict (no coercion); `additionalProperties` follows the
 * schema (argument groups are closed). Vendor keywords (`x-*`, OpenAPI
 * `example`, `discriminator`, …) are ignored, and formats are not asserted.
 */
import AjvModule, { type Options as AjvOptions, type ValidateFunction } from "ajv";

import type { JsonSchema } from "./openapi-adapter.js";

// ajv ships CommonJS with a default export; normalize for NodeNext + esbuild.
type AjvInstance = { compile: (schema: object) => ValidateFunction };
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (
  options: AjvOptions,
) => AjvInstance;

export type ArgumentValidation = { ok: true } | { ok: false; field: string; reason: string };
export type ArgumentValidator = (args: Record<string, unknown>) => ArgumentValidation;

function newAjv() {
  return new Ajv({
    strict: false,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false,
    validateSchema: false,
  });
}

/** Compile once per operation. Throws when the schema itself cannot compile. */
export function compileArgumentValidator(schema: JsonSchema): ArgumentValidator {
  const validate = newAjv().compile(schema);
  return (args) => {
    if (validate(args)) return { ok: true };
    const error = validate.errors?.[0];
    const path = (error?.instancePath ?? "").split("/").filter(Boolean).join(".");
    const missing =
      error?.keyword === "required" && typeof error.params?.missingProperty === "string"
        ? error.params.missingProperty
        : error?.keyword === "additionalProperties" && typeof error.params?.additionalProperty === "string"
          ? error.params.additionalProperty
          : null;
    return {
      ok: false,
      field: [path, missing].filter(Boolean).join(".") || "arguments",
      reason: error?.keyword === "additionalProperties" ? "not declared by the operation" : (error?.message ?? "invalid"),
    };
  };
}
