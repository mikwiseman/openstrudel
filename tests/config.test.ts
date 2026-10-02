import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/config.js";

describe("config", () => {
  it("loads a simple env file without overriding explicit values", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstrudel-env-"));
    const path = join(root, ".env");
    await writeFile(path, "OPENSTRudel_TEST=\"from-file\"\n");
    const key = "OPENSTRudel_TEST";
    const previous = process.env[key];
    delete process.env[key];
    try {
      loadDotEnv(path);
      expect(process.env[key]).toBe("from-file");
      process.env[key] = "explicit";
      loadDotEnv(path);
      expect(process.env[key]).toBe("explicit");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
