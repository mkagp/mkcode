// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { describe, it } from "@effect/vitest";

import { FactoryWorkerClient, FactoryWorkerClientError } from "./factoryWorkerClient.ts";

const listen = (server: NodeHttp.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Expected TCP listener."));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });

describe("FactoryWorkerClient", () => {
  it("sends the service credential only in the authorization header and validates responses", async () => {
    const credential = "server-to-worker-test-credential";
    let observedAuthorization: string | undefined;
    const server = NodeHttp.createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          apiVersion: 1,
          workerInstanceId: "worker-test",
          schemaVersion: 1,
        }),
      );
    });
    const port = await listen(server);
    try {
      const client = new FactoryWorkerClient({
        origin: `http://127.0.0.1:${port}`,
        credential,
      });
      const health = await client.health();
      NodeAssert.equal(health.workerInstanceId, "worker-test");
      NodeAssert.equal(observedAuthorization, `Bearer ${credential}`);
      NodeAssert.equal(JSON.stringify(client), "{}");
    } finally {
      await close(server);
    }
  });

  it("returns structured worker errors without exposing the credential", async () => {
    const credential = "server-to-worker-secret-marker";
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "conflict", message: "Idempotency conflict." }));
    });
    const port = await listen(server);
    try {
      const client = new FactoryWorkerClient({
        origin: `http://127.0.0.1:${port}`,
        credential,
      });
      await NodeAssert.rejects(
        () => client.listWorkflows(),
        (cause: unknown) =>
          cause instanceof FactoryWorkerClientError &&
          cause.code === "conflict" &&
          !cause.message.includes(credential),
      );
    } finally {
      await close(server);
    }
  });

  it("rejects malformed worker error bodies instead of trusting arbitrary codes", async () => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(418, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "invented_code", message: "Untrusted response." }));
    });
    const port = await listen(server);
    try {
      const client = new FactoryWorkerClient({
        origin: `http://127.0.0.1:${port}`,
        credential: "server-to-worker-error-schema-credential",
      });
      await NodeAssert.rejects(
        () => client.listWorkflows(),
        (cause: unknown) =>
          cause instanceof FactoryWorkerClientError &&
          cause.code === "internal_error" &&
          cause.message === "Factory worker request failed.",
      );
    } finally {
      await close(server);
    }
  });

  it("aborts stalled worker requests at the configured deadline", async () => {
    const stalledFetch = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    const client = new FactoryWorkerClient({
      origin: "http://127.0.0.1:4317",
      credential: "server-to-worker-timeout-credential",
      fetch: stalledFetch as unknown as typeof fetch,
      timeoutMilliseconds: 10,
    });

    await NodeAssert.rejects(
      () => client.health(),
      (cause: unknown) =>
        cause instanceof FactoryWorkerClientError &&
        cause.status === 504 &&
        cause.message === "Factory worker request timed out.",
    );
    NodeAssert.throws(
      () =>
        new FactoryWorkerClient({
          origin: "http://127.0.0.1:4317",
          credential: "server-to-worker-timeout-credential",
          timeoutMilliseconds: 0,
        }),
      TypeError,
    );
    NodeAssert.throws(
      () =>
        new FactoryWorkerClient({
          origin: "http://127.0.0.1:4317",
          credential: "server-to-worker-timeout-credential",
          timeoutMilliseconds: 2_147_483_648,
        }),
      TypeError,
    );
  });
});
