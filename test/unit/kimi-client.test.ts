// @ts-expect-error - CommonJS module without type definitions
import * as kimiClient from "../../native/kimi-client.cjs";

const { extractKimiResponse } = kimiClient;

describe("kimi-client", () => {
  describe("extractKimiResponse", () => {
    it("uses the original query marker when the sent prompt includes page context", () => {
      const query = "summarize this page";
      const bodyText = [
        "New Chat",
        "Page: https://example.test",
        "Secret page title",
        "Visible page content",
        "---",
        query,
        "The page is about Surf.",
        "Ask anything",
      ].join("\n");

      expect(extractKimiResponse(bodyText, query)).toBe("The page is about Surf.");
    });

    it("uses multi-line original query markers after page context", () => {
      const query = "summarize:\n- title\n- bullets";
      const bodyText = [
        "New Chat",
        "Page: https://example.test",
        "Secret page title",
        "Visible page content",
        "---",
        "summarize:",
        "- title",
        "- bullets",
        "The page is about Surf.",
        "Ask anything",
      ].join("\n");

      expect(extractKimiResponse(bodyText, query)).toBe("The page is about Surf.");
    });

    it("keeps punctuation-only lines in multi-line query markers", () => {
      const query = "summarize:\n---\nconclusion";
      const bodyText = [
        "New Chat",
        "Page: https://example.test",
        "Secret page title",
        "Visible page content",
        "---",
        "summarize:",
        "---",
        "conclusion",
        "The page is about Surf.",
        "Ask anything",
      ].join("\n");

      expect(extractKimiResponse(bodyText, query)).toBe("The page is about Surf.");
    });
  });
});
