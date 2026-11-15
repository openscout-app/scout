import { describe, expect, test } from "bun:test";

import { isResumableInPlaceFlight, readInPlaceCheckpoint } from "./checkpoint.js";

const typed = { phase: "typed", since: 1_000, at: 5_000, via: "tmux", location: "tmux work · %3", transcriptOffset: 4_096 };

describe("readInPlaceCheckpoint", () => {
  test("reads a held, a typing and a typed checkpoint", () => {
    expect(readInPlaceCheckpoint({ inPlace: { phase: "held", since: 1_000 } })).toEqual({ phase: "held", since: 1_000 });
    expect(readInPlaceCheckpoint({ inPlace: typed })).toEqual(typed);
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, phase: "typing", transcriptOffset: null } }))
      .toEqual({ ...typed, phase: "typing", transcriptOffset: null });
  });

  test("a missing, cleared or malformed checkpoint reads as none", () => {
    expect(readInPlaceCheckpoint(undefined)).toBeNull();
    expect(readInPlaceCheckpoint({})).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: undefined })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: "typed" })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { phase: "held" } })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { phase: "sent", since: 1_000 } })).toBeNull();
    // A typed checkpoint that does not say where is not one to act on.
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, at: undefined } })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, via: "carrier-pigeon" } })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, location: "" } })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, transcriptOffset: -1 } })).toBeNull();
    expect(readInPlaceCheckpoint({ inPlace: { ...typed, transcriptOffset: undefined } })).toBeNull();
  });
});

describe("isResumableInPlaceFlight", () => {
  test("only a running flight with a checkpoint whose reply wait has not run out", () => {
    expect(isResumableInPlaceFlight({ state: "running", metadata: { inPlace: typed } })).toBe(true);
    expect(isResumableInPlaceFlight({ state: "running", metadata: { inPlace: { phase: "held", since: 1_000 } } })).toBe(true);
    expect(isResumableInPlaceFlight({ state: "running", metadata: {} })).toBe(false);
    expect(isResumableInPlaceFlight({ state: "running", metadata: { inPlace: typed, requesterTimedOut: true } })).toBe(false);
    for (const state of ["completed", "failed", "cancelled", "queued", "waiting"]) {
      expect(isResumableInPlaceFlight({ state, metadata: { inPlace: typed } })).toBe(false);
    }
    expect(isResumableInPlaceFlight(undefined)).toBe(false);
  });
});
