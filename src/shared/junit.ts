// JUnit XML results, read without a dependency.
//
// Pure and browser-safe on purpose: the daemon reads the `{junit}` file an `affected-tests`
// check wrote, and the CI flake report action bundles this module unchanged. It parses the
// subset test runners emit - `testsuites`, `testsuite`, `testcase` with `name`, `file` and
// `classname`, and `failure` / `error` / `skipped` children - and refuses anything that is not
// well-formed with a readable error rather than guessing at a partial answer.

export type JUnitCaseStatus = "passed" | "failed" | "skipped";

export interface JUnitCase {
  /** The test file, as the runner reported it (Node reports an absolute path), or null. */
  file: string | null;
  name: string;
  classname: string | null;
  status: JUnitCaseStatus;
  /** The failure's `message` attribute, or null when it passed or carried none. */
  message: string | null;
  /** The failure element's text (a stack or diff), trimmed, or null. */
  detail: string | null;
}

export interface JUnitResults {
  cases: JUnitCase[];
}

export type JUnitParse = { ok: true; results: JUnitResults } | { ok: false; error: string };

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: "\"",
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return safeCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  return String.fromCodePoint(code);
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ATTR = /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function matchAt(pattern: RegExp, input: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(input);
}

/** A minimal, strict XML reader: elements, attributes, text, comments, CDATA, declarations. */
function parseXml(input: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} at offset ${i}`);
  };
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) {
      top.text += decodeEntities(input.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(input.slice(i, lt));
    i = lt;
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
    } else if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9);
      if (end === -1) fail("unterminated CDATA section");
      top.text += input.slice(i + 9, end);
      i = end + 3;
    } else if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i + 2);
      if (end === -1) fail("unterminated declaration");
      i = end + 2;
    } else if (input.startsWith("<!", i)) {
      const end = input.indexOf(">", i + 2);
      if (end === -1) fail("unterminated doctype");
      i = end + 1;
    } else if (input.startsWith("</", i)) {
      const match = matchAt(NAME, input, i + 2);
      if (!match) fail("malformed closing tag");
      const name = match![0];
      const end = input.indexOf(">", i + 2 + name.length);
      if (end === -1 || input.slice(i + 2 + name.length, end).trim() !== "") fail("malformed closing tag");
      if (stack.length < 2 || top.name !== name) fail(`unexpected </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      const match = matchAt(NAME, input, i + 1);
      if (!match) fail("malformed tag");
      const element: XmlElement = { name: match![0], attrs: {}, children: [], text: "" };
      i += 1 + element.name.length;
      for (;;) {
        const attr = matchAt(ATTR, input, i);
        if (!attr) break;
        element.attrs[attr[1]!] = decodeEntities(attr[2] ?? attr[3] ?? "");
        i += attr[0].length;
      }
      while (i < input.length && /\s/.test(input[i]!)) i++;
      if (input.startsWith("/>", i)) {
        top.children.push(element);
        i += 2;
      } else if (input[i] === ">") {
        top.children.push(element);
        stack.push(element);
        i += 1;
      } else {
        fail(`malformed <${element.name}> tag`);
      }
    }
  }
  if (stack.length > 1) throw new Error(`unclosed <${stack[stack.length - 1]!.name}>`);
  return root;
}

function collectCases(element: XmlElement, into: JUnitCase[]): void {
  for (const child of element.children) {
    if (child.name === "testcase") {
      into.push(toCase(child));
    } else if (child.name === "testsuite" || child.name === "testsuites") {
      collectCases(child, into);
    }
  }
}

function toCase(element: XmlElement): JUnitCase {
  const failure = element.children.find((child) => child.name === "failure" || child.name === "error");
  const skipped = element.children.some((child) => child.name === "skipped");
  const detail = failure?.text.trim() ?? "";
  return {
    file: element.attrs.file ?? null,
    name: element.attrs.name ?? "(unnamed test)",
    classname: element.attrs.classname ?? null,
    status: failure ? "failed" : skipped ? "skipped" : "passed",
    message: failure ? failure.attrs.message ?? null : null,
    detail: failure && detail ? detail : null,
  };
}

/** Parse JUnit XML into its test cases, or say why it could not be read. */
export function parseJUnit(xml: string): JUnitParse {
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (err) {
    return { ok: false, error: `The JUnit results are not well-formed XML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const roots = doc.children;
  if (roots.length !== 1 || (roots[0]!.name !== "testsuites" && roots[0]!.name !== "testsuite")) {
    return { ok: false, error: "The JUnit results have no single <testsuites> or <testsuite> root." };
  }
  const cases: JUnitCase[] = [];
  collectCases(doc, cases);
  return { ok: true, results: { cases } };
}

export type JUnitFileTimes = { ok: true; times: Map<string, number> } | { ok: false; error: string };

/**
 * The first file a test case at or under `element` reports: its `file`, or its `classname`
 * where there is none, since Playwright writes no `file` and names each case's class after its
 * spec file.
 */
function firstCaseFile(element: XmlElement): string | null {
  if (element.name === "testcase") return element.attrs.file ?? element.attrs.classname ?? null;
  for (const child of element.children) {
    const file = firstCaseFile(child);
    if (file) return file;
  }
  return null;
}

function sumTopLevelTimes(element: XmlElement, into: Map<string, number>): void {
  for (const child of element.children) {
    if (child.name === "testsuites") {
      sumTopLevelTimes(child, into);
    } else if (child.name === "testsuite" || child.name === "testcase") {
      const file = firstCaseFile(child);
      const seconds = Number(child.attrs.time);
      if (!file || !Number.isFinite(seconds) || seconds < 0) continue;
      into.set(file, (into.get(file) ?? 0) + seconds * 1000);
    }
  }
}

/**
 * The milliseconds each test file took, keyed by the file the runner reported. Each top-level
 * `testsuite` or `testcase` counts once, at its own time: a suite's time covers its `before` and
 * `after` hooks as well as its cases, so summing the cases alone would miss a file whose cost is
 * in a suite hook. A suite belongs to the file its first case reports. An element with no such
 * file, or no readable `time`, adds nothing.
 */
export function junitFileTimes(xml: string): JUnitFileTimes {
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (err) {
    return { ok: false, error: `The JUnit results are not well-formed XML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const times = new Map<string, number>();
  sumTopLevelTimes(doc, times);
  return { ok: true, times };
}

/** The identity a rerun compares by: the same file and the same test name. */
export function junitCaseKey(testCase: Pick<JUnitCase, "file" | "classname" | "name">): string {
  return `${testCase.file ?? ""}\u0000${testCase.classname ?? ""}\u0000${testCase.name}`;
}
