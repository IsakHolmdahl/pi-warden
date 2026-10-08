import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

test("Pi package loads its packaged TypeScript source without a build lifecycle", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    files: string[];
    pi: { extensions: string[] };
    scripts: Record<string, string>;
  };
  assert.deepEqual(pkg.pi.extensions, ["./src/extension.ts"]);
  assert.ok(pkg.files.includes("src"));
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.scripts.prepare, undefined);
});
