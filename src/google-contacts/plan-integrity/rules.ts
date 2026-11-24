import {
  canonicalJson,
  parseE164Phone,
  stripNonContactSource,
} from "../domain/rules.ts";
import type { ContactRecord, FieldMetadata } from "../domain/rules.ts";
import {
  biographyEntryWithValue,
  buildAppendedBiography,
  deriveMergedSurvivorFields,
  existingBiographyText,
} from "../merge/rules.ts";
import { entryIdentity } from "../person-fields/rules.ts";
import type { ContactListField } from "../person-fields/rules.ts";
import { phoneMatchesE164 } from "../phone/rules.ts";
import type {
  MutationPlanDoc,
  PlannedContactUpdate,
  PlannedDeleteTarget,
  PlannedMergeCluster,
  PlannedTarget,
} from "../plan-types/rules.ts";

const PRESERVED_LIST_FIELDS: readonly ContactListField[] = [
  "names",
  "phoneNumbers",
  "emailAddresses",
  "addresses",
  "organizations",
  "urls",
  "birthdays",
  "events",
  "relations",
];

function plannedUpdates(
  plan: MutationPlanDoc,
): readonly PlannedContactUpdate[] {
  return plan.updateSubBatches.flatMap((batch) => batch.updates);
}

function plannedDeletes(plan: MutationPlanDoc): readonly PlannedDeleteTarget[] {
  return plan.deleteBatches.flatMap((batch) => batch.targets);
}

function derivedRole(
  plan: MutationPlanDoc,
  resourceName: string,
  deletes: ReadonlyMap<string, PlannedDeleteTarget>,
): PlannedTarget["role"] {
  const del = deletes.get(resourceName);
  if (del !== undefined) {
    return del.clusterSurvivor !== null ? "duplicate" : "delete";
  }
  return plan.lane === "duplicate-merge" ? "survivor" : "update";
}

function validateTargetRoles(plan: MutationPlanDoc): string | null {
  const deletes = new Map(
    plannedDeletes(plan).map((del) => [del.resourceName, del]),
  );
  const mislabelled = plan.targets.find(
    (target) => target.role !== derivedRole(plan, target.resourceName, deletes),
  );
  return mislabelled === undefined
    ? null
    : `Target ${mislabelled.resourceName} role ${mislabelled.role} disagrees with the scheduled updates and deletes.`;
}

function validateMergeUpdates(
  plan: MutationPlanDoc,
  survivors: ReadonlyMap<string, PlannedMergeCluster>,
): string | null {
  const updates = plannedUpdates(plan);
  for (const update of updates) {
    const cluster = survivors.get(update.resourceName);
    if (
      cluster === undefined ||
      cluster.expectedSurvivorRevision !== update.expectedRevision
    ) {
      return `Update ${update.resourceName} is not the Survivor of a Merge cluster at its planned revision.`;
    }
  }
  return updates.length === survivors.size
    ? null
    : "Merge plan updates do not match its Merge cluster Survivors.";
}

function deleteMatchesCluster(
  del: PlannedDeleteTarget,
  cluster: PlannedMergeCluster | undefined,
): boolean {
  if (cluster === undefined || del.clusterSurvivor !== cluster.survivor) {
    return false;
  }
  const dup = cluster.duplicates.find(
    (item) => item.resourceName === del.resourceName,
  );
  return (
    dup !== undefined &&
    dup.expectedRevision === del.expectedRevision &&
    (cluster.corroboration.kind !== "human-confirmed" || del.confirmedByHuman)
  );
}

function validateMergeDeletes(plan: MutationPlanDoc): string | null {
  const owners = new Map<string, PlannedMergeCluster>();
  for (const cluster of plan.mergeClusters) {
    for (const dup of cluster.duplicates) owners.set(dup.resourceName, cluster);
  }
  const deletes = plannedDeletes(plan);
  const stray = deletes.find(
    (del) => !deleteMatchesCluster(del, owners.get(del.resourceName)),
  );
  if (stray !== undefined) {
    return `Delete target ${stray.resourceName} is not a Duplicate of the Merge cluster it names.`;
  }
  return deletes.length === owners.size
    ? null
    : "Merge plan deletes do not match its Merge cluster Duplicates.";
}

export function validatePlanMembership(plan: MutationPlanDoc): string | null {
  if (plan.lane !== "duplicate-merge") {
    const linked = plannedDeletes(plan).find(
      (del) => del.clusterSurvivor !== null,
    );
    if (linked !== undefined) {
      return `Delete target ${linked.resourceName} names a Merge cluster outside duplicate-merge.`;
    }
    return validateTargetRoles(plan);
  }
  const survivors = new Map(
    plan.mergeClusters.map((cluster) => [cluster.survivor, cluster]),
  );
  return (
    validateMergeUpdates(plan, survivors) ??
    validateMergeDeletes(plan) ??
    validateTargetRoles(plan)
  );
}

function liveOwnedList(
  contact: ContactRecord,
  field: ContactListField,
): readonly object[] {
  const entries: readonly { readonly metadata?: FieldMetadata }[] =
    contact[field];
  return stripNonContactSource(entries);
}

