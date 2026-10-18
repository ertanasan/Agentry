import { describe, expect, test } from "bun:test";
import { parseTrx, namedTestPassed } from "../src/results/trx.ts";

const trx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="a" testId="1" testName="VocaTrain.WN.Core.Tests.ReminderTests.TwoDeviceUser_GetsOneEmail" outcome="Passed" />
    <UnitTestResult executionId="b" testId="2" testName="VocaTrain.WN.Core.Tests.ReminderTests.Flaky" outcome="NotExecuted" />
    <UnitTestResult executionId="c" testId="3" testName="VocaTrain.WN.Core.Tests.LemmaTests.Sorts" outcome="Failed" />
  </Results>
  <ResultSummary outcome="Failed">
    <Counters total="3" executed="2" passed="1" failed="1" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="1" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`;

describe("parseTrx", () => {
  test("reads counters and per-test outcomes", () => {
    const r = parseTrx(trx);
    expect([r.total, r.passed, r.failed, r.skipped]).toEqual([3, 1, 1, 1]);
    expect(r.outcomes.get("VocaTrain.WN.Core.Tests.LemmaTests.Sorts")).toBe("Failed");
  });

  test("a file without counters is an error, not zero tests", () => {
    expect(() => parseTrx("<TestRun/>")).toThrow();
  });
});

describe("namedTestPassed", () => {
  const run = parseTrx(trx);
  test("passes when the named test ran and passed", () => {
    expect(namedTestPassed(run, "TwoDeviceUser_GetsOneEmail").ok).toBe(true);
  });
  test("fails when the test was skipped, failed or never ran", () => {
    expect(namedTestPassed(run, "Flaky").ok).toBe(false);
    expect(namedTestPassed(run, "LemmaTests.Sorts").ok).toBe(false);
    expect(namedTestPassed(run, "DoesNotExist").ok).toBe(false);
  });
});
