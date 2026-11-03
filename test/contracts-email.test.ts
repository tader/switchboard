import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { emailOperations } from "../server/contracts/email-schema.ts";
import { CONTRACT_OPERATIONS } from "../server/contracts/model.ts";
const ajv = new Ajv({ strict: false });
const valid = (name: string, side: "input" | "output", value: unknown) =>
  ajv.validate(
    emailOperations["email." + name][
      side === "input" ? "inputSchema" : "outputSchema"
    ],
    value,
  );

test("email sends require explicit recipients and body without injectable headers", () => {
  const message = {
    to: [{ address: "person@example.com" }],
    subject: "Hello",
    text: "",
  };
  assert.equal(valid("messages.send", "input", message), true);
  for (const changed of [
    { ...message, to: [] },
    { ...message, text: undefined },
    { ...message, subject: "Hello\r\nBcc: other@example.com" },
    { ...message, to: [{ address: "person@example.com\n" }] },
    { ...message, to: [{ address: "person@example.com", name: "Name\r\n" }] },
    { ...message, rawMime: "bypasses contract" },
  ])
    assert.equal(valid("messages.send", "input", changed), false);
});

test("restricted email cannot expose text or HTML and unknown read state stays null", () => {
  const item = {
    id: "m",
    subject: "Hidden",
    from: [],
    to: [],
    collectionIds: [],
    text: null,
    html: null,
    isRead: null,
    draft: false,
    contentState: "restricted",
  };
  assert.equal(valid("messages.get", "output", item), true);
  assert.equal(
    valid("messages.get", "output", { ...item, text: "secret" }),
    false,
  );
  assert.equal(
    valid("messages.get", "output", { ...item, html: "<p>secret</p>" }),
    false,
  );
  assert.equal(
    valid("messages.get", "output", { ...item, contentState: undefined }),
    false,
  );
  assert.equal(
    valid("messages.get", "output", { ...item, isRead: "unknown" }),
    false,
  );
});

test("draft identifiers are distinct and incomplete drafts are allowed without sending", () => {
  assert.equal(valid("drafts.create", "input", { text: "unfinished" }), true);
  assert.equal(
    valid("drafts.update", "input", { id: "d", changes: { to: [] } }),
    true,
  );
  assert.equal(
    valid("drafts.update", "input", { id: "d", changes: {} }),
    false,
  );
  const message = {
    id: "m",
    subject: "",
    from: [],
    to: [],
    collectionIds: [],
    text: "unfinished",
    isRead: null,
    draft: true,
    contentState: "available",
  };
  assert.equal(valid("drafts.get", "output", { id: "d", message }), true);
  assert.equal(
    valid("drafts.get", "output", {
      id: "d",
      message: { ...message, draft: false },
    }),
    false,
  );
});

test("mail mutations are narrow, receipts metadata-only and pages disclose coverage", () => {
  assert.deepEqual(Object.keys(emailOperations), [
    ...CONTRACT_OPERATIONS.email,
  ]);
  assert.equal(
    valid("messages.update", "input", { id: "m", changes: { isRead: true } }),
    true,
  );
  assert.equal(
    valid("messages.update", "input", {
      id: "m",
      changes: { subject: "edit sent message" },
    }),
    false,
  );
  assert.equal(
    valid("messages.move", "input", {
      id: "m",
      destinationId: "archive",
      sourceCollectionId: "inbox",
    }),
    true,
  );
  assert.equal(valid("messages.move", "input", { id: "m" }), false);
  assert.equal(
    valid("messages.send", "output", { status: "accepted", resourceId: "m" }),
    true,
  );
  assert.equal(
    valid("messages.send", "output", { status: "accepted", text: "private" }),
    false,
  );
  assert.equal(valid("messages.list", "output", { items: [] }), false);
  assert.equal(
    valid("messages.list", "output", {
      items: [],
      coverage: { complete: false, reason: "bounded" },
    }),
    true,
  );
});