function verifyListsPreserveLive(
  update: PlannedContactUpdate,
  contact: ContactRecord,
): string | null {
  for (const field of PRESERVED_LIST_FIELDS) {
    const planned: readonly object[] | undefined = update.fields[field];
    if (planned === undefined) continue;
    const kept = new Set(planned.map((entry) => entryIdentity(field, entry)));
    const lost = liveOwnedList(contact, field).find(
      (entry) => !kept.has(entryIdentity(field, entry)),
    );
    if (lost !== undefined) {
      return `Update for ${update.resourceName} drops a live ${field} entry.`;
    }
  }
  return null;
}

function verifyPhonesAgainstLive(
  update: PlannedContactUpdate,
  contact: ContactRecord,
): string | null {
  const planned = update.fields.phoneNumbers ?? [];
  const live = stripNonContactSource(contact.phoneNumbers);
  const liveIds = new Set(live.map((p) => entryIdentity("phoneNumbers", p)));
  const invented = planned.find(
    (p) =>
      parseE164Phone(p.value) === null &&
      !liveIds.has(entryIdentity("phoneNumbers", p)),
  );
  if (invented !== undefined) {
    return `phone-normalize update for ${update.resourceName} writes non-E.164 phone ${invented.value} that is not on the live Contact.`;
  }
  const lost = live.find(
    (liveP) =>
      !planned.some(
        (p) =>
          entryIdentity("phoneNumbers", p) ===
            entryIdentity("phoneNumbers", liveP) ||
          (parseE164Phone(p.value) !== null &&
            phoneMatchesE164(liveP.value, p.value)),
      ),
  );
  return lost === undefined
    ? null
    : `phone-normalize update for ${update.resourceName} drops live phone ${lost.value}.`;
}

function verifyNoteAgainstLive(
  update: PlannedContactUpdate,
  contact: ContactRecord,
): string | null {
  const liveBio = existingBiographyText(contact);
  const planned = update.fields.biographies ?? [];
  const expected =
    update.appendedLine === null
      ? null
      : biographyEntryWithValue(
          [contact],
          buildAppendedBiography(liveBio, update.appendedLine).value,
        );
  return update.existingBiography === liveBio &&
    planned.length === 1 &&
    planned[0] !== undefined &&
    expected !== null &&
    entryIdentity("biographies", planned[0]) ===
      entryIdentity("biographies", expected)
    ? null
    : `note-append update for ${update.resourceName} is not the live CONTACT biography with its appended line.`;
}

function verifyClusterAgainstLive(
  cluster: PlannedMergeCluster,
  update: PlannedContactUpdate | undefined,
  live: ReadonlyMap<string, ContactRecord>,
): string | null {
  const survivor = live.get(cluster.survivor);
  const duplicates = cluster.duplicates.map((dup) =>
    live.get(dup.resourceName),
  );
  const liveDups = duplicates.filter((dup) => dup !== undefined);
  if (
    survivor === undefined ||
    update === undefined ||
    liveDups.length !== duplicates.length
  ) {
    return `Merge cluster for ${cluster.survivor} is missing a live Contact.`;
  }
  const derived = deriveMergedSurvivorFields(survivor, liveDups);
  if (!derived.ok) return derived.reason;
  const matches =
    derived.provenanceLine === cluster.provenanceLine &&
    update.appendedLine === derived.provenanceLine &&
    update.existingBiography === existingBiographyText(survivor) &&
    canonicalJson(update.fields) === canonicalJson(derived.fields);
  return matches
    ? null
    : `Survivor ${cluster.survivor} update is not the lossless merge of the live Survivor and Duplicates.`;
}

function verifyMergeAgainstLive(
  plan: MutationPlanDoc,
  live: ReadonlyMap<string, ContactRecord>,
): string | null {
  const updates = new Map(
    plannedUpdates(plan).map((update) => [update.resourceName, update]),
  );
  for (const cluster of plan.mergeClusters) {
    const err = verifyClusterAgainstLive(
      cluster,
      updates.get(cluster.survivor),
      live,
    );
    if (err !== null) return err;
  }
  return null;
}

function verifyUpdateAgainstLive(
  lane: MutationPlanDoc["lane"],
  update: PlannedContactUpdate,
  contact: ContactRecord,
): string | null {
  if (lane === "note-append") return verifyNoteAgainstLive(update, contact);
  if (lane === "phone-normalize") {
    return verifyPhonesAgainstLive(update, contact);
  }
  return verifyListsPreserveLive(update, contact);
}

export function verifyPlanAgainstLive(
  plan: MutationPlanDoc,
  live: ReadonlyMap<string, ContactRecord>,
): string | null {
  if (plan.lane === "duplicate-merge")
    return verifyMergeAgainstLive(plan, live);
  for (const update of plannedUpdates(plan)) {
    const contact = live.get(update.resourceName);
    if (contact === undefined) {
      return `Update target ${update.resourceName} is missing from live read.`;
    }
    const err = verifyUpdateAgainstLive(plan.lane, update, contact);
    if (err !== null) return err;
  }
  return null;
}
