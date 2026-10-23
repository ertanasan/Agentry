// The checked-in recipes parse, and the VocaTrain one's commands agree with each other and with its comment.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecipe } from "../src/recipe.ts";
import { parseVersion } from "../src/runner.ts";

const dir = join(import.meta.dir, "../recipes");

describe("recipes", () => {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    test(`${f} parses`, () => { parseRecipe(readFileSync(join(dir, f), "utf8")); });
  }

  test('scope_path "" is the whole repo; a missing one is still an error', () => {
    const base = { repo: "/x", deploy_group: "g", test_cmd: "true" };
    expect(parseRecipe(JSON.stringify({ ...base, scope_path: "" })).scope_path).toBe("");
    expect(() => parseRecipe(JSON.stringify(base))).toThrow('"scope_path" is required');
  });

  test("vocatrain-backend: TRX path, encoded busy check and VERSION format line up", () => {
    const json = readFileSync(join(dir, "vocatrain-backend.json"), "utf8");
    const r = parseRecipe(json);
    expect(r.test_cmd).toContain("LogFileName=agentry.trx");
    expect(r.test_cmd).toContain("--results-directory TestResults");
    expect(r.test_result_file).toBe("TestResults/agentry.trx");

    const enc = r.remote_busy_cmd!.match(/-EncodedCommand (\S+)'/)![1];
    const script = new TextDecoder("utf-16le").decode(Buffer.from(enc, "base64"));
    expect(script).toBe("$ProgressPreference = 'SilentlyContinue'; " + 'if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "install-service\\.ps1" }) { exit 0 } else { exit 1 }');
    expect((JSON.parse(json)._comment as string[]).join("\n")).toContain(script);

    // What deploy-prod-winhost.sh writes, as `type` prints it over ssh (CRLF).
    expect(parseVersion("0422045 2026-10-18 09:12\r\n")).toEqual({ short: "0422045", uncommitted: false });
    expect(parseVersion("0422045+uncommitted 2026-10-18 09:12\r\n")).toEqual({ short: "0422045", uncommitted: true });
  });
});
