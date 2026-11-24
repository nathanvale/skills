import {
  decodeList,
  decodePhone,
  decodeStrictList,
  decodeStringFields,
  decodeStringList,
  unwrapEnvelopePayload,
} from "../decoders/rules.ts";
import {
  asObject,
  ownArray,
  ownNumber,
  ownString,
  ownValue,
  parseChangeLane,
  parseConfidenceTier,
  parseEmailAddress,
  parseResourceName,
} from "../domain/rules.ts";
import type {
  AuditDoc,
  AuditFinding,
  AuditFindingKind,
  EvidenceDoc,
  EvidenceItem,
  EvidenceLane,
  EvidenceLaneStatus,
  SerializedIdentityAnchor,
  WebResearchQueueEntry,
} from "../domain/rules.ts";

const AUDIT_KINDS: readonly AuditFindingKind[] = [
  "phone-normalize",
  "phone-ambiguous",
  "phone-duplicate",
  "duplicate-candidate",
  "sparse-contact",
  "stale-contact",
];

function parseAuditKind(raw: string): AuditFindingKind | null {
  for (const kind of AUDIT_KINDS) {
    if (kind === raw) return kind;
  }
  return null;
}

export function decodeSerializedAnchor(
  raw: unknown,
): SerializedIdentityAnchor | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const kind = ownString(obj, "kind");
  const value = ownString(obj, "value");
  if (value === null || value.trim().length === 0) return null;
  if (kind === "e164-phone" || kind === "email" || kind === "org-domain") {
    return { kind, value };
  }
  return null;
}

function decodeAuditFinding(raw: unknown): AuditFinding | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const id = ownString(obj, "id");
  const kindRaw = ownString(obj, "kind");
  const confRaw = ownString(obj, "confidence");
  const summary = ownString(obj, "summary");
  const rawRes = decodeStringList(ownValue(obj, "resourceNames"));
  if (
    id === null ||
    kindRaw === null ||
    confRaw === null ||
    summary === null ||
    rawRes === null
  ) {
    return null;
  }
  const kind = parseAuditKind(kindRaw);
  const confidence = parseConfidenceTier(confRaw);
  if (kind === null || confidence === null) return null;
  if (!rawRes.every((rn) => parseResourceName(rn) !== null)) return null;
  const laneRaw = ownString(obj, "lane");
  const lane = laneRaw !== null ? parseChangeLane(laneRaw) : null;
  const missingRaw = ownValue(obj, "missingFields");
  const missingFields =
    missingRaw !== undefined ? decodeStringList(missingRaw) : null;
  return {
    id,
    kind,
    lane,
    confidence,
    resourceNames: rawRes,
    summary,
    ...(ownArray(obj, "normalizedPhones")
      ? {
          normalizedPhones: decodeList(
            ownValue(obj, "normalizedPhones"),
            decodePhone,
          ),
        }
      : {}),
    ...(ownArray(obj, "anchors")
      ? {
          anchors: decodeList(ownValue(obj, "anchors"), decodeSerializedAnchor),
        }
      : {}),
    ...(missingFields !== null ? { missingFields } : {}),
  };
}

export function decodeAuditDoc(raw: unknown): AuditDoc | null {
  const obj = asObject(unwrapEnvelopePayload(raw));
  if (obj === null) return null;
  if (ownString(obj, "schemaVersion") !== "contacts-audit/1") return null;
  const accountRaw = ownString(obj, "account");
  const defaultRegion = ownString(obj, "defaultRegion");
  const contactCount = ownNumber(obj, "contactCount");
  const findings = decodeStrictList(
    ownArray(obj, "findings"),
    decodeAuditFinding,
  );
  if (
    accountRaw === null ||
    defaultRegion === null ||
    contactCount === null ||
    findings === null
  ) {
    return null;
  }
  const account = parseEmailAddress(accountRaw);
  if (account === null) return null;
  return {
    schemaVersion: "contacts-audit/1",
    account: account.value,
    defaultRegion,
    contactCount,
    findings,
  };
}

