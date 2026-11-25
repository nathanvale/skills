import {
  type Dirent,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type FloatingSkill = {
  readonly folder: string;
  readonly name: string;
  readonly path: string;
  readonly symlinkTarget: string | null;
};

type FloatingSkillReport = {
  readonly home: string;
  readonly checkedFolders: readonly string[];
  readonly findings: readonly FloatingSkill[];
};

export const FLOATING_SKILL_REPAIR =
  "move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.";

const USER_SKILL_FOLDERS = [
  ".claude/skills",
  ".agents/skills",
  ".codex/skills",
  ".gemini/config/skills",
  ".pi/agent/skills",
] as const;

const SKIPPED_APP_FOLDERS: ReadonlySet<string> = new Set([
  ".codex/skills/.system",
  ".claude/skills/.trash",
  ".claude/skills/synced",
]);

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUntraversablePathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!Object.hasOwn(error, "code")) return false;
  const code: unknown = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function readLinkTargetOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function inspectSkillEntry(
  folder: string,
  entryPath: string,
  entryName: string,
  entryIsSymlink: boolean,
): FloatingSkill | null {
  const skillFilePath = join(entryPath, "SKILL.md");
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(skillFilePath);
  } catch (error) {
    if (isUntraversablePathError(error)) return null;
    throw error;
  }

  if (linkStat.isSymbolicLink()) {
    return {
      folder,
      name: entryName,
      path: skillFilePath,
      symlinkTarget: readLinkTargetOrNull(skillFilePath),
    };
  }

  if (!linkStat.isFile()) return null;

  return {
    folder,
    name: entryName,
    path: skillFilePath,
    symlinkTarget: entryIsSymlink ? readLinkTargetOrNull(entryPath) : null,
  };
}

function entryCanContainSkill(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): boolean {
  if (isDirectory) return true;
  if (!isSymbolicLink) return false;
  try {
    return statSync(entryPath).isDirectory();
  } catch (error) {
    if (isUntraversablePathError(error)) return false;
    throw error;
  }
}

function resolveRealPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isUntraversablePathError(error)) return null;
    throw error;
  }
}

type ScanContext = {
  readonly rootRelativeFolder: string;
  readonly visitedRealPaths: Set<string>;
  readonly findings: FloatingSkill[];
};

function scanDirectory(
  context: ScanContext,
  currentRelativeFolder: string,
  currentDirPath: string,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(currentDirPath, { withFileTypes: true });
  } catch (error) {
    if (isUntraversablePathError(error)) return;
    throw error;
  }

  const sorted = [...entries].sort((left, right) =>
    compareCodeUnit(left.name, right.name),
  );

  for (const entry of sorted) {
    const relativeEntry = `${currentRelativeFolder}/${entry.name}`;
    if (SKIPPED_APP_FOLDERS.has(relativeEntry)) continue;
    const entryPath = join(currentDirPath, entry.name);
    const isSymlink = entry.isSymbolicLink();
    if (!entryCanContainSkill(entryPath, entry.isDirectory(), isSymlink)) {
      continue;
    }
    const realEntryPath = resolveRealPathOrNull(entryPath);
    if (realEntryPath === null || context.visitedRealPaths.has(realEntryPath)) {
      continue;
    }
    context.visitedRealPaths.add(realEntryPath);
    const finding = inspectSkillEntry(
      context.rootRelativeFolder,
      entryPath,
      entry.name,
      isSymlink,
    );
    if (finding !== null) {
      context.findings.push(finding);
      continue;
    }
    scanDirectory(context, relativeEntry, entryPath);
  }
}

function scanUserSkillFolder(
  home: string,
  relativeFolder: string,
  findings: FloatingSkill[],
): void {
  const folderPath = join(home, relativeFolder);
  const realFolderPath = resolveRealPathOrNull(folderPath);
  if (realFolderPath === null) return;
  scanDirectory(
    {
      rootRelativeFolder: relativeFolder,
      visitedRealPaths: new Set([realFolderPath]),
      findings,
    },
    relativeFolder,
    folderPath,
  );
}

export function inspectUserSkillFolders(
  homeInput?: string,
): FloatingSkillReport {
  const home = resolve(homeInput ?? homedir());
  const checkedFolders = USER_SKILL_FOLDERS.map((folder) => join(home, folder));
  const findings: FloatingSkill[] = [];
  for (const relativeFolder of USER_SKILL_FOLDERS) {
    scanUserSkillFolder(home, relativeFolder, findings);
  }
  return { home, checkedFolders, findings };
}
