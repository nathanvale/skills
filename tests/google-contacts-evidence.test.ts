import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../src/google-contacts/cli.ts";
import type { GoogleContactsCliOptions } from "../src/google-contacts/cli.ts";
import {
  createGogStub,
  createImsgStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";

setDefaultTimeout(30_000);

async function runCli(
  options: GoogleContactsCliOptions,
  argv: readonly string[],
) {
  const cli = createGoogleContactsCli(options);
  const ran = await runInProcess(cli.contract, cli.setup)(argv);
  if (ran.kind !== "envelope") {
    throw new Error(`Expected envelope, got ${ran.kind}.`);
  }
  return ran.envelope.result;
}

test("evidence verifies Gmail flags, empty exit 3, macOS imsg ready/degraded/exclusive refusal, and truncated stdout", async () => {
  const dir = testFolder("gc-ev-all-");
  try {
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") };
    const orgContact = sampleContact("c1", {
      phoneNumbers: [{ value: "+61491570120", type: "mobile" }],
      emailAddresses: [{ value: "c1@acme.example.com", type: "work" }],
      organizations: [{ name: "Acme", domain: "acme.example.com" }],
    });
    const bareContact = sampleContact("bare", {
      names: [{ displayName: "Private Name" }],
      phoneNumbers: [{ value: "+61491570121", type: "mobile" }],
      emailAddresses: [],
      organizations: [],
    });
    const snapFile = join(dir, "snap.json");
    writeFileSync(
      snapFile,
      JSON.stringify(sampleSnapshot([orgContact, bareContact])),
      "utf8",
    );

    const emptyGmailDir = join(dir, "empty-gmail");
    mkdirSync(emptyGmailDir, { recursive: true });
    const emptyGog = createGogStub(emptyGmailDir, {
      account: "owner@example.com",
      contacts: [],
      gmailThreads: {},
    });
    const imsgReady = createImsgStub(emptyGmailDir, {
      version: "0.21.1",
      chats: [{ id: "chat-7", identifier: "+61491570120" }],
      history: [{ id: "m1", text: "See you at Acme", date: "2026-11-22" }],
    });
    const combined = await runCli(
      {
        env,
        platform: "darwin",
        gogBin: emptyGog.binPath,
        imsgBin: imsgReady,
      },
      [
        "evidence",
        "--snapshot",
        snapFile,
        "--max-chats",
        "100",
        "--max-messages",
        "5",
      ],
    );
    expect(combined.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(combined.data).toMatchObject({
      lanesStatus: {
        gmail: { status: "ready" },
        imsg: { status: "ready" },
        webQueue: { status: "ready" },
      },
      items: [
        {
          lane: "imsg",
          contactResourceName: "people/c1",
          sourceRef: "imsg:chat/chat-7/msg/m1",
        },
      ],
      webResearchQueue: [{ contactResourceName: "people/c1" }],
    });
    const gmailLog = emptyGog
      .readLog()
      .find((entry) => entry.args.includes("gmail"));
    for (const expectedArg of [
      "--ids-only",
      "--max",
      "500",
      "--readonly",
      "--gmail-no-send",
      "--wrap-untrusted",
      "--enable-commands-exact=gmail.search",
    ]) {
      expect(gmailLog?.args).toContain(expectedArg);
    }

    const fdaDir = join(dir, "fda-imsg");
    mkdirSync(fdaDir, { recursive: true });
    const fdaImsg = createImsgStub(fdaDir, { chatsExit: 1 });
    const degraded = await runCli(
      {
        env,
        platform: "darwin",
        gogBin: emptyGog.binPath,
        imsgBin: fdaImsg,
      },
      ["evidence", "--snapshot", snapFile],
    );
    expect(degraded.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(degraded.data).toMatchObject({
      lanesStatus: { imsg: { status: "fda-denied" } },
    });

    expect(
      (
        await runCli(
          {
            env,
            platform: "darwin",
            gogBin: emptyGog.binPath,
            imsgBin: fdaImsg,
          },
          ["evidence", "--snapshot", snapFile, "--lane", "imsg"],
        )
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_LANE_UNAVAILABLE");

    const truncDir = join(dir, "trunc-gmail");
    mkdirSync(truncDir, { recursive: true });
    const truncGog = createGogStub(truncDir, {
      account: "owner@example.com",
      contacts: [],
      behavior: { gmailSearchTruncate: true },
    });
    expect(
      (
        await runCli({ env, platform: "linux", gogBin: truncGog.binPath }, [
          "evidence",
          "--snapshot",
          snapFile,
          "--lane",
          "gmail",
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_LANE_UNAVAILABLE");
  } finally {
    removeOwnedFolder(dir);
  }
});
