// Type definitions for Calibre database entities

export interface Book {
  id: number;
  title: string;
  sort: string | null;
  timestamp: string;
  pubdate: string;
  series_index: number;
  author_sort: string | null;
  isbn: string;
  lccn: string;
  path: string;
  flags: number;
  uuid: string | null;
  has_cover: boolean;
  last_modified: string;
}

export interface Author {
  id: number;
  name: string;
  sort: string | null;
  link: string;
}

export interface Tag {
  id: number;
  name: string;
  link: string;
}

export interface Series {
  id: number;
  name: string;
  sort: string | null;
  link: string;
}

export interface Publisher {
  id: number;
  name: string;
  sort: string | null;
  link: string;
}

export interface Rating {
  id: number;
  rating: number;
  link: string;
}

export interface BookFormat {
  id: number;
  book: number;
  format: string;
  uncompressed_size: number;
  name: string;
}

export interface Comment {
  id: number;
  book: number;
  text: string;
}

export interface BookAuthorLink {
  id: number;
  book: number;
  author: number;
}

export interface BookTagLink {
  id: number;
  book: number;
  tag: number;
}

export interface BookSeriesLink {
  id: number;
  book: number;
  series: number;
}

export interface BookPublisherLink {
  id: number;
  book: number;
  publisher: number;
}

export interface BookRatingLink {
  id: number;
  book: number;
  rating: number;
}

// Extended types with joined data
// Note: API returns simplified structures, not full entity objects
export interface BookWithMetadata extends Book {
  authors: string[];  // API returns array of author names, not Author objects
  tags: string[];     // API returns array of tag names, not Tag objects
  series: string | null;  // API returns series name string, not Series object
  publisher: string | null;  // API may return publisher name
  rating: number | null;     // API may return rating value
  formats: BookFormat[];
  comments: string | null;
}

export interface BookListItem {
  id: number;
  title: string;
  author_sort: string | null;
  authors: string[];
  series: string | null;
  series_index: number;
  tags: string[];
  formats: string[];
  has_cover: boolean;
  pubdate: string;
  timestamp: string;
  rating?: number | null;
}
