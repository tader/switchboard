import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { messagingOperations } from "../server/contracts/messaging-schema.ts";
const ajv = new Ajv({ strict: false });
test("canonical messaging schemas reject hidden restricted bodies and unknown read state", () => {
  const schema = messagingOperations["messaging.messages.get"].outputSchema;
  const item = {
    id: "m",
    conversationId: "c",
    text: null,
    authorId: null,
    createdAt: null,
    isOwn: null,
    contentState: "restricted",
    contentType: "unknown",
  };
  assert.equal(ajv.validate(schema, item), true);
  assert.equal(ajv.validate(schema, { ...item, text: "private" }), false);
  assert.equal(
    ajv.validate(
      messagingOperations["messaging.readState.update"].inputSchema,
      { conversationId: "c" },
    ),
    false,
  );
});
test("common mutations return receipts instead of provider message bodies", () => {
  const schema = messagingOperations["messaging.messages.send"].outputSchema;
  assert.equal(
    ajv.validate(schema, { status: "accepted", resourceId: "m" }),
    true,
  );
  assert.equal(
    ajv.validate(schema, { status: "accepted", text: "private" }),
    false,
  );
});

test("message history can target a thread and rejects an empty thread filter", () => {
  const schema = messagingOperations["messaging.messages.list"].inputSchema;
  assert.equal(
    ajv.validate(schema, { conversationId: "channel", threadId: "thread" }),
    true,
  );
  assert.equal(
    ajv.validate(schema, { conversationId: "channel", threadId: "" }),
    false,
  );
});
