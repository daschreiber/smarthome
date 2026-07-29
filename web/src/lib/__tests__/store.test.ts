import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../store";

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "store-")), name);
}

describe("readJsonFile", () => {
  it("treats a missing file as the fallback", () => {
    expect(readJsonFile(tmpFile("absent.json"), [])).toEqual([]);
  });

  it("refuses to treat a corrupt file as empty — that is how a truncated users.json wipes accounts", () => {
    const p = tmpFile("corrupt.json");
    fs.writeFileSync(p, '[{"email": "a@b.c", "role": "adm'); // truncated mid-write
    expect(() => readJsonFile(p, [])).toThrow(/not valid JSON/);
  });

  it("round-trips through writeJsonFile", () => {
    const p = tmpFile("data.json");
    writeJsonFile(p, { a: 1 });
    expect(readJsonFile(p, null)).toEqual({ a: 1 });
  });
});

describe("writeJsonFile", () => {
  it("creates missing parent directories (fresh volume mounts)", () => {
    const p = path.join(tmpFile("nested"), "deep", "data.json");
    writeJsonFile(p, [1, 2]);
    expect(readJsonFile(p, [])).toEqual([1, 2]);
  });

  it("leaves no temp file behind", () => {
    const p = tmpFile("data.json");
    writeJsonFile(p, { ok: true });
    expect(fs.readdirSync(path.dirname(p))).toEqual(["data.json"]);
  });
});
