import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
} from "../auth/better-auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Better Auth integration test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Better Auth integration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-");
    const db = createDb(tempDb.connectionString);
    process.env.BETTER_AUTH_SECRET = "paperclip-better-auth-integration-secret";

    const auth = createBetterAuthInstance(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://paperclip.auth.test",
      authDisableSignUp: false,
    } as Parameters<typeof createBetterAuthInstance>[1], ["http://paperclip.auth.test"]);

    app = express();
    app.use(express.json());
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    await tempDb?.cleanup();
  });

  it("signs up, signs in, and reads the resulting database-backed session", async () => {
    const credentials = {
      email: "auth-upgrade@example.test",
      name: "Auth Upgrade",
      password: "correct-horse-battery-staple",
    };

    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Host", "paperclip.auth.test")
      .set("Origin", "http://paperclip.auth.test")
      .send(credentials);
    expect(signUp.status).toBe(200);

    const signedIn = request.agent(app);
    const signIn = await signedIn
      .post("/api/auth/sign-in/email")
      .set("Host", "paperclip.auth.test")
      .set("Origin", "http://paperclip.auth.test")
      .send({ email: credentials.email, password: credentials.password });
    expect(signIn.status).toBe(200);

    const session = await signedIn
      .get("/api/auth/get-session")
      .set("Host", "paperclip.auth.test");
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      user: {
        email: credentials.email,
        name: credentials.name,
      },
      session: {
        userId: signIn.body.user.id,
      },
    });
  }, 30_000);
});
