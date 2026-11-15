import { describe, expect, test } from "bun:test";
import { projectNameForRoot } from "./project-name.ts";

describe("projectNameForRoot", () => {
  test("an ordinary project is named after its folder", () => {
    expect(projectNameForRoot("/Users/you/dev/openscout", "/Users/you")).toBe("openscout");
  });

  test("the home directory is never named after the user", () => {
    // The exact shape that once named an agent after the user.
    expect(projectNameForRoot("/Users/you", "/Users/you")).toBe("home");
    expect(projectNameForRoot("/Users/guest", "/Users/guest")).toBe("home");
  });

  test("a trailing slash or a relative hop is still home", () => {
    expect(projectNameForRoot("/Users/you/", "/Users/you")).toBe("home");
    expect(projectNameForRoot("/Users/you/dev/..", "/Users/you")).toBe("home");
  });

  test("a folder that merely shares the username is a real project", () => {
    // ~/you is a project called "you"; $HOME itself is not.
    expect(projectNameForRoot("/Users/you/you", "/Users/you")).toBe("you");
  });

  test("another user's home is not this operator's home", () => {
    expect(projectNameForRoot("/Users/guest", "/Users/you")).toBe("guest");
  });

  test("the filesystem root stays empty so callers fall back to \"agent\"", () => {
    expect(projectNameForRoot("/", "/Users/you")).toBe("");
  });

  test("empty in, empty out", () => {
    expect(projectNameForRoot("", "/Users/you")).toBe("");
    expect(projectNameForRoot("   ", "/Users/you")).toBe("");
  });

  test("a missing home never swallows a real project", () => {
    expect(projectNameForRoot("/Users/you/dev/openscout", "")).toBe("openscout");
  });
});
