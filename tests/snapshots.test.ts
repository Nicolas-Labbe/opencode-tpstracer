import { describe, expect, it } from "vitest";
import { createEmptyAdapterSnapshot, createEmptyTreeSnapshot } from "../src/snapshots.js";

describe("empty snapshot factory", () => {
  it("returns fresh arrays and summary per adapter call", () => {
    const a = createEmptyAdapterSnapshot();
    const b = createEmptyAdapterSnapshot();
    expect(a.status).toBe("idle");
    expect(a.error).toBeNull();
    expect(a.samples).not.toBe(b.samples);
    expect(a.observations).not.toBe(b.observations);
    expect(a.summary).not.toBe(b.summary);
    // Mutating one snapshot never affects another (no shared singleton).
    (a.samples as unknown[]).push({ id: "x" });
    (a.observations as unknown[]).push({ id: "y" });
    expect(b.samples).toHaveLength(0);
    expect(b.observations).toHaveLength(0);
  });

  it("keeps the zero-summary contract (count 0, unknown as null, UI dash)", () => {
    const snap = createEmptyAdapterSnapshot();
    expect(snap.summary.count).toBe(0);
    expect(snap.summary.completedCount).toBe(0);
    expect(snap.summary.activeCount).toBe(0);
    expect(snap.summary.totalOutput).toBe(0);
    expect(snap.summary.totalDurationMs).toBe(0);
    expect(snap.summary.totalGenerated).toBe(0);
    expect(snap.summary.totalActiveDurationMs).toBe(0);
    expect(snap.summary.weightedTps).toBeNull();
    expect(snap.summary.weightedPrimaryTps).toBeNull();
    expect(snap.summary.last).toBeNull();
    expect(snap.summary.lastCompleted).toBeNull();
    expect(snap.summary.failedCount).toBe(0);
    expect(snap.summary.unfinishedCount).toBe(0);
  });

  it("returns fresh tree snapshots with independent root and children", () => {
    const a = createEmptyTreeSnapshot("root");
    const b = createEmptyTreeSnapshot("root");
    expect(a.status).toBe("idle");
    expect(a.rootSessionID).toBe("root");
    expect(a.rootTitle).toBeNull();
    expect(a.rootAgent).toBeNull();
    expect(a.activeDelegateID).toBeNull();
    expect(a.partial).toBe(false);
    expect(a.error).toBeNull();
    expect(a.children).not.toBe(b.children);
    expect(a.root).not.toBe(b.root);
    expect(a.root.samples).not.toBe(b.root.samples);
    expect(a.root.summary).not.toBe(b.root.summary);
    (a.children as unknown[]).push({ sessionID: "c1" });
    (a.root.samples as unknown[]).push({ id: "x" });
    expect(b.children).toHaveLength(0);
    expect(b.root.samples).toHaveLength(0);
  });
});
