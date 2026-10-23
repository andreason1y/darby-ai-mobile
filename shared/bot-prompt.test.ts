import { describe, expect, test } from "bun:test";
import {
  COMPUTER_GUIDANCE,
  LEGAL_GUIDANCE,
  PROVENANCE_GUIDANCE,
} from "./bot-prompt";

describe("COMPUTER_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(COMPUTER_GUIDANCE).toContain("\n\n");
    expect(COMPUTER_GUIDANCE).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of COMPUTER_GUIDANCE.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("still contains the full instruction text, unchanged in wording", () => {
    expect(COMPUTER_GUIDANCE).toContain(
      "You are a Bot with your own computer, a real web browser the person can watch you use.",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "Say what you found or did in plain language, briefly.",
    );
  });

  test("does not let the browser pass for a web search", () => {
    // Asked "can you search the web?", a Bot with only a browser said yes.
    expect(COMPUTER_GUIDANCE).toContain("Opening a page is not a web search.");
    expect(COMPUTER_GUIDANCE).toContain("cannot search");
  });
});

describe("LEGAL_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(LEGAL_GUIDANCE).toContain("\n\n");
    expect(LEGAL_GUIDANCE).not.toContain("  ");
  });

  test("forbids invented Indonesian citations", () => {
    expect(LEGAL_GUIDANCE).toContain("NEVER invent");
    expect(LEGAL_GUIDANCE).toContain("court decision number");
  });

  test("separates binding reasoning from supporting commentary", () => {
    expect(LEGAL_GUIDANCE).toContain("Ratio decidendi");
    expect(LEGAL_GUIDANCE).toContain("Obiter dicta");
    expect(LEGAL_GUIDANCE).toContain("not binding");
  });

  test("requires formal Indonesian citation and an unverified answer when evidence is missing", () => {
    expect(LEGAL_GUIDANCE).toContain("UU No. X Tahun Y Pasal Z");
    expect(LEGAL_GUIDANCE).toContain("Putusan MA No.");
    expect(LEGAL_GUIDANCE).toContain("tidak terverifikasi");
  });

  test("keeps redlining surgical and risk-labelled", () => {
    expect(LEGAL_GUIDANCE).toContain("surgical redlining");
    expect(LEGAL_GUIDANCE).toContain("commercial leverage");
    for (const severity of ["HIGH", "MEDIUM", "LOW"]) {
      expect(LEGAL_GUIDANCE).toContain(severity);
    }
  });
});

describe("PROVENANCE_GUIDANCE legal rules", () => {
  test("adds an absolute anti-fabrication rule for legal citations", () => {
    const guidance = PROVENANCE_GUIDANCE.toLowerCase().replace(/\s+/g, " ");
    expect(guidance).toContain("never invent a statute");
    expect(guidance).toContain("tidak terverifikasi");
    expect(guidance).toContain("ratio decidendi");
    expect(guidance).toContain("obiter dicta");
  });
});
