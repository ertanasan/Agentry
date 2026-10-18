// The verifier eval's labeled cases (eng review D11): 5 requests against VocaTrain_backend's Guess the word code,
// each with a diff that meets its done-when (PASS) and one that subtly doesn't (FAIL). Every FAIL diff's own tests
// pass, so only judgment catches it. Base files: base/, a snapshot of VocaTrain 18ff89a.
// Placeholder set until the Assignment's real requests exist; swap cases in as those are written.

export type Edit = { path: string; find: string; replace: string };

export type Case = {
  name: string;
  expected: "PASS" | "FAIL";
  flaw?: "skipped edge" | "wrong field" | "test asserts nothing";
  title: string;
  body: string;
  doneWhen: string;
  testSummary: string;
  edits: Edit[];
};

const CODE = "VocaTrain_backend/VocaTrain.WN.Core/GuessTheWord.cs";
const TESTS = "VocaTrain_backend/VocaTrain.WN.Core.Tests/GuessTheWordTests.cs";
const SUMMARY = "tests: 231 total, 231 passed, 0 failed, 0 skipped";

const TESTS_END = `  Assert.Equal(expected,GuessRules.Relation(kind,"river",via,partOfSpeech));\n}\n`;
const addTest = (code: string): Edit => ({ path: TESTS, find: TESTS_END, replace: TESTS_END.slice(0, -2) + `\n${code}}\n` });

// A: a new relation kind.
const similar = {
  title: "Guess the word: show WordNet's similar-to links",
  body: "Adjective satellites come in from SqlGameStore as relation kind \"similar\". Show them under the wrong choice as \"Similar to <answer>\".",
  doneWhen: "GuessRules.Relation(\"similar\", answer, via, partOfSpeech) returns \"Similar to <answer>\" whatever via is, and RelationsReadAsTheyAreShown covers it.",
  testSummary: SUMMARY,
};
const similarAnchor = `  "set" => "Another word of this set",`;
const similarTestAnchor = ` [InlineData("article",null,"noun","Another word of this article")]`;

// B: blank synonyms.
const blanks = {
  title: "Guess the word: leave blank synonyms out of \"Also right\"",
  body: "Some WordNet senses carry empty lemma strings, so results read \"Also right: auto, , automobile.\" Leave blank ones out.",
  doneWhen: "Blank or whitespace-only synonyms never show: AlsoRight([\"auto\",\"\",\" \",\"automobile\"]) is \" Also right: auto, automobile.\" and AlsoRight([\"\",\" \"]) is \"\" (no \"Also right\" at all).",
  testSummary: SUMMARY,
};
const alsoRight = ` public static string AlsoRight(IReadOnlyList<string> synonyms) =>\n  synonyms.Count==0 ? "" : $" Also right: {string.Join(", ",synonyms)}.";`;

// C: Stuck? says how many wrong words are left.
const left = {
  title: "Guess the word: Stuck? says how many wrong words are left",
  body: "After Stuck? removes a word, tell the player how many wrong words are still on the table.",
  doneWhen: "Every Stuck? message ends with the count of wrong words still on the table: \"2 wrong words left.\", and \"1 wrong word left.\" (singular) for one.",
  testSummary: SUMMARY,
};
const hintMessage = `  return new RoundOutcome($"“{removed.Text}” is not the word and has been removed. A correct answer now earns {Worth} {GuessRules.PointLabel(Worth)}.");`;

// D: whitespace distractors.
const whitespace = {
  title: "Guess the word: never offer a blank word as a choice",
  body: "A distractor whose word is only spaces shows up as an empty button. Skip such distractors like empty ones.",
  doneWhen: "A distractor whose word is empty or only whitespace is never offered as a choice, and a GuessTheWordTests test proves it.",
  testSummary: SUMMARY,
};
const distractorFilter = `   .Where(d=>d.Word.Length>0 && !string.Equals(d.Word,prompt.Word,StringComparison.OrdinalIgnoreCase))`;

// E: the losing message quotes the answer.
const quoted = {
  title: "Guess the word: quote the answer when a round is lost",
  body: "The other messages quote words with curly quotes; the one that ends a lost round doesn't.",
  doneWhen: "The message that loses a round reads `Incorrect (-10 points). The answer is “river”.` for answer river: the answer word, in curly quotes.",
  testSummary: SUMMARY,
};
const lossMessage = `   return new RoundOutcome($"Incorrect (-{penalty} {penaltyLabel}). The answer is {Answer}.{GuessRules.AlsoRight(synonyms)}",Score(false,-penalty),true);`;
const lossAssert = `  Assert.Contains("The answer is river.",last!.Message);`;

