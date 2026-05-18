import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  invites,
  principalPermissionGrants,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

async function createCompany(db: ReturnType<typeof createDb>, prefix: string) {
  return db
    .insert(companies)
    .values({
      name: `${prefix} ${randomUUID()}`,
      issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("plugin access and authorization host services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-access-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(invites);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects grant writes for principals outside the requested company", async () => {
    const targetCompany = await createCompany(db, "PAX");
    const otherCompany = await createCompany(db, "PAY");
    const otherAgent = await db
      .insert(agents)
      .values({
        companyId: otherCompany.id,
        name: "Other agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const services = buildHostServices(db, "plugin-record-id", "paperclip-ee", createEventBusStub());

    await expect(
      services.authorization.setGrants({
        companyId: targetCompany.id,
        principalType: "agent",
        principalId: otherAgent.id,
        grants: [{ permissionKey: "tasks:assign" }],
      }),
    ).rejects.toThrow("Agent not found");

    const rows = await db.select().from(principalPermissionGrants);
    expect(rows).toEqual([]);
    services.dispose();
  });

  it("redacts invite token hashes and sensitive defaults from plugin invite reads", async () => {
    const company = await createCompany(db, "PAZ");
    const services = buildHostServices(db, "plugin-record-id", "paperclip-ee", createEventBusStub());

    const created = await services.access.createInvite({
      companyId: company.id,
      allowedJoinTypes: "human",
      defaultsPayload: {
        human: { role: "operator", apiKey: "secret-value" },
        secret: "top-secret",
      },
    });

    expect(created.token).toMatch(/^pcp_invite_/);
    expect("tokenHash" in created).toBe(false);
    expect(created.defaultsPayload).toMatchObject({
      human: { role: "operator", apiKey: "***REDACTED***" },
      secret: "***REDACTED***",
    });

    const listed = await services.access.listInvites({ companyId: company.id });
    expect(listed.invites).toHaveLength(1);
    expect("token" in listed.invites[0]!).toBe(false);
    expect("tokenHash" in listed.invites[0]!).toBe(false);
    services.dispose();
  });
});
