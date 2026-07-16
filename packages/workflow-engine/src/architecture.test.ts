// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, it } from "@effect/vitest";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const readPackage = async (path: string) =>
  JSON.parse(
    await NodeFSP.readFile(NodePath.join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };

const sourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const result: Array<string> = [];
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
    const path = NodePath.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) result.push(path);
  }
  return result;
};

const dependencyVersion = (
  packageJson: Awaited<ReturnType<typeof readPackage>>,
  dependency: string,
): string | undefined =>
  packageJson.dependencies?.[dependency] ?? packageJson.devDependencies?.[dependency];

describe("factory architecture boundaries", () => {
  it("keeps persistence out of the browser server and UI dependencies out of the worker", async () => {
    const server = await readPackage("apps/server");
    const web = await readPackage("apps/web");
    const worker = await readPackage("apps/factory-worker");
    const engine = await readPackage("packages/workflow-engine");

    NodeAssert.equal(dependencyVersion(server, "@mkcode/workflow-engine"), undefined);
    NodeAssert.equal(dependencyVersion(server, "@mkcode/factory-worker"), undefined);
    NodeAssert.equal(dependencyVersion(web, "@mkcode/workflow-engine"), undefined);
    NodeAssert.equal(dependencyVersion(web, "@mkcode/factory-worker"), undefined);
    NodeAssert.equal(dependencyVersion(worker, "@t3tools/web"), undefined);
    NodeAssert.equal(dependencyVersion(worker, "react"), undefined);
    NodeAssert.equal(dependencyVersion(engine, "@t3tools/contracts"), undefined);
    NodeAssert.equal(dependencyVersion(engine, "@t3tools/web"), undefined);
  });

  it("contains no process, command, Git, worktree, or provider launcher in worker production code", async () => {
    const files = await sourceFiles(NodePath.join(repositoryRoot, "apps/factory-worker/src"));
    const productionSource = (
      await Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8")))
    ).join("\n");
    for (const forbidden of [
      "node:child_process",
      "execa",
      "spawn(",
      "execFile(",
      "git worktree",
      "Claude",
      "Codex",
      "OpenCode",
      "Herdr",
    ]) {
      NodeAssert.equal(
        productionSource.includes(forbidden),
        false,
        `Worker production code unexpectedly contains '${forbidden}'.`,
      );
    }
  });

  it("does not add factory tables to interactive server migrations", async () => {
    const migrationRoot = NodePath.join(repositoryRoot, "apps/server/src/persistence/Migrations");
    const files = await sourceFiles(migrationRoot);
    const migrationSource = (
      await Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8")))
    ).join("\n");
    for (const table of [
      "workflow_runs",
      "stage_runs",
      "job_intents",
      "idempotency_records",
      "workflow_events",
    ]) {
      NodeAssert.equal(migrationSource.includes(table), false);
    }
  });
});
