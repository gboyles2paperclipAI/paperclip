import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

function readString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function readOctal(buffer, start, length, label) {
  const raw = readString(buffer, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}

function validateHeaderChecksum(header) {
  const expected = readOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("invalid tar header checksum");
}

function parsePax(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error("invalid tar PAX record");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("invalid tar PAX length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("invalid tar PAX record bounds");
    }
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("invalid tar PAX field");
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

function validatePackagePath(entryPath) {
  if (!entryPath || entryPath.includes("\\") || entryPath.includes("\0")) {
    throw new Error("unsafe tar entry path");
  }
  const normalized = posix.normalize(entryPath);
  if (
    normalized !== entryPath.replace(/\/$/, "") &&
    `${normalized}/` !== entryPath
  ) {
    throw new Error("non-canonical tar entry path");
  }
  if (posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("unsafe tar entry path");
  }
  if (normalized !== "package" && !normalized.startsWith("package/")) {
    throw new Error("tar entry is outside the npm package root");
  }
  return normalized;
}

function resolveLinkPath(entryPath, linkPath) {
  if (!linkPath || linkPath.includes("\\") || linkPath.includes("\0") || posix.isAbsolute(linkPath)) {
    throw new Error("unsafe tar link target");
  }
  const resolved = posix.normalize(posix.join(posix.dirname(entryPath), linkPath));
  if (resolved !== "package" && !resolved.startsWith("package/")) {
    throw new Error("tar link target is outside the npm package root");
  }
  return resolved;
}

export function parseNpmTarball(tarballBytes) {
  let archive;
  try {
    archive = gunzipSync(tarballBytes);
  } catch {
    throw new Error("release package is not a valid gzip tarball");
  }

  const entries = [];
  const seen = new Set();
  let offset = 0;
  let nextPax = {};
  let globalPax = {};
  let longPath;
  let longLink;
  let zeroBlocks = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) {
        if (archive.subarray(offset).some((byte) => byte !== 0)) {
          throw new Error("nonzero data follows the tar end marker");
        }
        break;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error("invalid tar end marker");
    validateHeaderChecksum(header);

    const size = readOctal(header, 124, 12, "entry size");
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset + paddedSize > archive.length) throw new Error("truncated tar entry");
    const data = archive.subarray(offset, offset + size);
    offset += paddedSize;

    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    const headerPath = [prefix, readString(header, 0, 100)].filter(Boolean).join("/");
    const headerLink = readString(header, 157, 100);

    if (type === "x" || type === "g") {
      const parsed = parsePax(data);
      if (type === "g") globalPax = { ...globalPax, ...parsed };
      else nextPax = parsed;
      continue;
    }
    if (type === "L" || type === "K") {
      const value = data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString("utf8");
      if (type === "L") longPath = value;
      else longLink = value;
      continue;
    }

    const pax = { ...globalPax, ...nextPax };
    const entryPath = validatePackagePath(pax.path ?? longPath ?? headerPath);
    const linkPath = pax.linkpath ?? longLink ?? headerLink;
    nextPax = {};
    longPath = undefined;
    longLink = undefined;

    if (seen.has(entryPath)) throw new Error("duplicate tar entry path");
    seen.add(entryPath);

    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ path: entryPath, type: "file", content: Buffer.from(data) });
    } else if (type === "5") {
      entries.push({ path: entryPath, type: "directory", content: Buffer.alloc(0) });
    } else if (type === "1" || type === "2") {
      resolveLinkPath(entryPath, linkPath);
      entries.push({ path: entryPath, type: type === "1" ? "hardlink" : "symlink", content: Buffer.from(linkPath) });
    } else {
      throw new Error("unsupported tar entry type");
    }
  }

  if (zeroBlocks < 2 || entries.length === 0) throw new Error("incomplete or empty tar archive");
  return entries;
}

function containsToken(value, normalizedTokens) {
  const normalizedValue = value.toLocaleLowerCase("en-US");
  return normalizedTokens.some((token) => normalizedValue.includes(token));
}

export function releaseTarballSha256(tarballPath) {
  if (!lstatSync(tarballPath).isFile()) throw new Error("release tarball is not a regular file");
  return createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
}

export function inspectNpmReleaseTarball({ tarballPath, expectedName, expectedVersion, tokens = [] }) {
  const tarballBytes = readFileSync(tarballPath);
  const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const entries = parseNpmTarball(tarballBytes);
  const normalizedTokens = [...new Set(tokens.map((token) => token.trim().toLocaleLowerCase("en-US")).filter(Boolean))];

  for (const entry of entries) {
    if (
      containsToken(entry.path, normalizedTokens) ||
      (entry.type !== "directory" && containsToken(entry.content.toString("utf8"), normalizedTokens))
    ) {
      throw new Error("forbidden token found in staged release tarball");
    }
  }

  const packageJsonEntries = entries.filter(
    (entry) => entry.path === "package/package.json" && entry.type === "file",
  );
  if (packageJsonEntries.length !== 1) throw new Error("staged tarball has no unique package.json");

  let manifest;
  try {
    manifest = JSON.parse(packageJsonEntries[0].content.toString("utf8"));
  } catch {
    throw new Error("staged tarball package.json is invalid");
  }
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error("staged tarball package identity does not match the release plan");
  }

  return { sha256, entries, manifest };
}
