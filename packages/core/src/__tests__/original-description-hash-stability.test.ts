import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computePlanApprovalFingerprint } from "../planner/plan-approval.js";
import { canonicalizePlan } from "../planner/spec-lock.js";
import {
  ORIGINAL_DESCRIPTION_ENCODING_MARKER,
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_ESCAPE_PREFIX,
  ORIGINAL_DESCRIPTION_START_MARKER,
  applyOriginalDescription,
  resolveOriginalDescriptionSection,
} from "../tasks/original-description-policy.js";
import { stripOriginalDescriptionSection } from "../tasks/original-description-region.js";

/*
FNXC:SpecLock 2026-10-11-16:40:
Spec-lock content hashes, section hashes and plan-approval fingerprints are persisted, so a change to the Original Description resolver must not move them for any prompt that hygiene wrapped.
The values below were computed on the tree before the positional-opener change and are literals on purpose: recomputing them at test time would pin nothing.
Never edit them to make a resolver change pass; a mismatch means stored locks and approvals would silently break.
*/

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const plan = [
  "# Task: KB-1 - Safe widget",
  "",
  "**Created:** 2026-10-11",
  "**Size:** M",
  "",
  "## What This Delivers",
  "",
  "- A safe widget.",
  "",
  "## Mission",
  "",
  "Build a safe widget.",
  "",
  "## File Scope",
  "",
  "- src/widget.ts",
  "",
  "## Steps",
  "",
  "1. Build widget",
  "",
  "## Completion Criteria",
  "",
  "- [ ] Widget works",
  "",
  "## Do NOT",
  "",
  "- Change API",
  "",
  "## Dependencies",
  "",
  "- **None**",
  "",
].join("\n");

const lockableAliases = [
  "Mission", "File Scope", "Steps", "Completion Criteria", "Acceptance Criteria",
  "Do NOT", "Non-Goals", "Dependencies", "Mission Lineage", "Parent-Child Lineage",
];

const embeddedHeadingsBody = [
  "Operator request.",
  ...lockableAliases.map((alias) => `## ${alias}\n\nOperator prose under ${alias}.`),
].join("\n\n");

const reservedTokensBody = [
  "Operator request quoting reserved tokens.",
  `Start: ${ORIGINAL_DESCRIPTION_START_MARKER}`,
  `End: ${ORIGINAL_DESCRIPTION_END_MARKER}`,
  `Encoding: ${ORIGINAL_DESCRIPTION_ENCODING_MARKER}`,
  `Escape: ${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}start -->`,
].join("\n");

const unmarked = (sectionBody: string): string => plan.replace(
  "## What This Delivers",
  `## Original Description\n\n${sectionBody}\n\n## What This Delivers`,
);

const encoded = applyOriginalDescription(plan, reservedTokensBody);

const corpus: Record<string, string> = {
  "plain body": applyOriginalDescription(plan, "Build a widget please."),
  "empty body": applyOriginalDescription(plan, ""),
  "embedded lockable headings": applyOriginalDescription(plan, embeddedHeadingsBody),
  "encoded reserved tokens": encoded,
  "encoded reserved tokens CRLF": encoded.replace(/\n/g, "\r\n"),
  "envelope followed by an unlisted heading": applyOriginalDescription(
    plan.replace("## What This Delivers", "## Custom Notes\n\nPlanner notes.\n\n## What This Delivers"),
    "Build a widget please.",
  ),
  "positional opener without end marker": plan.replace(
    "## What This Delivers",
    `## Original Description\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nBuild a widget please.\n\n## What This Delivers`,
  ),
  "marked section then plan prose quoting the start marker": applyOriginalDescription(
    plan.replace("1. Build widget", `1. Build widget\n2. Keep the \`${ORIGINAL_DESCRIPTION_START_MARKER}\` marker intact`),
    "Build a widget please.",
  ),
  "legacy bare unmarked": unmarked("Build a widget please.\n\n## Notes\n\nOperator notes."),
  "legacy fenced unmarked": unmarked("```text\nBuild a widget please.\n## Mission\nquoted\n```"),
};

