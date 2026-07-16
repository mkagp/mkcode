// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value));

export const digestJson = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
