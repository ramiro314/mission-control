import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-doc-links.mjs", import.meta.url));

test("documentation link checks ignore code examples and reject broken visible links", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-doc-links-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "e2e"));
    writeFileSync(join(root, "README.md"), "# Readme\n");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "e2e", "README.md"), "# E2E\n");
    writeFileSync(join(root, "docs", "target.md"), "# Target\n");
    writeFileSync(
      join(root, "docs", "examples.md"),
      [
        "# Examples",
        "",
        "`[inline example](missing-inline.md)`",
        "",
        "`[multi-line example]",
        "(missing-multiline.md)`",
        "",
        "```md",
        "[fenced example](missing-fenced.md)",
        "```",
        "",
        "[Real link](target.md#target)",
        "",
      ].join("\n"),
    );

    const output = execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.match(output, /Verified 5 Markdown files/);

    writeFileSync(join(root, "docs", "broken.md"), "[Broken](missing-visible.md)\n");
    assert.throws(
      () => execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "status" in error);
        assert.equal(error.status, 1);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heading anchors keep underscores the way GitHub renders them", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-doc-links-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "e2e"));
    writeFileSync(join(root, "README.md"), "# Readme\n");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "e2e", "README.md"), "# E2E\n");
    writeFileSync(
      join(root, "docs", "troubleshooting.md"),
      "# Troubleshooting\n\n## Every Claude turn prints a hook error with `MODULE_NOT_FOUND`\n",
    );
    writeFileSync(
      join(root, "docs", "setup.md"),
      "# Setup\n\nSee [the hook error](troubleshooting.md#every-claude-turn-prints-a-hook-error-with-module_not_found).\n",
    );

    const output = execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.match(output, /Verified 5 Markdown files/);

    writeFileSync(
      join(root, "docs", "collapsed.md"),
      "[Collapsed](troubleshooting.md#every-claude-turn-prints-a-hook-error-with-modulenotfound)\n",
    );
    assert.throws(
      () => execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "status" in error && "stderr" in error);
        assert.equal(error.status, 1);
        assert.match(String(error.stderr), /missing anchor: .*modulenotfound/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link that leaves the repository is refused, even toward a sibling sharing its name prefix", () => {
  const parent = mkdtempSync(join(tmpdir(), "mission-doc-links-"));
  const root = join(parent, "repo");
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "e2e"));
    mkdirSync(join(parent, "repo-sibling"));
    writeFileSync(join(root, "README.md"), "# Readme\n");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "e2e", "README.md"), "# E2E\n");
    writeFileSync(join(parent, "outside.md"), "# Outside\n");
    writeFileSync(join(parent, "repo-sibling", "near.md"), "# Near\n");
    writeFileSync(join(root, "docs", "escape.md"), "[Out](../../outside.md)\n\n[Near](../../repo-sibling/near.md)\n");

    assert.throws(
      () => execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "status" in error && "stderr" in error);
        assert.equal(error.status, 1);
        assert.match(String(error.stderr), /outside repository: \.\.\/\.\.\/outside\.md/);
        assert.match(String(error.stderr), /outside repository: \.\.\/\.\.\/repo-sibling\/near\.md/);
        return true;
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
