import { ResolvedProjectConfiguration } from "@mkcode/project-config/schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectRegistration } from "./projectRegistry.ts";

const decodeResolvedProjectConfiguration = Schema.decodeUnknownEffect(ResolvedProjectConfiguration);
const decodeProjectRegistration = Schema.decodeUnknownEffect(ProjectRegistration);
const encodeProjectRegistration = Schema.encodeUnknownEffect(ProjectRegistration);

it.effect("project registration contracts serialize only safe configuration references", () =>
  Effect.gen(function* () {
    const snapshot = yield* decodeResolvedProjectConfiguration({
      version: 1,
      project: { id: "safe-project", name: "Safe Project" },
      repository: {
        baseBranch: "main",
        root: "/repos/safe-project",
        worktreeRoot: "/repos/safe-project/.mkcode/worktrees",
        contextFiles: [],
      },
      setup: [
        {
          id: "install",
          executable: "pnpm",
          args: ["install"],
          workingDirectory: ".",
          resolvedWorkingDirectory: "/repos/safe-project",
          timeoutSeconds: 300,
          environment: [
            { name: "NPM_TOKEN", source: "NPM_TOKEN", value: "must-not-survive-decoding" },
          ],
          artifacts: [],
        },
      ],
      checks: [],
      workflows: { allowed: ["feature"] },
      execution: { defaultProfile: "coding-workhorse" },
      sourcePath: "/repos/safe-project/.mkcode/project.yaml",
      contentDigest: "a".repeat(64),
    });
    const registration = yield* decodeProjectRegistration({
      projectId: "safe-project",
      repositoryPath: "/repos/safe-project",
      enabled: true,
      displayName: "Safe Project",
      addedAt: "2026-07-16T00:00:00.000Z",
      lastValidatedAt: "2026-07-16T00:00:00.000Z",
      validationStatus: "valid",
      configurationFileLocation: snapshot.sourcePath,
      configurationDigest: snapshot.contentDigest,
      resolvedConfiguration: snapshot,
      validationErrors: [],
    });
    const encoded = yield* encodeProjectRegistration(registration);

    assert.deepEqual(encoded.resolvedConfiguration.setup[0]?.environment, [
      { name: "NPM_TOKEN", source: "NPM_TOKEN" },
    ]);
    assert.notProperty(encoded.resolvedConfiguration.setup[0]?.environment[0] ?? {}, "value");
  }),
);