interface Pinned {
  kind: string;
  status: string;
  reason?: string;
  contentHash?: string;
  sections: Record<string, string | undefined>;
  fingerprint: string;
  strip: string;
}

function measure(prompt: string): Pinned {
  const canonical = canonicalizePlan(prompt);
  return {
    kind: resolveOriginalDescriptionSection(prompt).kind,
    status: canonical.status,
    ...(canonical.reason ? { reason: canonical.reason } : {}),
    ...(canonical.contentHash ? { contentHash: canonical.contentHash } : {}),
    sections: Object.fromEntries(Object.entries(canonical.sections).map(([key, section]) => [key, section.hash ?? section.status])),
    fingerprint: computePlanApprovalFingerprint(prompt),
    strip: sha256(stripOriginalDescriptionSection(prompt)),
  };
}

const PINNED: Record<string, Pinned> = {
  "plain body": {
    kind: "marked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
  "empty body": {
    kind: "marked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
  "embedded lockable headings": {
    kind: "marked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
  "encoded reserved tokens": {
    kind: "marked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
  "encoded reserved tokens CRLF": {
    kind: "unresolved-marker",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "283932cbc9be75a631426657b477d9066802b05ac956397eee8a3776fae3f1e4",
    strip: "77fd614e3bddbdaf8c68ecfd63a75b485b2fa3a87a89b05444829938483bedb8",
  },
  "envelope followed by an unlisted heading": {
    kind: "unresolved-marker",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "4f98420291f794ed0b065ed7a4bb492c8d6f28fd81a832f68e8e595b7b75cba6",
    strip: "5ccb676276f43b59835ad81c0ced72c067edbfb53f7705c26e19fa16a22a57b9",
  },
  "positional opener without end marker": {
    kind: "unresolved-marker",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "eb500b9c13424fd8120284b54a795b9e4e4bd58347b814f7b162f523455c8247",
    strip: "85b4afb879b5b813bf8c9fbdc8239d3dc1cbd0c90d105817390551eb77af0ab5",
  },
  "marked section then plan prose quoting the start marker": {
    kind: "marked",
    status: "available",
    contentHash: "bddcb7b719fa3c4273023d1ca727ca2ce1764f49b05ae4da293a30cceb474159",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "3763f6679bb2f2d3f25da7d87f24a1d36c834351b63323b70c243ce024798586",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "7d2fe0b2b05b21460a4c50cfc82aacab44ede76887605a10540d3e9b779393f2",
    strip: "3ccb9d50fcbcf9f57d0c195fb7c7333737ec673cad2f7d94bf27e43cf59cbc23",
  },
  "legacy bare unmarked": {
    kind: "unmarked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
  "legacy fenced unmarked": {
    kind: "unmarked",
    status: "available",
    contentHash: "fe816325ed41e885c572ecdf7fe172f73eb4983df45c77c468a4f63a0cadfa4f",
    sections: {
      "mission": "a3c5b78e827272e56f7b7bd89d4aefc433686eee578929182cd79d0b9ba49697",
      "file-scope": "c58057923cf3465c660a0574f12a0bc228e2005e0e2685a82691938232e2ac0c",
      "steps": "93e1fe276a336e2418f98f4c080d5c1611be4eea76fc9f14942a9acf4cb00a82",
      "acceptance-criteria": "76f72765b745e618326ef404e2ce5ba1b4f991e1bda9eb0a24040a1ee83e3187",
      "non-goals": "6f2d4b9c790a34833cb779abe3fc62dbff28dc3dffa8491f21cdd65104a37b19",
      "dependencies": "0fe5cd79eb32da276c66d8742c3da9cccd5a7098ff4fa0c4d1365abe302fdb02",
      "lineage": "available",
    },
    fingerprint: "e1768f6efcff3419187b50dcea9ff2d1aea30d350717e674382df5a99d106ad8",
    strip: "2678163f39863f598dd1545a4817aa7b493e82fb470903785a9e0232f8cbf4db",
  },
};

describe("Original Description hash stability", () => {
  it.each(Object.keys(corpus))("keeps pinned lock, approval and strip hashes for %s", (name) => {
    expect(measure(corpus[name])).toEqual(PINNED[name]);
  });
});
