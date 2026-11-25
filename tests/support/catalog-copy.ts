import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../../src/skills-catalog/skills-catalog.ts";
import { testFolder } from "./test-folder.ts";

export function withCatalogCopy(
  prefix: string,
  run: (copy: string) => void,
): void {
  const copy = testFolder(prefix);
  cpSync(join(repositoryRoot(), "skills"), join(copy, "skills"), {
    recursive: true,
  });
  cpSync(
    join(repositoryRoot(), ".claude-plugin"),
    join(copy, ".claude-plugin"),
    { recursive: true },
  );
  cpSync(join(repositoryRoot(), "plugin.json"), join(copy, "plugin.json"));
  cpSync(join(repositoryRoot(), "package.json"), join(copy, "package.json"));
  try {
    run(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
