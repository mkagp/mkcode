import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      sourcemap: true,
      deps: {
        alwaysBundle: ["@mkcode/factory-contracts", "@mkcode/workflow-engine"],
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
    },
    test: {
      fileParallelism: false,
    },
  }),
);