export function decodeEvidenceItem(raw: unknown): EvidenceItem | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const id = ownString(obj, "id");
  const lane = ownString(obj, "lane");
  const contact = ownString(obj, "contactResourceName");
  const sourceRef = ownString(obj, "sourceRef");
  const excerpt = ownString(obj, "excerpt");
  if (
    id === null ||
    (lane !== "gmail" && lane !== "imsg" && lane !== "web") ||
    contact === null ||
    parseResourceName(contact) === null ||
    sourceRef === null ||
    excerpt === null
  ) {
    return null;
  }
  const anchorRaw = ownValue(obj, "anchor");
  const anchor =
    anchorRaw === null || anchorRaw === undefined
      ? null
      : decodeSerializedAnchor(anchorRaw);
  const sfObj = asObject(ownValue(obj, "suggestedFields"));
  const suggestedFields =
    sfObj !== null
      ? decodeStringFields(sfObj, [
          "organizationName",
          "organizationTitle",
          "organizationDomain",
          "emailAddress",
          "phoneNumber",
          "url",
          "noteLine",
        ])
      : {};
  return {
    id,
    lane,
    contactResourceName: contact,
    anchor,
    sourceRef,
    observedAt: ownString(obj, "observedAt"),
    excerpt,
    query: ownString(obj, "query"),
    suggestedFields,
  };
}

const VALID_LANE_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "skipped",
  "unsupported-os",
  "missing",
  "outdated",
  "fda-denied",
  "unavailable",
]);

function decodeLaneStatus(raw: unknown): EvidenceLaneStatus | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const status = ownString(obj, "status");
  const detail = ownString(obj, "detail");
  if (status === null || detail === null || !VALID_LANE_STATUSES.has(status)) {
    return null;
  }
  if (
    status === "ready" ||
    status === "skipped" ||
    status === "unsupported-os" ||
    status === "missing" ||
    status === "outdated" ||
    status === "fda-denied" ||
    status === "unavailable"
  ) {
    return { status, detail };
  }
  return null;
}

function decodeQueueEntry(raw: unknown): WebResearchQueueEntry | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const contactResourceName = ownString(obj, "contactResourceName");
  const anchorKind = ownString(obj, "anchorKind");
  const suggestedQuery = ownString(obj, "suggestedQuery");
  const safeQueryTerms = decodeStringList(ownValue(obj, "safeQueryTerms"));
  if (
    contactResourceName === null ||
    (anchorKind !== "org-domain" && anchorKind !== "name-plus-organization") ||
    suggestedQuery === null ||
    safeQueryTerms === null
  ) {
    return null;
  }
  return { contactResourceName, anchorKind, safeQueryTerms, suggestedQuery };
}

function decodeEvidenceLane(raw: unknown): EvidenceLane | null {
  if (raw === "gmail" || raw === "imsg" || raw === "web-queue") return raw;
  return null;
}

function decodeLanesStatusBlock(
  raw: unknown,
): EvidenceDoc["lanesStatus"] | null {
  const statusObj = asObject(raw);
  if (statusObj === null) return null;
  const gmail = decodeLaneStatus(ownValue(statusObj, "gmail"));
  const imsg = decodeLaneStatus(ownValue(statusObj, "imsg"));
  const webQueue = decodeLaneStatus(ownValue(statusObj, "webQueue"));
  if (gmail === null || imsg === null || webQueue === null) return null;
  return { gmail, imsg, webQueue };
}

export function decodeEvidenceDoc(raw: unknown): EvidenceDoc | null {
  const obj = asObject(unwrapEnvelopePayload(raw));
  if (obj === null) return null;
  if (ownString(obj, "schemaVersion") !== "contacts-evidence/1") return null;
  const accountRaw = ownString(obj, "account");
  const account = accountRaw !== null ? parseEmailAddress(accountRaw) : null;
  const lanesRequested = decodeStrictList(
    ownArray(obj, "lanesRequested"),
    decodeEvidenceLane,
  );
  const lanesStatus = decodeLanesStatusBlock(ownValue(obj, "lanesStatus"));
  const items = decodeStrictList(ownArray(obj, "items"), decodeEvidenceItem);
  const webResearchQueue = decodeStrictList(
    ownArray(obj, "webResearchQueue"),
    decodeQueueEntry,
  );
  if (
    account === null ||
    lanesRequested === null ||
    lanesStatus === null ||
    items === null ||
    webResearchQueue === null
  ) {
    return null;
  }
  return {
    schemaVersion: "contacts-evidence/1",
    account: account.value,
    lanesRequested,
    lanesStatus,
    items,
    webResearchQueue,
  };
}
