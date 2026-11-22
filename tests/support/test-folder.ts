import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testFolder(prefix: string): string {
  return realpathSync.native(
    mkdtempSync(join(process.env.STATE_TEST_DIR ?? tmpdir(), prefix)),
  );
}
