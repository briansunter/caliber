import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReaderLoadError } from "../src/routes/read-route";

test("a rejected reader chunk has an announced recovery screen and a route back to the library", () => {
  const markup = renderToStaticMarkup(<ReaderLoadError />);
  expect(markup).toContain('<main id="main-content"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain("The reader could not be loaded");
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('type="button"');
  expect(markup).toContain("Reload reader");
  expect(markup).toContain('href="/"');
  expect(markup).toContain("Back to library");
});
