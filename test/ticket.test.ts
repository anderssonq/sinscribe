import { describe, expect, it } from "vitest";
import {
  buildBranchName,
  extractTicketId,
  inferBranchType,
  sanitizeBranchRef,
  slugify,
} from "../src/git/ticket.js";

describe("extractTicketId", () => {
  it("finds Jira-style IDs in branch names", () => {
    expect(extractTicketId("feature/ABC-123-add-retries", {})).toBe("ABC-123");
    expect(extractTicketId("abc-123-lowercase", {})).toBe("ABC-123");
  });

  it("finds issue numbers", () => {
    expect(extractTicketId("fix/#42-crash", {})).toBe("#42");
  });

  it("returns null when nothing matches", () => {
    expect(extractTicketId("main", {})).toBeNull();
  });

  it("honors a custom pattern from the environment", () => {
    expect(
      extractTicketId("work/T-999-thing", {
        SINSCRIBE_TICKET_PATTERN: "(T-\\d+)",
      }),
    ).toBe("T-999");
  });
});

describe("slugify", () => {
  it("kebab-cases arbitrary text", () => {
    expect(slugify("Add retry LOGIC to uploader!")).toBe(
      "add-retry-logic-to-uploader",
    );
  });

  it("caps length at a word boundary", () => {
    const slug = slugify(
      "a very long description that goes on and on and should be cut",
    );

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("inferBranchType", () => {
  it("detects fixes and docs", () => {
    expect(inferBranchType("fix crash on save")).toBe("fix");
    expect(inferBranchType("update readme")).toBe("docs");
    expect(inferBranchType("add new upload flow")).toBe("feat");
  });
});

describe("buildBranchName", () => {
  it("combines type, ticket, and slug", () => {
    expect(buildBranchName("fix", "ABC-123", "crash on save")).toBe(
      "fix/ABC-123-crash-on-save",
    );
    expect(buildBranchName("feat", "#42", "upload flow")).toBe(
      "feat/42-upload-flow",
    );
    expect(buildBranchName("chore", null, "bump deps")).toBe("chore/bump-deps");
  });
});

describe("sanitizeBranchRef", () => {
  it("keeps a well-formed custom-format name intact", () => {
    expect(sanitizeBranchRef("feature/KDS-1234-users-landing-page")).toBe(
      "feature/KDS-1234-users-landing-page",
    );
  });

  it("preserves ticket casing and hierarchy slashes", () => {
    expect(sanitizeBranchRef("bugfix/ABC-9/login-redirect")).toBe(
      "bugfix/ABC-9/login-redirect",
    );
  });

  it("replaces spaces and illegal characters with dashes", () => {
    expect(sanitizeBranchRef("feature/add retry logic!?")).toBe(
      "feature/add-retry-logic",
    );
  });

  it("drops empty segments, leading/trailing separators, and '..'", () => {
    expect(sanitizeBranchRef("/feature//KDS-1..2-.name-/")).toBe(
      "feature/KDS-1.2-.name",
    );
  });

  it("strips a .lock suffix git would reject", () => {
    expect(sanitizeBranchRef("feature/thing.lock")).toBe("feature/thing");
  });

  it("returns null when nothing usable survives", () => {
    expect(sanitizeBranchRef("   ")).toBeNull();
    expect(sanitizeBranchRef("///")).toBeNull();
    expect(sanitizeBranchRef("@")).toBeNull();
  });
});
