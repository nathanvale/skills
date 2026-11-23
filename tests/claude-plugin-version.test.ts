import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";

const installsFollowCommitsReason =
  "Claude Code uses the commit as the plugin version when no version is set; a version field stops merged changes reaching installs until someone bumps it.";

function readJsonObject(
  relativePath: string,
): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(repositoryRoot(), relativePath), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function marketplaceEntryNamed(
  marketplace: Readonly<Record<string, unknown>>,
  name: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const entries: readonly unknown[] = Array.isArray(marketplace.plugins)
    ? marketplace.plugins
    : [];
  return entries.find(
    (entry): entry is Readonly<Record<string, unknown>> =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Readonly<Record<string, unknown>>).name === name,
  );
}

test("Claude plugin manifest and its marketplace entry carry no version, so every merged commit reaches installs", () => {
  const plugin = readJsonObject(".claude-plugin/plugin.json");
  const marketplace = readJsonObject(".claude-plugin/marketplace.json");
  const entry = marketplaceEntryNamed(marketplace, plugin.name);

  const versionFields: string[] = [];
  if (Object.hasOwn(plugin, "version")) {
    versionFields.push(
      `.claude-plugin/plugin.json has "version". ${installsFollowCommitsReason}`,
    );
  }
  if (entry !== undefined && Object.hasOwn(entry, "version")) {
    versionFields.push(
      `.claude-plugin/marketplace.json entry "${String(plugin.name)}" has "version". ${installsFollowCommitsReason}`,
    );
  }

  expect({
    pluginName: plugin.name,
    marketplaceEntryFound: entry !== undefined,
    versionFields,
  }).toEqual({
    pluginName: "nathanvale-skills",
    marketplaceEntryFound: true,
    versionFields: [],
  });
});
