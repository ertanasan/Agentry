// Reads a .NET TRX test result file (dotnet test --logger "trx;LogFileName=agentry.trx").
// Skipped tests are reported by TRX as outcome "NotExecuted".

export type TestRun = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  outcomes: Map<string, string>; // fully qualified test name -> Passed | Failed | NotExecuted | ...
};

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

export function parseTrx(xml: string): TestRun {
  const outcomes = new Map<string, string>();
  for (const [tag] of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const name = attr(tag, "testName");
    const outcome = attr(tag, "outcome");
    if (name && outcome) outcomes.set(name, outcome);
  }
  const counters = xml.match(/<Counters\b[^>]*>/)?.[0];
  if (!counters) throw new Error("TRX file has no <Counters> element");
  const num = (n: string) => Number(attr(counters, n) ?? 0);
  return { total: num("total"), passed: num("passed"), failed: num("failed"), skipped: num("notExecuted"), outcomes };
}

// done_when_test check: at least one test matching the filter ran, and every matching test passed.
export function namedTestPassed(run: TestRun, filter: string): { ok: boolean; matched: string[] } {
  const matched = [...run.outcomes.keys()].filter((name) => name.includes(filter));
  return { ok: matched.length > 0 && matched.every((n) => run.outcomes.get(n) === "Passed"), matched };
}
