import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireHostLease,
  hostLeaseMetadataPath,
  hostLeasePort,
  type HostLeaseName,
} from "../src/server/util/host-lease.ts";

// Every case names an explicit free port and a private metadata file, so nothing here can
// touch the lease a real daemon or E2E suite on this machine is holding.

async function fixture(): Promise<{ root: string; metadataPath: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "mission-host-lease-test-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return { root, metadataPath: join(root, "owner.json"), port: address.port };
}

const base = (name: HostLeaseName, port: number, metadataPath: string) => ({
  name,
  label: `${name} test lease`,
  port,
  metadataPath,
  pollMs: 5,
  waitMs: 2_000,
});

test("each lease name derives its own port and metadata file", () => {
  assert.notEqual(hostLeasePort("mission-control-e2e"), hostLeasePort("mission-check-tests"));
  assert.ok(hostLeasePort("mission-control-e2e") >= 21_800 && hostLeasePort("mission-control-e2e") < 22_800);
  assert.ok(hostLeasePort("mission-check-tests") >= 22_800 && hostLeasePort("mission-check-tests") < 23_800);
  assert.notEqual(hostLeaseMetadataPath("mission-control-e2e"), hostLeaseMetadataPath("mission-check-tests"));
  // The E2E lease keeps the file name it always had.
  assert.match(hostLeaseMetadataPath("mission-control-e2e"), /mission-control-e2e-[^/\\]+\.json$/);
});

test("two acquirers of the same name serialize, and release hands over", async () => {
  const { root, metadataPath, port } = await fixture();
  try {
    const first = await acquireHostLease(base("mission-check-tests", port, metadataPath));
    let waitedOn: number | null = null;
    let secondHeld = false;
    const second = acquireHostLease({
      ...base("mission-check-tests", port, metadataPath),
      onWaiting: (owner) => { waitedOn = owner?.pid ?? null; },
    }).then((lease) => {
      secondHeld = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondHeld, false);
    assert.equal(waitedOn, process.pid);
    await first.release();
    const lease = await second;
    assert.equal(secondHeld, true);
    await lease.release();
    // Released for good: a third acquirer does not wait at all.
    const third = await acquireHostLease({ ...base("mission-check-tests", port, metadataPath), waitMs: 0 });
    await third.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different names never wait on each other", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const e2e = await acquireHostLease(base("mission-control-e2e", a.port, a.metadataPath));
    const tests = await acquireHostLease({ ...base("mission-check-tests", b.port, b.metadataPath), waitMs: 0 });
    await tests.release();
    // And the protocols do not cross: a holder of one name is not mistaken for the other.
    await assert.rejects(
      acquireHostLease(base("mission-check-tests", a.port, b.metadataPath)),
      /not a compatible mission-check-tests test lease/,
    );
    await e2e.release();
  } finally {
    await rm(a.root, { recursive: true, force: true });
    await rm(b.root, { recursive: true, force: true });
  }
});

test("a crashed holder frees the lease with its socket", async () => {
  const { root, metadataPath, port } = await fixture();
  const script = `
    const { acquireHostLease } = await import(${JSON.stringify(new URL("../src/server/util/host-lease.ts", import.meta.url).href)});
    await acquireHostLease({ name: "mission-check-tests", label: "child", port: ${port}, metadataPath: ${JSON.stringify(metadataPath)}, waitMs: 1000 });
    console.log("held");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("held")) resolve(); });
      child.once("exit", (code) => reject(new Error(`child exited ${code} before holding`)));
    });
    await assert.rejects(
      acquireHostLease({ ...base("mission-check-tests", port, metadataPath), waitMs: 50 }),
      /Timed out waiting for the mission-check-tests test lease after 50ms\. It is held by pid/,
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const lease = await acquireHostLease(base("mission-check-tests", port, metadataPath));
    assert.equal(lease.owner.pid, process.pid);
    await lease.release();
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("the wait ceiling fails cleanly and leaves the holder intact", async () => {
  const { root, metadataPath, port } = await fixture();
  try {
    const holder = await acquireHostLease(base("mission-check-tests", port, metadataPath));
    await assert.rejects(
      acquireHostLease({ ...base("mission-check-tests", port, metadataPath), waitMs: 25 }),
      /Timed out waiting for the mission-check-tests test lease after 25ms/,
    );
    // The failed waiter took nothing: the holder's release still hands over normally.
    await holder.release();
    const next = await acquireHostLease({ ...base("mission-check-tests", port, metadataPath), waitMs: 0 });
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