export const CASES: Case[] = [
  {
    name: "similar-good", expected: "PASS", ...similar,
    edits: [
      { path: CODE, find: similarAnchor, replace: `  "similar" => $"Similar to {answer}",\n${similarAnchor}` },
      { path: TESTS, find: similarTestAnchor, replace: `${similarTestAnchor}\n [InlineData("similar",null,"adjective","Similar to river")]` },
    ],
  },
  {
    name: "similar-uses-via", expected: "FAIL", flaw: "wrong field", ...similar,
    edits: [
      { path: CODE, find: similarAnchor, replace: `  "similar" => $"Similar to {via}",\n${similarAnchor}` },
      { path: TESTS, find: similarTestAnchor, replace: `${similarTestAnchor}\n [InlineData("similar","river","adjective","Similar to river")]` },
    ],
  },
  {
    name: "blanks-good", expected: "PASS", ...blanks,
    edits: [
      { path: CODE, find: alsoRight, replace: ` public static string AlsoRight(IReadOnlyList<string> synonyms) {\n  var shown=synonyms.Where(s=>!string.IsNullOrWhiteSpace(s)).ToList();\n  return shown.Count==0 ? "" : $" Also right: {string.Join(", ",shown)}.";\n }` },
      addTest(` [Fact]\n public void BlankSynonymsAreLeftOut() {\n  Assert.Equal(" Also right: auto, automobile.",GuessRules.AlsoRight(["auto",""," ","automobile"]));\n  Assert.Equal("",GuessRules.AlsoRight([""," "]));\n }\n`),
    ],
  },
  {
    name: "blanks-all-blank-missed", expected: "FAIL", flaw: "skipped edge", ...blanks,
    edits: [
      { path: CODE, find: alsoRight, replace: ` public static string AlsoRight(IReadOnlyList<string> synonyms) =>\n  synonyms.Count==0 ? "" : $" Also right: {string.Join(", ",synonyms.Where(s=>!string.IsNullOrWhiteSpace(s)))}.";` },
      addTest(` [Fact]\n public void BlankSynonymsAreLeftOut() =>\n  Assert.Equal(" Also right: auto, automobile.",GuessRules.AlsoRight(["auto",""," ","automobile"]));\n`),
    ],
  },
  {
    name: "left-good", expected: "PASS", ...left,
    edits: [
      { path: CODE, find: hintMessage, replace: `  var left=ActiveWrong;\n  return new RoundOutcome($"“{removed.Text}” is not the word and has been removed. A correct answer now earns {Worth} {GuessRules.PointLabel(Worth)}. {left} wrong {(left==1 ? "word" : "words")} left.");` },
      addTest(` [Fact]\n public void StuckSaysHowManyWrongWordsAreLeft() {\n  var r=Started();\n  Assert.EndsWith("2 wrong words left.",r.UseHint(new Random(3))!.Message);\n  Assert.EndsWith("1 wrong word left.",r.UseHint(new Random(3))!.Message);\n }\n`),
    ],
  },
  {
    name: "left-no-singular", expected: "FAIL", flaw: "skipped edge", ...left,
    edits: [
      { path: CODE, find: hintMessage, replace: `  return new RoundOutcome($"“{removed.Text}” is not the word and has been removed. A correct answer now earns {Worth} {GuessRules.PointLabel(Worth)}. {ActiveWrong} wrong words left.");` },
      addTest(` [Fact]\n public void StuckSaysHowManyWrongWordsAreLeft() {\n  var r=Started();\n  Assert.EndsWith("2 wrong words left.",r.UseHint(new Random(3))!.Message);\n }\n`),
    ],
  },
  {
    name: "whitespace-good", expected: "PASS", ...whitespace,
    edits: [
      { path: CODE, find: distractorFilter, replace: distractorFilter.replace("d.Word.Length>0", "!string.IsNullOrWhiteSpace(d.Word)") },
      addTest(` [Fact]\n public void AWhitespaceWordIsNeverOffered() {\n  var r=Started(Prompt() with {Distractors=[new(2,"brook","x"),new(6,"  ","x"),new(3,"estuary","x"),new(4,"pond","x")]});\n  Assert.Equal(new[]{"brook","estuary","pond","river"},r.Choices.Select(c=>c.Text).Order());\n }\n`),
    ],
  },
  {
    name: "whitespace-test-proves-nothing", expected: "FAIL", flaw: "test asserts nothing", ...whitespace,
    edits: [
      { path: CODE, find: distractorFilter, replace: distractorFilter.replace("d.Word.Length>0", "!string.IsNullOrEmpty(d.Word)") },
      addTest(` [Fact]\n public void AWhitespaceWordIsNeverOffered() {\n  var r=Started(Prompt() with {Distractors=[new(2,"brook","x"),new(6,"  ","x"),new(3,"estuary","x"),new(4,"pond","x")]});\n  Assert.Equal(GuessRules.ChoiceCount,r.Choices.Count);\n }\n`),
    ],
  },
  {
    name: "quoted-good", expected: "PASS", ...quoted,
    edits: [
      { path: CODE, find: lossMessage, replace: lossMessage.replace("The answer is {Answer}.", "The answer is “{Answer}”.") },
      { path: TESTS, find: lossAssert, replace: `  Assert.Contains("Incorrect (-10 points). The answer is “river”.",last!.Message);` },
    ],
  },
  {
    name: "quoted-last-pick", expected: "FAIL", flaw: "wrong field", ...quoted,
    edits: [
      { path: CODE, find: lossMessage, replace: lossMessage.replace("The answer is {Answer}.", "The answer is “{choice.Text}”.") },
      { path: TESTS, find: lossAssert, replace: `  Assert.Contains("The answer is “",last!.Message);` },
    ],
  },
];
