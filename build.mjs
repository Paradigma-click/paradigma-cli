import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist", "paradigma.mjs");
const { version } = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8"),
);

await build({
  entryPoints: [join(here, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __paradigmaRequire } from 'node:module';\nconst require = __paradigmaRequire(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`Built ${outfile} (paradigma ${version})`);
