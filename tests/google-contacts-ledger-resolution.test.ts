import { expect, test } from "bun:test";
import {
  contactScopeKey,
  resolveLedgerRoot,
} from "../src/google-contacts/ledger.ts";

test("ledger resolution walks explicit dir, suite data home, XDG data home, then HOME, ignoring relative and empty values", () => {
  const explicit = "/abs/ledger-explicit";
  const suite = "/abs/suite-data";
  const xdgData = "/abs/xdg-data";
  const home = "/abs/home";
  const rows: readonly {
    readonly name: string;
    readonly env: Readonly<Record<string, string>>;
    readonly expected: unknown;
  }[] = [
    {
      name: "explicit absolute dir wins over every home",
      env: {
        GOOGLE_CONTACTS_LEDGER_DIR: explicit,
        NATHANVALE_SKILLS_DATA_HOME: suite,
        XDG_DATA_HOME: xdgData,
        HOME: home,
      },
      expected: {
        ok: true,
        root: "/abs/ledger-explicit",
        source: "GOOGLE_CONTACTS_LEDGER_DIR",
      },
    },
    {
      name: "relative explicit dir is refused",
      env: {
        GOOGLE_CONTACTS_LEDGER_DIR: "rel/ledger",
        NATHANVALE_SKILLS_DATA_HOME: suite,
        HOME: home,
      },
      expected: { ok: false, reason: "relative-ledger-dir" },
    },
    {
      name: "empty explicit dir falls through to the suite data home",
      env: {
        GOOGLE_CONTACTS_LEDGER_DIR: "",
        NATHANVALE_SKILLS_DATA_HOME: suite,
        XDG_DATA_HOME: xdgData,
        HOME: home,
      },
      expected: {
        ok: true,
        root: "/abs/suite-data/google-contacts/ledger",
        source: "NATHANVALE_SKILLS_DATA_HOME",
      },
    },
    {
      name: "relative suite data home falls through to XDG data home",
      env: {
        NATHANVALE_SKILLS_DATA_HOME: "rel/suite",
        XDG_DATA_HOME: xdgData,
        HOME: home,
      },
      expected: {
        ok: true,
        root: "/abs/xdg-data/nathanvale-skills/google-contacts/ledger",
        source: "XDG_DATA_HOME",
      },
    },
    {
      name: "empty suite data home falls through to XDG data home",
      env: {
        NATHANVALE_SKILLS_DATA_HOME: "",
        XDG_DATA_HOME: xdgData,
        HOME: home,
      },
      expected: {
        ok: true,
        root: "/abs/xdg-data/nathanvale-skills/google-contacts/ledger",
        source: "XDG_DATA_HOME",
      },
    },
    {
      name: "relative XDG data home falls through to HOME",
      env: { XDG_DATA_HOME: "rel/xdg", HOME: home },
      expected: {
        ok: true,
        root: "/abs/home/.local/share/nathanvale-skills/google-contacts/ledger",
        source: "HOME",
      },
    },
    {
      name: "empty XDG data home falls through to HOME",
      env: { XDG_DATA_HOME: "", HOME: home },
      expected: {
        ok: true,
        root: "/abs/home/.local/share/nathanvale-skills/google-contacts/ledger",
        source: "HOME",
      },
    },
    {
      name: "XDG state home no longer moves the ledger",
      env: { XDG_STATE_HOME: "/abs/xdg-state", HOME: home },
      expected: {
        ok: true,
        root: "/abs/home/.local/share/nathanvale-skills/google-contacts/ledger",
        source: "HOME",
      },
    },
    {
      name: "relative HOME with no other home is refused",
      env: { XDG_DATA_HOME: "rel", HOME: "rel/home" },
      expected: { ok: false, reason: "invalid-home" },
    },
  ];
  expect(rows.length).toBe(9);
  expect(
    rows.map((row) => ({
      row: row.name,
      resolved: resolveLedgerRoot(row.env),
    })),
  ).toMatchObject(
    rows.map((row) => ({ row: row.name, resolved: row.expected })),
  );
});

test("contact scope keys keep a short lowered account and hash a long one", () => {
  const key = contactScopeKey("Owner@Example.COM", "people/c1");
  expect(key).toBe("owner@example.com:people/c1");
  const longKey = contactScopeKey(
    `${"a".repeat(250)}@example.com`,
    "people/c1",
  );
  expect(longKey.startsWith("acct-")).toBe(true);
  expect(longKey.length).toBeLessThanOrEqual(256);
});
