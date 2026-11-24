import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";

const installsFollowCommitsReason =
  "Claude Code uses the commit as the plugin version when no version is set; a version field stops merged changes reaching installs until someone bumps it.";

function readJsonObject(relativePath: string): object {
  const parsed: unknown = JSON.parse(
    readFileSync(join(repositoryRoot(), relativePath), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  return parsed;
}

function propertyOf(target: object, key: string): unknown {
  return Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;
}

function marketplaceEntryNamed(
  marketplace: object,
  name: unknown,
): object | undefined {
  const rawPlugins = propertyOf(marketplace, "plugins");
  if (!Array.isArray(rawPlugins)) return undefined;
  const entries: readonly unknown[] = rawPlugins;
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      propertyOf(entry, "name") === name
    ) {
      return entry;
    }
  }
  return undefined;
}

test("Claude plugin manifest and its marketplace entry carry no version, so every merged commit reaches installs", () => {
  const plugin = readJsonObject(".claude-plugin/plugin.json");
  const marketplace = readJsonObject(".claude-plugin/marketplace.json");
  const pluginName = propertyOf(plugin, "name");
  const entry = marketplaceEntryNamed(marketplace, pluginName);

  const versionFields: string[] = [];
  if (Object.hasOwn(plugin, "version")) {
    versionFields.push(
      `.claude-plugin/plugin.json has "version". ${installsFollowCommitsReason}`,
    );
  }
  if (entry !== undefined && Object.hasOwn(entry, "version")) {
    versionFields.push(
      `.claude-plugin/marketplace.json entry "${String(pluginName)}" has "version". ${installsFollowCommitsReason}`,
    );
  }

  expect({
    pluginName,
    marketplaceEntryFound: entry !== undefined,
    versionFields,
  }).toEqual({
    pluginName: "nathanvale-skills",
    marketplaceEntryFound: true,
    versionFields: [],
  });
});
