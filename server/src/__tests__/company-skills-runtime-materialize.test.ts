import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime skill materialization tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function skillMarkdown(name: string, body: string) {
  return `---\nname: ${name}\ndescription: Runtime materialization test skill\n---\n\n# ${name}\n\n${body}\n`;
}

async function assertReadableSkillMd(skillPath: string) {
  let content: string;
  try {
    content = await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(`Failed to read SKILL.md at ${skillPath}: ${err.code ?? err.message}`);
  }
  expect(content.length).toBeGreaterThan(0);
  expect(content.startsWith("---\n")).toBe(true);
  expect(content.includes("\n---\n")).toBe(true);
  return content;
}

async function listRuntimeResidue(runtimeRoot: string) {
  async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...await walk(absolute));
      } else {
        out.push(absolute);
      }
    }
    return out;
  }
  return walk(runtimeRoot);
}

function filterOwnEntries(entries: PaperclipSkillEntry[], keys: Set<string>) {
  return entries.filter((entry) => keys.has(entry.key));
}

describeEmbeddedPostgres("companySkillService runtime skill materialization", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let paperclipHome: string | null = null;
  /** Remote path -> content served by the github raw fetch stub. */
  let remoteFiles: Map<string, string>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-skill-materialize-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-skill-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  beforeEach(() => {
    remoteFiles = new Map();
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      // raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
      const match = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
      const remotePath = match?.[1] ? decodeURIComponent(match[1]) : null;
      if (remotePath && remoteFiles.has(remotePath)) {
        return new Response(remoteFiles.get(remotePath)!, { status: 200 });
      }
      return new Response(`missing ${remotePath ?? url}`, { status: 404 });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.delete(companySkills);
    await db.delete(companies);
    if (paperclipHome) {
      await fs.rm(path.join(paperclipHome, "skills"), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  async function insertSourceLessGithubSkill(options?: {
    markdown?: string;
    remoteFiles?: Record<string, string>;
    fileInventory?: Array<{ path: string; kind: string }>;
    slug?: string;
    name?: string;
    companyId?: string;
  }) {
    const companyId = options?.companyId ?? randomUUID();
    const skillId = randomUUID();
    const slug = options?.slug ?? "runtime-coach";
    const name = options?.name ?? "Runtime Coach";
    const markdown = options?.markdown ?? skillMarkdown(name, "Original body.");
    const key = `acme/runtime-materialize-${slug}/${slug}`;

    if (!options?.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }

    const auxEntries = Object.entries(options?.remoteFiles ?? {});
    for (const [remotePath, content] of auxEntries) {
      remoteFiles.set(remotePath, content);
    }
    // Always seed SKILL.md remotely too; materialize prefers readFile then markdown fallback.
    remoteFiles.set("SKILL.md", markdown);

    const fileInventory = options?.fileInventory ?? [
      { path: "SKILL.md", kind: "skill" },
      ...auxEntries.map(([filePath]) => ({
        path: filePath,
        kind: filePath.startsWith("references/") ? "reference" : "other",
      })),
    ];

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key,
      slug,
      name,
      description: "Source-less GitHub skill that requires runtime materialization.",
      markdown,
      sourceType: "github",
      sourceLocator: `https://github.com/acme/runtime-materialize-${slug}`,
      sourceRef: "main",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory,
      metadata: {
        sourceKind: "github",
        owner: "acme",
        repo: `runtime-materialize-${slug}`,
        ref: "main",
        hostname: "github.com",
        repoSkillDir: "",
      },
    });

    return { companyId, skillId, slug, name, markdown, key };
  }

  it("keeps every published SKILL.md readable under concurrent materializers and readers", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const skillA = await insertSourceLessGithubSkill({
      companyId,
      slug: "race-skill-a",
      name: "Race Skill A",
      markdown: skillMarkdown("Race Skill A", "Body A."),
      remoteFiles: { "references/a.md": "# A\n" },
    });
    const skillB = await insertSourceLessGithubSkill({
      companyId,
      slug: "race-skill-b",
      name: "Race Skill B",
      markdown: skillMarkdown("Race Skill B", "Body B."),
      remoteFiles: { "references/b.md": "# B\n" },
    });
    const ownKeys = new Set([skillA.key, skillB.key]);

    const readerErrors: string[] = [];
    let stopReaders = false;
    const knownSources = new Set<string>();

    const reader = (async () => {
      while (!stopReaders) {
        for (const source of [...knownSources]) {
          try {
            await assertReadableSkillMd(source);
          } catch (error) {
            readerErrors.push(String(error));
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const seeded = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), ownKeys);
    expect(seeded).toHaveLength(2);
    for (const entry of seeded) {
      knownSources.add(entry.source);
      await assertReadableSkillMd(entry.source);
    }

    const refreshedA = skillMarkdown("Race Skill A", "Body A refreshed.");
    const refreshedB = skillMarkdown("Race Skill B", "Body B refreshed.");
    remoteFiles.set("SKILL.md", refreshedA); // last write wins for shared stub map path — set per-skill paths
    // Per-repo raw paths share SKILL.md basename; fetch stub matches full URL path after ref.
    // Owner/repo differ per skill so remote path after ref is still "SKILL.md" — content is
    // looked up by path only. Prefer markdown DB field + readFile fallback for refresh.
    await db.update(companySkills)
      .set({ markdown: refreshedA })
      .where(eq(companySkills.id, skillA.skillId));
    await db.update(companySkills)
      .set({ markdown: refreshedB })
      .where(eq(companySkills.id, skillB.skillId));
    // Make remote SKILL.md 404 so materialize uses stored markdown (distinct per skill).
    remoteFiles.delete("SKILL.md");

    await Promise.all(Array.from({ length: 12 }, async () => {
      const listed = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), ownKeys);
      expect(listed).toHaveLength(2);
      for (const entry of listed) {
        expect(entry.sourceStatus).toBe("available");
        knownSources.add(entry.source);
        await assertReadableSkillMd(entry.source);
      }
    }));

    await db.update(companySkills)
      .set({ markdown: skillMarkdown("Race Skill A", "Body A final.") })
      .where(eq(companySkills.id, skillA.skillId));
    await Promise.all(Array.from({ length: 8 }, () => svc.listRuntimeSkillEntries(companyId)));

    stopReaders = true;
    await reader;

    expect(readerErrors).toEqual([]);
    expect(knownSources.size).toBe(2);
    for (const source of knownSources) {
      await assertReadableSkillMd(source);
    }

    const runtimeRoot = path.join(resolvePaperclipInstanceRoot(), "skills", companyId, "__runtime__");
    const residue = await listRuntimeResidue(runtimeRoot);
    expect(residue.every((filePath) => !path.basename(filePath).includes(".publish-"))).toBe(true);
    expect(residue.every((filePath) => !path.basename(filePath).includes(".tmp-"))).toBe(true);
  }, 30_000);

  it("treats an unchanged stored snapshot as a filesystem no-op", async () => {
    const { companyId, key } = await insertSourceLessGithubSkill({
      remoteFiles: { "references/guide.md": "# Guide v1\n" },
    });

    const first = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(first).toHaveLength(1);
    const skillPath = first[0]!.source;
    const beforeSkill = await fs.stat(path.join(skillPath, "SKILL.md"));
    const beforeAux = await fs.stat(path.join(skillPath, "references", "guide.md"));
    const beforeSkillContent = await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8");

    const writeSpy = vi.spyOn(fs, "writeFile");
    const renameSpy = vi.spyOn(fs, "rename");
    const rmSpy = vi.spyOn(fs, "rm");

    const second = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(second).toHaveLength(1);
    expect(second[0]!.source).toBe(skillPath);

    const afterSkill = await fs.stat(path.join(skillPath, "SKILL.md"));
    const afterAux = await fs.stat(path.join(skillPath, "references", "guide.md"));
    const afterSkillContent = await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8");

    expect(afterSkillContent).toBe(beforeSkillContent);
    expect(afterSkill.ino).toBe(beforeSkill.ino);
    expect(afterSkill.mtimeMs).toBe(beforeSkill.mtimeMs);
    expect(afterAux.ino).toBe(beforeAux.ino);
    expect(afterAux.mtimeMs).toBe(beforeAux.mtimeMs);

    const skillWrites = writeSpy.mock.calls.filter(([target]) => String(target).includes(skillPath));
    const skillRenames = renameSpy.mock.calls.filter(
      ([from, to]) => String(from).includes(skillPath) || String(to).includes(skillPath),
    );
    const skillRm = rmSpy.mock.calls.filter(([target]) => String(target).includes(skillPath));
    expect(skillWrites).toHaveLength(0);
    expect(skillRenames).toHaveLength(0);
    expect(skillRm).toHaveLength(0);
  });

  it("publishes changed stored markdown and converges auxiliary file add/change/remove", async () => {
    const { companyId, skillId, key, markdown } = await insertSourceLessGithubSkill({
      markdown: skillMarkdown("Runtime Coach", "Original body."),
      remoteFiles: {
        "references/old.md": "# Old\n",
        "references/keep.md": "# Keep v1\n",
      },
    });

    const initial = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(initial).toHaveLength(1);
    const skillPath = initial[0]!.source;
    await expect(fs.readFile(path.join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(markdown);
    await expect(fs.readFile(path.join(skillPath, "references", "old.md"), "utf8")).resolves.toBe("# Old\n");
    await expect(fs.readFile(path.join(skillPath, "references", "keep.md"), "utf8")).resolves.toBe("# Keep v1\n");

    remoteFiles.set("references/keep.md", "# Keep v2\n");
    remoteFiles.set("references/new.md", "# New\n");
    remoteFiles.delete("references/old.md");

    const nextMarkdown = skillMarkdown("Runtime Coach", "Updated body.");
    remoteFiles.set("SKILL.md", nextMarkdown);
    await db.update(companySkills)
      .set({
        markdown: nextMarkdown,
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/keep.md", kind: "reference" },
          { path: "references/new.md", kind: "reference" },
        ],
      })
      .where(eq(companySkills.id, skillId));

    const updated = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(updated[0]!.source).toBe(skillPath);
    await expect(fs.readFile(path.join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(nextMarkdown);
    await expect(fs.readFile(path.join(skillPath, "references", "keep.md"), "utf8")).resolves.toBe("# Keep v2\n");
    await expect(fs.readFile(path.join(skillPath, "references", "new.md"), "utf8")).resolves.toBe("# New\n");
    await expect(fs.stat(path.join(skillPath, "references", "old.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the previous valid snapshot when a refresh fails", async () => {
    const { companyId, skillId, key, markdown } = await insertSourceLessGithubSkill({
      markdown: skillMarkdown("Runtime Coach", "Stable body."),
      remoteFiles: { "references/guide.md": "# Guide\n" },
    });

    const initial = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    const skillPath = initial[0]!.source;
    const before = await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8");
    expect(before).toBe(markdown);
    const beforeAux = await fs.readFile(path.join(skillPath, "references", "guide.md"), "utf8");

    const nextMarkdown = skillMarkdown("Runtime Coach", "This update must not publish.");
    remoteFiles.set("SKILL.md", nextMarkdown);
    await db.update(companySkills)
      .set({ markdown: nextMarkdown })
      .where(eq(companySkills.id, skillId));

    const originalWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes(".publish-")) {
        throw new Error("forced publish failure");
      }
      return originalWriteFile(file, data as never, options as never);
    });

    const listed = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(writeSpy.mock.calls.some(([file]) => String(file).includes(".publish-"))).toBe(true);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.source).toBe(skillPath);
    expect(listed[0]!.sourceStatus).toBe("available");

    await expect(fs.readFile(path.join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(before);
    await expect(fs.readFile(path.join(skillPath, "references", "guide.md"), "utf8")).resolves.toBe(beforeAux);

    const residue = await listRuntimeResidue(path.dirname(skillPath));
    expect(residue.every((filePath) => !path.basename(filePath).includes(".publish-"))).toBe(true);
  });

  it("restores the previous complete snapshot when a later live publish fails after an auxiliary publish", async () => {
    const { companyId, skillId, key, markdown } = await insertSourceLessGithubSkill({
      markdown: skillMarkdown("Runtime Coach", "Stable body."),
      remoteFiles: {
        "references/guide.md": "# Guide v1\n",
        "references/extra.md": "# Extra v1\n",
      },
    });

    const initial = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(initial).toHaveLength(1);
    const skillPath = initial[0]!.source;
    const beforeSkill = await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8");
    const beforeGuide = await fs.readFile(path.join(skillPath, "references", "guide.md"), "utf8");
    const beforeExtra = await fs.readFile(path.join(skillPath, "references", "extra.md"), "utf8");
    expect(beforeSkill).toBe(markdown);
    expect(beforeGuide).toBe("# Guide v1\n");
    expect(beforeExtra).toBe("# Extra v1\n");

    const nextMarkdown = skillMarkdown("Runtime Coach", "This partial update must not stick.");
    remoteFiles.set("SKILL.md", nextMarkdown);
    remoteFiles.set("references/guide.md", "# Guide v2\n");
    remoteFiles.set("references/new.md", "# New must not remain\n");
    remoteFiles.delete("references/extra.md");
    await db.update(companySkills)
      .set({
        markdown: nextMarkdown,
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/guide.md", kind: "reference" },
          { path: "references/new.md", kind: "reference" },
        ],
      })
      .where(eq(companySkills.id, skillId));

    const originalRename = fs.rename.bind(fs);
    let successfulLiveAuxRenames = 0;
    let forcedLaterPublishFailure = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const fromStr = String(from);
      const toStr = String(to);
      const isLivePublishRename =
        fromStr.includes(".publish-")
        && (toStr === skillPath || toStr.startsWith(`${skillPath}${path.sep}`));
      if (isLivePublishRename && path.basename(toStr) !== "SKILL.md") {
        // Allow the first live auxiliary publish into the tree, then fail exactly once on
        // a later publish so restore renames can still succeed afterward.
        if (successfulLiveAuxRenames >= 1 && !forcedLaterPublishFailure) {
          forcedLaterPublishFailure = true;
          throw new Error("forced later auxiliary publish failure");
        }
        if (!forcedLaterPublishFailure) {
          await originalRename(from, to);
          successfulLiveAuxRenames += 1;
          return;
        }
      }
      return originalRename(from, to);
    });

    const listed = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));

    expect(successfulLiveAuxRenames).toBeGreaterThanOrEqual(1);
    expect(forcedLaterPublishFailure).toBe(true);
    expect(renameSpy.mock.calls.length).toBeGreaterThan(0);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.source).toBe(skillPath);
    expect(listed[0]!.sourceStatus).toBe("available");
    expect(listed[0]!.missingDetail).toBeNull();

    // Prior complete snapshot must be restored byte-identically — including files the
    // failed refresh intended to change, add, or remove.
    await expect(fs.readFile(path.join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(beforeSkill);
    await expect(fs.readFile(path.join(skillPath, "references", "guide.md"), "utf8")).resolves.toBe(beforeGuide);
    await expect(fs.readFile(path.join(skillPath, "references", "extra.md"), "utf8")).resolves.toBe(beforeExtra);
    await expect(fs.stat(path.join(skillPath, "references", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const residue = await listRuntimeResidue(path.dirname(skillPath));
    expect(residue.every((filePath) => !path.basename(filePath).includes(".publish-"))).toBe(true);
  });

  it("fails closed when a partial refresh cannot restore the prior complete snapshot", async () => {
    const { companyId, skillId, key } = await insertSourceLessGithubSkill({
      markdown: skillMarkdown("Runtime Coach", "Stable body."),
      remoteFiles: {
        "references/guide.md": "# Guide v1\n",
        "references/extra.md": "# Extra v1\n",
      },
    });

    const initial = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    const skillPath = initial[0]!.source;

    const nextMarkdown = skillMarkdown("Runtime Coach", "Broken partial update.");
    remoteFiles.set("SKILL.md", nextMarkdown);
    remoteFiles.set("references/guide.md", "# Guide v2\n");
    remoteFiles.set("references/new.md", "# New\n");
    remoteFiles.delete("references/extra.md");
    await db.update(companySkills)
      .set({
        markdown: nextMarkdown,
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/guide.md", kind: "reference" },
          { path: "references/new.md", kind: "reference" },
        ],
      })
      .where(eq(companySkills.id, skillId));

    const originalRename = fs.rename.bind(fs);
    let successfulLiveAuxRenames = 0;
    let blockedAfterPartialPublish = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const fromStr = String(from);
      const toStr = String(to);
      const isLivePublishRename =
        fromStr.includes(".publish-")
        && (toStr === skillPath || toStr.startsWith(`${skillPath}${path.sep}`));
      if (isLivePublishRename) {
        if (!blockedAfterPartialPublish && path.basename(toStr) !== "SKILL.md" && successfulLiveAuxRenames < 1) {
          await originalRename(from, to);
          successfulLiveAuxRenames += 1;
          return;
        }
        // Fail the later publish and every subsequent restore rename so restoration cannot complete.
        blockedAfterPartialPublish = true;
        throw new Error("forced later publish and restore failure");
      }
      return originalRename(from, to);
    });

    const listed = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));

    expect(successfulLiveAuxRenames).toBeGreaterThanOrEqual(1);
    expect(blockedAfterPartialPublish).toBe(true);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.source).toBe(skillPath);
    expect(listed[0]!.sourceStatus).toBe("missing");
    expect(listed[0]!.missingDetail).toMatch(/could not be restored safely/i);
  });

  it("keeps published paths sandboxed under the skill directory", async () => {
    const { companyId, skillId, key, markdown } = await insertSourceLessGithubSkill({
      markdown: skillMarkdown("Runtime Coach", "Safe body."),
    });
    const initial = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    const skillPath = initial[0]!.source;
    await expect(fs.readFile(path.join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(markdown);

    await db.update(companySkills)
      .set({
        markdown: skillMarkdown("Runtime Coach", "Traversal attempt."),
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          // Portable-path normalization collapses ".." so this cannot escape skillDir.
          { path: "../escape.md", kind: "reference" },
        ],
      })
      .where(eq(companySkills.id, skillId));

    const listed = filterOwnEntries(await svc.listRuntimeSkillEntries(companyId), new Set([key]));
    expect(listed.length).toBeGreaterThan(0);
    await assertReadableSkillMd(skillPath);

    await expect(fs.stat(path.join(path.dirname(skillPath), "escape.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
