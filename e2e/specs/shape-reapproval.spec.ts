import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Fork (shape re-approval): a shape plan's review cycle asks for final-bundle approval on every
 * repaired revision. The human answers the first one; Foreman carries that answer onto the next.
 *
 * The shape session is the fake agent, so no model tokens are spent. The spec plays the agent's
 * side over the same authenticated MCP routes the bundled server calls.
 */

const EVIDENCE = artifactsDir("shape-reapproval");

interface SessionRow { id: string; cwd: string; state: string; agentSessionId: string | null; hooksSeen: boolean; task: { id: string } | null }
interface ReviewRow { id: string; sessionId: string; status: string; resolvedBy: string | null; response: string | null }

const token = (daemon: DaemonHandle): string => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function json<T>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${context} answered ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

const followUp = {
  id: "shape-follow-up",
  question: "What should happen after this plan is approved?",
  options: [
    { id: "create-tickets", label: "Create tickets after the plan merges", recommended: true },
    { id: "stop", label: "Stop", detail: "Keep the approved plan without creating tickets." },
  ],
};

test("after the first approval, Foreman approves the shape plan's repaired revisions", async ({ dashboard, daemon }) => {
  const skills = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills: { grill: true, "html-plans": true, tickets: true } }),
  });
  expect(skills.ok, "the shape skills should be enabled").toBe(true);
  const shape = await json<{ id: string }>(await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title: "Shape pack import", intent: "Shape how packs are imported.", kind: "shape", agent: "claude", workflowId: null, backlog: false }),
  }), "shape dispatch");
  let session!: SessionRow;
  await expect.poll(async () => {
    const sessions = await json<SessionRow[]>(await fetch(`${daemon.baseURL}/api/sessions`), "sessions");
    session = sessions.find((candidate) => candidate.task?.id === shape.id)!;
    return Boolean(session?.agentSessionId && session.hooksSeen && session.state !== "exited");
  }, { timeout: 60_000, message: "the fake shape agent should establish its session" }).toBe(true);

  const mcp = (path: string, body: object) => fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, sessionId: session.agentSessionId, cwd: session.cwd, ...body }),
  });
  let planId: string | undefined;
  const saveAndAsk = async (revision: number): Promise<string> => {
    const saved = await json<{ manifest: { planId: string } }>(await mcp("/mcp/plans/save", {
      repoSlot: "repo-01", slug: "pack-import", requestId: randomUUID(), expectedRevision: revision - 1, ...(planId ? { planId } : {}),
      files: [{ name: "plan.md", content: `# Pack import\n\nRevision ${revision}.` }, { name: "plan.html", content: `<h1>Pack import</h1><p>Revision ${revision}.</p>` }],
    }), `save revision ${revision}`);
    planId = saved.manifest.planId;
    const review = await json<{ id: string }>(await mcp("/mcp/v2/reviews", {
      kind: "plan-decisions", title: `Pack import: revision ${revision}`, body: "Review the plan.", decisions: [followUp],
      managedPlan: { repoSlot: "repo-01", planId, revision },
    }), `review revision ${revision}`);
    return review.id;
  };

  const first = await saveAndAsk(1);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const toReview = dashboard.locator(".console-detail").getByRole("button", { name: /to review/ });
  await toReview.click();
  const form = dashboard.locator(".review-modal");
  await expect(form.getByRole("radio", { name: /Create tickets after the plan merges/ })).toBeChecked();
  await form.getByRole("radio", { name: "Approve final bundle", exact: true }).check();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(form).toBeHidden();

  const second = await saveAndAsk(2);
  // The agent's own wait: it returns at once, because the form was settled when it was asked.
  const settled = async (id: string) => json<ReviewRow>(await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, { headers: { "x-harness-token": token(daemon) } }), "review wait");
  const carried = await settled(second);
  expect(carried.status).toBe("answered");
  expect(carried.resolvedBy).toBe("foreman");
  expect(carried.response).toContain("Foreman approved revision 2 on the operator's behalf, carrying forward their approval of revision 1.");
  expect((await settled(first)).resolvedBy).toBe("human");
  // Nothing is left for the human: no review button, and the form never opens.
  await expect(toReview).toHaveCount(0);
  await expect(form).toBeHidden();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}no-second-prompt.png` });
  }
});
