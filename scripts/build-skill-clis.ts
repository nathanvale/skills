import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillCliSpec = {
  readonly kind?: "contract" | "runtime-factory";
  readonly name: string;
  readonly sourceModule: string;
  readonly exportName: string;
  readonly outputFile: string;
};

export const SKILL_CLIS: readonly SkillCliSpec[] = [
  {
    name: "hello-world",
    sourceModule: "src/skill-clis/hello-world.ts",
    exportName: "helloWorldContract",
    outputFile: "skills/engineering/hello-world/dist/cli.mjs",
  },
  {
    kind: "runtime-factory",
    name: "google-contacts",
    sourceModule: "src/google-contacts/cli.ts",
    exportName: "createGoogleContactsCli",
    outputFile: "skills/in-progress/google-contacts/dist/cli.mjs",
  },
];

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type BuildSkillCliResult = {
  readonly name: string;
  readonly outputFile: string;
  readonly bytes: number;
  readonly upToDate: boolean;
};

export async function renderSkillCliBundle(
  spec: SkillCliSpec,
  root = REPOSITORY_ROOT,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "skills-cli-build-"));
  try {
    const kernelEntry = fileURLToPath(import.meta.resolve("agent-cli-kernel"))
      .split("\\")
      .join("/");
    const sourcePath = resolve(root, spec.sourceModule).split("\\").join("/");
    const entryPath = join(scratch, "entry.ts");
    const entrySource =
      spec.kind === "runtime-factory"
        ? [
            `import { runProcess } from ${JSON.stringify(kernelEntry)};`,
            `import { ${spec.exportName} } from ${JSON.stringify(sourcePath)};`,
            `const runtime = ${spec.exportName}();`,
            "await runProcess(runtime.contract, runtime.setup)(process.argv.slice(2));",
            "",
          ].join("\n")
        : [
            `import { runProcess } from ${JSON.stringify(kernelEntry)};`,
            `import { ${spec.exportName} } from ${JSON.stringify(sourcePath)};`,
            `await runProcess(${spec.exportName})(process.argv.slice(2));`,
            "",
          ].join("\n");
    writeFileSync(entryPath, entrySource, "utf8");
    const built = await Bun.build({
      entrypoints: [entryPath],
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!built.success) {
      const reasons = built.logs.map((entry) => entry.message).join("; ");
      throw new Error(
        `Failed to bundle ${spec.name}: ${reasons || "unknown Bun.build failure"}`,
      );
    }
    const artifact = built.outputs[0];
    if (artifact === undefined) {
      throw new Error(`Bun.build produced no output for ${spec.name}`);
    }
    return await artifact.text();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function buildSkillClis(options?: {
  readonly check?: boolean;
  readonly root?: string;
}): Promise<readonly BuildSkillCliResult[]> {
  const root = options?.root ?? REPOSITORY_ROOT;
  const checkOnly = options?.check === true;
  const results: BuildSkillCliResult[] = [];
  for (const spec of SKILL_CLIS) {
    const rendered = await renderSkillCliBundle(spec, root);
    const destination = resolve(root, spec.outputFile);
    const existing = existsSync(destination)
      ? readFileSync(destination, "utf8")
      : null;
    const upToDate = existing === rendered;
    if (!checkOnly && !upToDate) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, rendered, "utf8");
    }
    results.push({
      name: spec.name,
      outputFile: spec.outputFile,
      bytes: Buffer.byteLength(rendered, "utf8"),
      upToDate,
    });
  }
  return results;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const results = await buildSkillClis({ check });
  if (check) {
    const stale = results.filter((item) => !item.upToDate);
    if (stale.length > 0) {
      const names = stale.map((item) => item.outputFile).join(", ");
      process.stderr.write(
        `Stale portable skill CLI bundle(s): ${names}. Repair: run bun run build:skills.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `Verified ${String(results.length)} portable skill CLI bundle(s) are up to date.\n`,
    );
  } else {
    for (const item of results) {
      process.stdout.write(
        `Built ${item.outputFile} (${String(item.bytes)} bytes)\n`,
      );
    }
  }
}
