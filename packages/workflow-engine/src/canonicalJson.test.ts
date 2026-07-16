import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { canonicalJson } from "./canonicalJson.ts";

describe("canonicalJson", () => {
  it("rejects roots that JSON cannot represent", () => {
    NodeAssert.throws(() => canonicalJson(undefined), TypeError);
    NodeAssert.throws(() => canonicalJson(() => undefined), TypeError);
    NodeAssert.throws(() => canonicalJson(Symbol("unsupported")), TypeError);
  });

  it("returns a stable string for supported JSON values", () => {
    NodeAssert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  });
});
