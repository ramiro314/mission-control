import assert from "node:assert/strict";
import test from "node:test";
import { junitCaseKey, parseJUnit } from "../src/shared/junit.ts";

// Captured from `node --test --test-reporter=junit` (Node 24 and 26 emit the same shape):
// top-level tests are bare <testcase>s, a `describe` becomes a <testsuite>, and a failure
// carries its message both as an attribute and as a <failure> child.
const NODE_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="passes" time="0.000313" classname="test" file="/repo/test/a.test.ts"/>
	<testcase name="fails &lt;here> &amp; &quot;there&quot;" time="0.0004" classname="test" file="/repo/test/a.test.ts" failure="Expected values to be strictly equal:&#10;&#10;1 !== 2&#10;">
		<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

1 !== 2
] {
  cause: AssertionError [ERR_ASSERTION]: at TestContext.&lt;anonymous> (file:///repo/test/a.test.ts:4:49)
}
		</failure>
	</testcase>
	<testsuite name="suite" time="0.0006" disabled="0" errors="0" tests="3" failures="1" skipped="1">
		<testcase name="inner fail" time="0.0003" classname="suite" file="/repo/test/a.test.ts" failure="boom">
			<failure type="testCodeFailure" message="boom">Error: boom</failure>
		</testcase>
		<testcase name="inner ok" time="0.00004" classname="suite" file="/repo/test/a.test.ts"/>
		<testcase name="skipped" time="0.00003" classname="suite" file="/repo/test/a.test.ts">
			<skipped type="skipped" message="true"/>
		</testcase>
	</testsuite>
	<!-- tests 5 -->
	<!-- fail 2 -->
</testsuites>
`;

test("reads Node's reporter output: flat tests, describe suites, failures and skips", () => {
  const parsed = parseJUnit(NODE_SAMPLE);
  assert.ok(parsed.ok);
  const cases = parsed.results.cases;
  assert.deepEqual(cases.map((c) => [c.name, c.classname, c.status]), [
    ["passes", "test", "passed"],
    ["fails <here> & \"there\"", "test", "failed"],
    ["inner fail", "suite", "failed"],
    ["inner ok", "suite", "passed"],
    ["skipped", "suite", "skipped"],
  ]);
  assert.ok(cases.every((c) => c.file === "/repo/test/a.test.ts"));
  const failed = cases[1]!;
  assert.equal(failed.message, "Expected values to be strictly equal:\n\n1 !== 2");
  assert.match(failed.detail ?? "", /TestContext\.<anonymous>/);
  assert.equal(cases[2]!.detail, "Error: boom");
  assert.equal(cases[0]!.message, null);
});

test("a single <testsuite> root, <error> children and CDATA are read too", () => {
  const parsed = parseJUnit(`<testsuite name="x"><testcase name="t" classname="C"><error message='bad'><![CDATA[stack <1>]]></error></testcase></testsuite>`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.results.cases, [{
    file: null,
    name: "t",
    classname: "C",
    status: "failed",
    message: "bad",
    detail: "stack <1>",
  }]);
});

test("malformed input is refused with a readable error, never a partial answer", () => {
  for (const bad of [
    "<testsuites><testcase name=\"a\"></testsuites>",
    "<testsuites><testcase name=\"a\">",
    "not xml at all",
    "<other/>",
    "<testsuites/><testsuites/>",
    "<testsuites><!-- never closed",
  ]) {
    const parsed = parseJUnit(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.match(parsed.error, /JUnit results/);
  }
});

test("a rerun compares by file, suite and name", () => {
  const a = { file: "t.ts", classname: "s", name: "x" };
  assert.equal(junitCaseKey(a), junitCaseKey({ ...a }));
  assert.notEqual(junitCaseKey(a), junitCaseKey({ ...a, classname: "other" }));
  assert.notEqual(junitCaseKey(a), junitCaseKey({ ...a, file: "u.ts" }));
});
