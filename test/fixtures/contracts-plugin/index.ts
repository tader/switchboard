export default function () {
  async function request(
    ctx: any,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const r = await ctx.request({
      url: path,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: [["content-type", "application/json"]],
    });
    if (r.status === 401)
      throw Object.assign(Error("authentication_required"), {
        code: "authentication_required",
      });
    if (!r.ok)
      throw Object.assign(Error("fixture_failed"), { status: r.status });
    return r.json();
  }
  const operations: any = {
    "messaging.conversations.list": {
      category: "messaging",
      readOnly: true,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      invoke: async (_input: any, ctx: any) => request(ctx, "snapshot"),
    },
    "messaging.messages.list": {
      category: "messaging",
      readOnly: true,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      invoke: async (_input: any, ctx: any) => request(ctx, "messages"),
    },
    "messaging.messages.send": {
      category: "messaging",
      readOnly: false,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      invoke: async (input: any, ctx: any) =>
        request(ctx, "send", "POST", { ...input, key: ctx.idempotencyKey }),
    },
  };
  return {
    services: [
      {
        id: "contracts-test",
        name: "Contract fixture",
        baseUrl: (c: any) => c.config.endpoint,
        allowedHosts: (c: any) => [new URL(c.config.endpoint).host],
        authMethods: [
          {
            id: "key",
            name: "Key",
            fields: [
              { key: "endpoint", label: "Endpoint", required: true },
              { key: "key", label: "Key", type: "secret", required: true },
            ],
            async connect({ config }: any) {
              return {
                config: { endpoint: config.endpoint },
                credentials: { key: config.key },
                account: { id: "fixture-account", label: "Fixture" },
              };
            },
            async authorize(req: any, conn: any) {
              req.headers.set(
                "authorization",
                "Bearer " + conn.credentials.key,
              );
            },
          },
        ],
        contracts: {
          version: 1,
          operations,
          available: () => Object.keys(operations),
          async collect(input: any, ctx: any) {
            await request(ctx, "poll");
            const id = "poll:" + Date.now();
            return {
              checkpoint: id,
              events: [
                {
                  sourceId: id,
                  event: {
                    category: "messaging",
                    type: "invalidated",
                    resourceType: "conversations",
                  },
                },
              ],
            };
          },
          async watch(input: any, ctx: any) {
            let cursor = Number(input.checkpoint ?? 0);
            while (!ctx.signal.aborted) {
              const page = await request(ctx, "events?after=" + cursor);
              await ctx.publish({
                checkpoint: String(page.cursor),
                events: page.events.map((e: any) => ({
                  sourceId: "event:" + e.seq,
                  event: {
                    category: "messaging",
                    type: "created",
                    resourceType: "message",
                    resourceId: e.id,
                    collectionId: "chat",
                  },
                })),
              });
              cursor = page.cursor;
            }
          },
        },
      },
    ],
  };
}
