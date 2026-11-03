// Self-contained plugin types live in api.ts so installed plugins can bundle one file.
export type {
  Category,
  Coverage,
  Page,
  Resource,
  Calendar,
  CalendarEvent,
  MailCollection,
  Address,
  EmailMessage,
  Conversation,
  Message,
  WriteReceipt,
  ContractContext,
  ContractChangeBatch,
  ContractWatchContext,
  ContractOperation,
  ContractDefinition,
  ChangeEvent,
} from "../plugins/api.ts";
import type { Category } from "../plugins/api.ts";
export const CATEGORIES: Category[] = ["calendar", "email", "messaging"];
export const CONTRACT_OPERATIONS = {
  calendar: [
    "calendar.calendars.list",
    "calendar.events.list",
    "calendar.events.get",
    "calendar.events.create",
    "calendar.events.update",
    "calendar.events.delete",
  ],
  email: [
    "email.mailboxes.list",
    "email.messages.list",
    "email.messages.get",
    "email.messages.update",
    "email.messages.move",
    "email.messages.trash",
    "email.messages.send",
    "email.messages.reply",
    "email.messages.forward",
    "email.drafts.list",
    "email.drafts.get",
    "email.drafts.create",
    "email.drafts.update",
    "email.drafts.delete",
    "email.drafts.send",
  ],
  messaging: [
    "messaging.conversations.list",
    "messaging.conversations.get",
    "messaging.conversations.create",
    "messaging.messages.list",
    "messaging.messages.get",
    "messaging.messages.send",
    "messaging.messages.update",
    "messaging.messages.delete",
    "messaging.threads.list",
    "messaging.reactions.update",
    "messaging.readState.update",
  ],
} as const;
export function validateDefinition(
  value: import("./model.ts").ContractDefinition,
) {
  if (
    value.version !== 1 ||
    typeof value.available !== "function" ||
    !value.operations ||
    typeof value.operations !== "object"
  )
    throw Error("Invalid shared contract");
  for (const key of ["collect", "watch"] as const)
    if (value[key] !== undefined && typeof value[key] !== "function")
      throw Error("Invalid contract " + key);
  for (const [name, op] of Object.entries(value.operations)) {
    if (
      !CATEGORIES.includes(op.category) ||
      !(CONTRACT_OPERATIONS[op.category] as readonly string[]).includes(name) ||
      typeof op.readOnly !== "boolean" ||
      typeof op.invoke !== "function" ||
      !op.inputSchema ||
      !op.outputSchema
    )
      throw Error("Invalid contract operation " + name);
    const read = /\.(list|get)$/.test(name);
    if (op.readOnly !== read)
      throw Error("Incorrect contract mutation classification " + name);
  }
}
