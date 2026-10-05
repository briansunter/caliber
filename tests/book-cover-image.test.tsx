import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BookCoverImage } from "../src/components/BookCoverImage";

test("shows the book title and author while its cover is loading", () => {
  const markup = renderToStaticMarkup(
    <BookCoverImage
      bookId={42}
      title="The Cartographers: A Novel"
      author="Peng Shepherd"
      hasCover
      width={240}
      height={360}
    />,
  );

  expect(markup).toContain("The Cartographers: A Novel");
  expect(markup).toContain("Peng Shepherd");
  expect(markup).toContain('src="/api/books/42/thumb"');
  expect(markup).toContain("opacity-0");
});
