import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The JSON data files exist twice: at the repo root (data/, the maintained
 * copy, first in every module's lookup order) and under web/data/ (the copy
 * a deploy whose cwd is web/ falls back to). They drifted once — the Yamaha
 * receiver rows were appended to the root copy only, so the deployed app
 * never saw them. This guard fails the suite whenever the copies differ:
 * edit the root file, then copy it into web/data/.
 */

const ROOT_DATA = path.join(process.cwd(), "..", "data");
const WEB_DATA = path.join(process.cwd(), "data");

const FILES = ["entity_map.json", "room_aliases.json", "vacuum_rooms.json"];

describe("data file copies stay in sync", () => {
  for (const file of FILES) {
    it(`${file} is byte-identical in data/ and web/data/`, () => {
      const rootCopy = fs.readFileSync(path.join(ROOT_DATA, file), "utf8");
      const webCopy = fs.readFileSync(path.join(WEB_DATA, file), "utf8");
      expect(webCopy).toBe(rootCopy);
    });
  }
});
