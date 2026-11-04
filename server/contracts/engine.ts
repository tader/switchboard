import { Ajv } from "ajv";
import { db } from "../db.ts";
import { getConnectionRow, loadConnection } from "../connections.ts";
import { execute } from "../proxy.ts";
import { requestPeer } from "../peers.ts";
import { instanceId } from "../peer-protocol.ts";
import { sha256 } from "../crypto.ts";
import { HttpError, badRequest } from "../http.ts";
import { terminalAuthenticationError } from "../auth-errors.ts";
import type { WebSocketAccess } from "../websocket-access.ts";
import type { Caller } from "../audit.ts";
import type { ContractCollectors } from "./runtime.ts";
import { ContractStore } from "./store.ts";
import { calendarOperations } from "./calendar-schema.ts";
import { messagingOperations } from "./messaging-schema.ts";
import { emailOperations } from "./email-schema.ts";
import { CONTRACT_OPERATIONS } from "./model.ts";
import type { Category } from "./model.ts";
const common = {
  ...calendarOperations,
  ...messagingOperations,
  ...emailOperations,
};
const known = new Set<string>(Object.values(CONTRACT_OPERATIONS).flat());
const ajv = new Ajv({ strict: false, allErrors: true }),
  validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();
function validate(
  schema: Record<string, unknown>,
  value: unknown,
  output = false,
) {
  let f = validators.get(schema);
  if (!f) {
    f = ajv.compile(schema);
    validators.set(schema, f);
  }
  if (!f(value))
    throw new HttpError(
      output ? 502 : 400,
      output ? "invalid_contract_response" : "invalid_contract_arguments",
    );
}
export interface OperationView {
  name: string;
  category: Category;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  inputConstraints: Record<string, unknown>;
}
export interface ContractView {
  version: 1;
  changes: { native: boolean; reconciliation: boolean };
  operations: OperationView[];
}
export async function describeContract(
  access: WebSocketAccess,
  ref: string,
  signal: AbortSignal,
  caller?: Caller,
  operation?: string,
): Promise<ContractView> {
  const row = getConnectionRow(access.user.id, ref);
  access.check(row.id);
  if (row.peer_id)
    return requestPeer(
      row.peer_id,
      access.user.id,
      "contracts",
      {
        connection: row.remote_connection_id,
        action: "describe",
        operation,
        caller,
      },
      120000,
      signal,
    );
  const { conn, service } = loadConnection(access.user.id, row.id),
    definition = service.contracts;
  if (!definition) throw new HttpError(501, "contract_not_supported");
  const names = (await definition.available(conn)).filter((n) =>
    Object.hasOwn(definition.operations, n),
  );
  if (operation && !names.includes(operation))
    throw new HttpError(403, "operation_not_available");
  const reads = names.some((n) => definition.operations[n].readOnly);
  return {
    version: 1,
    changes: {
      native: reads && typeof definition.watch === "function",
      reconciliation: reads && typeof definition.collect === "function",
    },
    operations: await Promise.all(
      names
        .filter((n) => !operation || n === operation)
        .map(async (name) => {
          const op = definition.operations[name];
          return {
            name,
            category: op.category,
            readOnly: op.readOnly,
            inputSchema: common[name]?.inputSchema ?? op.inputSchema,
            outputSchema: common[name]?.outputSchema ?? op.outputSchema,
            inputConstraints: op.inputConstraints
              ? {
                  ...op.inputSchema,
                  allOf: [
                    ...((op.inputSchema.allOf as unknown[]) ?? []),
                    await op.inputConstraints(conn),
                  ],
                }
              : op.inputSchema,
          };
        }),
    ),
  };
}
function receipt(value: any) {
  if (!value || !["accepted", "rejected", "uncertain"].includes(value.status))
    throw new HttpError(502, "invalid_contract_response");
  return Object.fromEntries(
    ["status", "resourceId", "version", "code"]
      .filter((k) => value[k] !== undefined)
      .map((k) => {
        if (typeof value[k] !== "string" || value[k].length > 1024)
          throw new HttpError(502, "invalid_contract_response");
        return [k, value[k]];
      }),
  );
}
export async function callContract(
  access: WebSocketAccess,
  ref: string,
  input: any,
  signal: AbortSignal,
  caller: Caller | undefined,
  auth: Pick<ContractCollectors, "state" | "pauseAuthentication">,
): Promise<{ status: 200 | 202; result: any }> {
  const row = getConnectionRow(access.user.id, ref);
  access.check(row.id);
  if (
    !input ||
    typeof input.operation !== "string" ||
    !known.has(input.operation)
  )
    throw badRequest("Operation required");
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
    throw new HttpError(413, "body_too_large");
  const description = await describeContract(
      access,
      row.id,
      signal,
      caller,
      input.operation,
    ),
    op = description.operations.find((o) => o.name === input.operation);
  if (!op || op.readOnly !== /\.(list|get)$/.test(input.operation))
    throw new HttpError(502, "invalid_contract_response");
  const args = input.arguments ?? {};
  validate(op.inputSchema, args);
  validate(op.inputConstraints, args);
  access.check(row.id);
  const store = new ContractStore(db);
  if (!op.readOnly) {
    if (auth.state(row.id).status === "auth_required")
      throw new HttpError(409, "authentication_required");
    if (typeof input.idempotencyKey !== "string")
      throw badRequest("Idempotency key required");
    const prior = store.intent(row.id, input.idempotencyKey, {
      operation: input.operation,
      arguments: args,
    });
    if (prior) return { status: 200, result: prior };
  }
  try {
    let result: any,
      status: 200 | 202 = 200;
    if (row.peer_id) {
      const forwarded = {
        ...input,
        idempotencyKey: op.readOnly
          ? undefined
          : sha256(
              JSON.stringify([
                "contracts.v1",
                instanceId(),
                row.id,
                input.idempotencyKey,
              ]),
            ),
      };
      const response = await requestPeer<any>(
        row.peer_id,
        access.user.id,
        "contracts",
        {
          connection: row.remote_connection_id,
          action: "call",
          input: forwarded,
          caller,
        },
        120000,
        signal,
      );
      if (!response || ![200, 202].includes(response.status))
        throw new HttpError(502, "invalid_contract_response");
      result = response.result;
      status = response.status;
    } else {
      const { conn, service } = loadConnection(access.user.id, row.id),
        definition = service.contracts!;
      if (!(await definition.available(conn)).includes(input.operation))
        throw new HttpError(403, "operation_not_available");
      access.check(row.id);
      result = await definition.operations[input.operation].invoke(args, {
        connection: conn,
        signal,
        idempotencyKey: op.readOnly ? undefined : input.idempotencyKey,
        request: async (request) => {
          access.check(row.id);
          return (await execute(access.user, row.id, request, signal)).response;
        },
      });
    }
    if (!op.readOnly) result = receipt(result);
    validate(op.outputSchema, result, true);
    if (!row.peer_id) {
      const { service } = loadConnection(access.user.id, row.id);
      validate(
        service.contracts!.operations[input.operation].outputSchema,
        result,
        true,
      );
    }
    if (!op.readOnly) store.receipt(row.id, input.idempotencyKey, result);
    return { status, result };
  } catch (error: any) {
    if (terminalAuthenticationError(error) || error?.status === 401)
      auth.pauseAuthentication(row.id);
    if (!op.readOnly) return { status: 202, result: { status: "uncertain" } };
    throw error;
  }
}
export function contractFailure(error: any) {
  const codes: Record<string, number> = {
    subscription_not_found: 404,
    invalid_cursor: 409,
    idempotency_conflict: 409,
    invalid_subscription: 400,
    invalid_limit: 400,
    invalid_idempotency_key: 400,
    not_found: 404,
    conflict: 409,
    invalid_request: 400,
    permission_denied: 403,
    authentication_required: 409,
    rate_limited: 429,
    contract_peer_upgrade_required: 501,
    contract_not_supported: 501,
    collector_not_supported: 501,
    peer_offline: 503,
    source_unavailable: 503,
  };
  const code = error?.code ?? error?.message,
    status = codes[code] ?? (error instanceof HttpError ? error.status : 500);
  const delay = Number(error?.retryAfterMs);
  return {
    status,
    ...(Number.isFinite(delay) && delay > 0
      ? { retryAfterMs: Math.min(86400000, Math.max(1000, Math.ceil(delay))) }
      : {}),
    code: status >= 500 && !codes[code] ? "contract_failed" : String(code),
  };
}
