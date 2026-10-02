import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  darkTone,
  parseReaderPageInput,
  ReaderFooterShell,
  ReaderHeader,
  ReaderPageInput,
  themedTone,
} from "../src/components/ReaderChrome";
import { useFullscreen } from "../src/lib/use-fullscreen";

describe("reader page input", () => {
  test("rejects empty, fractional, and out-of-range drafts instead of navigating", () => {
    for (const draft of ["", " ", "0", "-1", "1.5", "35", "NaN", "Infinity"]) {
      expect(parseReaderPageInput(draft, 34)).toBeNull();
    }
  });

  test("accepts a complete page number and handles unknown page counts", () => {
    expect(parseReaderPageInput("34", 34)).toBe(34);
    expect(parseReaderPageInput("12", 34)).toBe(12);
    expect(parseReaderPageInput("1", 0)).toBe(1);
    expect(parseReaderPageInput("2", 0)).toBeNull();
  });

  test("retains the current page and total description in server markup", () => {
    const markup = renderToStaticMarkup(
      <ReaderPageInput value={12} max={34} onCommit={() => {}} describedById="page-total" />,
    );
    expect(markup).toContain('value="12"');
    expect(markup).toContain('aria-describedby="page-total"');
  });
});

describe("reader chrome accessibility", () => {
  for (const tone of [darkTone(), themedTone({ fg: "#111", barBg: "#fff", subtle: "#ddd" })]) {
    test(`hidden ${tone.kind} controls are inert and absent from the accessibility tree`, () => {
      const header = renderToStaticMarkup(
        <ReaderHeader title="Book" showUI={false} onBack={() => {}} overlay tone={tone}>
          <button type="button">Settings</button>
        </ReaderHeader>,
      );
      const footer = renderToStaticMarkup(
        <ReaderFooterShell showUI={false} overlay tone={tone}>
          <button type="button">Next</button>
        </ReaderFooterShell>,
      );
      for (const markup of [header, footer]) {
        expect(markup).toContain('inert=""');
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain("pointer-events:none");
      }
    });
  }

  test("visible controls remain available", () => {
    const markup = renderToStaticMarkup(
      <ReaderFooterShell showUI overlay tone={darkTone()}>
        <button type="button">Next</button>
      </ReaderFooterShell>,
    );
    expect(markup).not.toContain("inert=");
    expect(markup).toContain('aria-hidden="false"');
  });

  test("fullscreen can render in an environment without a document", () => {
    function FullscreenState() {
      const { isFullscreen, supported } = useFullscreen();
      return <span>{`${supported}:${isFullscreen}`}</span>;
    }
    expect(renderToStaticMarkup(<FullscreenState />)).toBe("<span>false:false</span>");
  });
});
