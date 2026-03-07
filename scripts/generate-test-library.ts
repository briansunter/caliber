#!/usr/bin/env bun
/**
 * Generate a massive Calibre test library with 1M+ books
 * Uses the same schema as real Calibre databases
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_LIBRARY_PATH = "/tmp/calibre-test-library-huge";
const DB_PATH = join(TEST_LIBRARY_PATH, "metadata.db");

// Test data generators
const FIRST_NAMES = [
  "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
  "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
  "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Nancy", "Daniel", "Lisa",
  "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
  "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle",
  "Kenneth", "Dorothy", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa",
  "Edward", "Deborah", "Ronald", "Stephanie", "Timothy", "Rebecca", "Jason", "Sharon",
  "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob", "Kathleen", "Gary", "Amy",
  "Nicholas", "Shirley", "Eric", "Angela", "Jonathan", "Helen", "Stephen", "Anna",
  "Larry", "Brenda", "Justin", "Pamela", "Scott", "Nicole", "Brandon", "Emma",
  "Benjamin", "Samantha", "Samuel", "Katherine", "Gregory", "Christine", "Frank", "Debra",
  "Alexander", "Rachel", "Raymond", "Catherine", "Patrick", "Carolyn", "Jack", "Janet",
  "Dennis", "Ruth", "Jerry", "Maria", "Tyler", "Heather", "Aaron", "Diane",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas",
  "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
  "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young",
  "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
  "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker",
  "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy",
  "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey",
  "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson",
  "Watson", "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza",
  "Ruiz", "Hughes", "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers",
  "Long", "Ross", "Foster", "Jimenez", "Powell", "Jenkins", "Perry", "Russell",
];

const ADJECTIVES = [
  "Silent", "Hidden", "Lost", "Dark", "Golden", "Silver", "Crystal", "Shadow",
  "Broken", "Eternal", "Forbidden", "Ancient", "Secret", "Mystic", "Hidden", "Last",
  "First", "Final", "Infinite", "Limited", "Complete", "Absolute", "Relative", "Total",
  "Supreme", "Ultimate", "Perfect", "Ideal", "Virtual", "Digital", "Physical", "Mental",
  "Spiritual", "Natural", "Artificial", "Synthetic", "Organic", "Chemical", "Nuclear", "Atomic",
  "Cosmic", "Global", "Universal", "Galactic", "Planetary", "Terrestrial", "Celestial", "Heavenly",
  "Hellish", "Demonic", "Angelic", "Divine", "Sacred", "Profane", "Holy", "Unholy",
  "Blessed", "Cursed", "Lucky", "Unlucky", "Fortunate", "Unfortunate", "Happy", "Sad",
  "Joyful", "Sorrowful", "Angry", "Peaceful", "Violent", "Gentle", "Strong", "Weak",
  "Powerful", "Powerless", "Rich", "Poor", "Wealthy", "Destitute", "Abundant", "Scarce",
  "Beautiful", "Ugly", "Pretty", "Hideous", "Attractive", "Repulsive", "Pleasant", "Unpleasant",
  "Delightful", "Distressing", "Comfortable", "Uncomfortable", "Easy", "Difficult", "Simple", "Complex",
  "Complicated", "Straightforward", "Direct", "Indirect", "Clear", "Unclear", "Obvious", "Subtle",
];

const NOUNS = [
  "Echo", "Storm", "Garden", "Empire", "Kingdom", "Realm", "World", "Universe",
  "Star", "Planet", "Moon", "Sun", "Sky", "Ocean", "Sea", "River",
  "Mountain", "Valley", "Forest", "Desert", "Island", "Continent", "City", "Village",
  "Tower", "Castle", "Palace", "Temple", "Church", "Mosque", "Synagogue", "Shrine",
  "Gate", "Door", "Window", "Wall", "Bridge", "Road", "Path", "Way",
  "Journey", "Quest", "Mission", "Adventure", "Odyssey", "Pilgrimage", "Voyage", "Expedition",
  "Sword", "Shield", "Armor", "Weapon", "Tool", "Instrument", "Machine", "Device",
  "Artifact", "Relic", "Treasure", "Jewel", "Gem", "Stone", "Rock", "Crystal",
  "Book", "Scroll", "Manuscript", "Text", "Code", "Cipher", "Secret", "Mystery",
  "Legend", "Myth", "Fable", "Story", "Tale", "History", "Chronicle", "Record",
  "Memory", "Dream", "Vision", "Nightmare", "Fantasy", "Reality", "Truth", "Lie",
  "Justice", "Injustice", "Freedom", "Slavery", "Peace", "War", "Love", "Hate",
  "Life", "Death", "Birth", "Rebirth", "Creation", "Destruction", "Beginning", "End",
  "Origin", "Destination", "Source", "Target", "Cause", "Effect", "Reason", "Purpose",
];

const SERIES_NAMES = [
  "The Chronicles of", "The Saga of", "The Tales of", "The Legends of",
  "The History of", "The Book of", "The War of", "The Fall of",
  "The Rise of", "The Return of", "The Reign of", "The Age of",
  "The Era of", "The Time of", "The Days of", "The Nights of",
  "The Shadow of", "The Light of", "The Fire of", "The Ice of",
  "The Blood of", "The Honor of", "The Glory of", "The Doom of",
  "The Fate of", "The Destiny of", "The Prophecy of", "The Curse of",
  "The Blessing of", "The Gift of", "The Power of", "The Magic of",
  "The Mystery of", "The Secret of", "The Truth of", "The Lie of",
  "The Dream of", "The Nightmare of", "The Hope of", "The Fear of",
  "The Joy of", "The Sorrow of", "The Love of", "The Hate of",
  "The Life of", "The Death of", "The Birth of", "The Rebirth of",
  "The Creation of", "The Destruction of", "The Beginning of", "The End of",
];

const TAGS = [
  "fiction", "non-fiction", "sci-fi", "fantasy", "mystery", "thriller", "romance", "horror",
  "historical", "biography", "autobiography", "memoir", "self-help", "business", "finance", "economics",
  "politics", "philosophy", "psychology", "science", "technology", "computers", "programming", "software",
  "hardware", "networking", "security", "hacking", "data", "analytics", "statistics", "mathematics",
  "physics", "chemistry", "biology", "medicine", "health", "fitness", "nutrition", "cooking",
  "food", "travel", "adventure", "sports", "games", "art", "music", "photography",
  "design", "architecture", "history", "war", "military", "espionage", "crime", "detective",
  "police", "legal", "courtroom", "drama", "comedy", "satire", "poetry", "drama",
  "classic", "modern", "contemporary", "vintage", "rare", "collectible", "limited", "special",
  "award-winning", "bestseller", "popular", "obscure", "underground", "indie", "mainstream", "commercial",
  "literary", "genre", "pulp", "paperback", "hardcover", "ebook", "audiobook", "comic",
  "manga", "graphic-novel", "anthology", "collection", "omnibus", "complete", "abridged", "unabridged",
  "illustrated", "annotated", "translated", "original", "revised", "updated", "expanded", "condensed",
  "academic", "scholarly", "research", "reference", "textbook", "manual", "guide", "handbook",
  "encyclopedia", "dictionary", "thesaurus", "atlas", "almanac", "directory", "catalog", "index",
];

const PUBLISHERS = [
  "Penguin Random House", "HarperCollins", "Simon & Schuster", "Hachette Book Group",
  "Macmillan Publishers", "Scholastic", "Disney Publishing", "Bloomsbury",
  "Oxford University Press", "Cambridge University Press", "Harvard University Press", "Yale University Press",
  "MIT Press", "University of Chicago Press", "Stanford University Press", "Princeton University Press",
  "Random House", "Doubleday", "Knopf", "Crown Publishing", "Viking Press", "G.P. Putnam's Sons",
  "Little, Brown and Company", "Grand Central Publishing", "St. Martin's Press", "Tor Books",
  "Orbit Books", "Baen Books", "DAW Books", "Ace Books", "Del Rey", "Bantam Books",
  "Ballantine Books", "Broadway Books", "Vintage Books", "Anchor Books", "Picador", "Farrar, Straus and Giroux",
  "Grove Atlantic", "W.W. Norton", "Liveright Publishing", "Pantheon Books", "Vintage Crime/Black Lizard",
  "Everyman's Library", "Library of America", "New York Review Books", "NYU Press", "Columbia University Press",
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomItem<T>(arr: T[]): T {
  if (arr.length === 0) {
    throw new Error("randomItem requires a non-empty array");
  }
  return arr[randomInt(0, arr.length - 1)]!;
}

function randomItems<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function generateTitle(): string {
  const patterns = [
    () => `${randomItem(ADJECTIVES)} ${randomItem(NOUNS)}`,
    () => `The ${randomItem(ADJECTIVES)} ${randomItem(NOUNS)}`,
    () => `${randomItem(NOUNS)} of ${randomItem(NOUNS)}`,
    () => `The ${randomItem(NOUNS)} ${randomItem(NOUNS)}`,
    () => `${randomItem(ADJECTIVES)} ${randomItem(NOUNS)} of ${randomItem(NOUNS)}`,
    () => `The ${randomItem(ADJECTIVES)} ${randomItem(NOUNS)} of ${randomItem(NOUNS)}`,
    () => `${randomItem(NOUNS)} and ${randomItem(NOUNS)}`,
    () => `${randomItem(ADJECTIVES)} ${randomItem(NOUNS)} and ${randomItem(NOUNS)}`,
  ];
  return randomItem(patterns)();
}

function generateAuthor(): { name: string; sort: string } {
  const firstName = randomItem(FIRST_NAMES);
  const lastName = randomItem(LAST_NAMES);
  const name = `${firstName} ${lastName}`;
  const sort = `${lastName}, ${firstName}`;
  return { name, sort };
}

function generateISBN(): string {
  // Generate valid-looking ISBN-13
  const prefix = "978";
  const group = String(randomInt(0, 9));
  const publisher = String(randomInt(1000, 9999));
  const title = String(randomInt(10000, 99999));
  const isbn = `${prefix}${group}${publisher}${title}`;
  // Calculate check digit
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(isbn.charAt(i), 10) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return isbn + checkDigit;
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateDate(start: Date, end: Date): string {
  const timestamp = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  return new Date(timestamp).toISOString().replace("T", " ").split(".")[0] ?? "";
}

function generateComment(): string | null {
  if (Math.random() > 0.7) return null;
  const templates = [
    `A ${randomItem(ADJECTIVES).toLowerCase()} tale of ${randomItem(NOUNS).toLowerCase()} and ${randomItem(NOUNS).toLowerCase()}.`,
    `The ${randomItem(ADJECTIVES).toLowerCase()} ${randomItem(NOUNS).toLowerCase()} that changed everything.`,
    `An ${randomItem(ADJECTIVES).toLowerCase()} journey through ${randomItem(NOUNS).toLowerCase()}.`,
    `Exploring the depths of ${randomItem(NOUNS).toLowerCase()} in a ${randomItem(ADJECTIVES).toLowerCase()} world.`,
    `A masterpiece of ${randomItem(ADJECTIVES).toLowerCase()} storytelling.`,
    `${randomItem(ADJECTIVES)} and ${randomItem(ADJECTIVES).toLowerCase()}, this book delivers.`,
    `The definitive guide to ${randomItem(NOUNS).toLowerCase()}.`,
    `A ${randomItem(ADJECTIVES).toLowerCase()} exploration of ${randomItem(NOUNS).toLowerCase()}.`,
  ];
  return randomItem(templates);
}

async function createTestLibrary(bookCount: number = 1_000_000) {
  console.log(`🚀 Creating test Calibre library with ${bookCount.toLocaleString()} books...`);

  // Create directory
  await mkdir(TEST_LIBRARY_PATH, { recursive: true });

  // Remove existing DB
  try {
    await Bun.file(DB_PATH).delete();
  } catch { /* ignore */ }

  // Create database
  const db = new Database(DB_PATH);

  // Create tables (Calibre schema)
  console.log("📦 Creating database schema...");
  db.exec(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sort TEXT,
      link TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      sort TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      pubdate TEXT DEFAULT '2000-01-01 00:00:00+00:00',
      series_index REAL NOT NULL DEFAULT 1.0,
      author_sort TEXT,
      isbn TEXT DEFAULT '' COLLATE NOCASE,
      lccn TEXT DEFAULT '' COLLATE NOCASE,
      path TEXT NOT NULL,
      flags INTEGER NOT NULL DEFAULT 1,
      uuid TEXT NOT NULL,
      has_cover INTEGER DEFAULT 0,
      last_modified TEXT DEFAULT '2000-01-01 00:00:00+00:00'
    );

    CREATE TABLE books_authors_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      author INTEGER NOT NULL,
      UNIQUE(book, author)
    );

    CREATE TABLE books_languages_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      lang_code INTEGER NOT NULL,
      item_order INTEGER NOT NULL DEFAULT 0,
      link TEXT DEFAULT '' COLLATE NOCASE,
      UNIQUE(book, lang_code)
    );

    CREATE TABLE books_plugin_data (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      name TEXT NOT NULL,
      val TEXT NOT NULL,
      UNIQUE(book, name)
    );

    CREATE TABLE books_publishers_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      publisher INTEGER NOT NULL,
      UNIQUE(book, publisher)
    );

    CREATE TABLE books_ratings_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      UNIQUE(book, rating)
    );

    CREATE TABLE books_series_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      series INTEGER NOT NULL,
      UNIQUE(book)
    );

    CREATE TABLE books_tags_link (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      tag INTEGER NOT NULL,
      UNIQUE(book, tag)
    );

    CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE conversion_options (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      format TEXT NOT NULL,
      data BLOB NOT NULL,
      UNIQUE(book, format)
    );

    CREATE TABLE custom_columns (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      datatype TEXT NOT NULL,
      mark_for_delete INTEGER NOT NULL DEFAULT 0,
      editable INTEGER NOT NULL DEFAULT 1,
      display TEXT NOT NULL DEFAULT '{}' COLLATE NOCASE,
      is_multiple INTEGER NOT NULL DEFAULT 0,
      normalized INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE data (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      format TEXT NOT NULL COLLATE NOCASE,
      uncompressed_size INTEGER NOT NULL,
      name TEXT
    );

    CREATE TABLE feeds (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      script TEXT NOT NULL,
      updated TEXT
    );

    CREATE TABLE identifiers (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE,
      val TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(book, type)
    );

    CREATE TABLE languages (
      id INTEGER PRIMARY KEY,
      lang_code TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE library_id (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      uuid TEXT NOT NULL
    );

    CREATE TABLE metadata_dirtied (
      id INTEGER PRIMARY KEY,
      book INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE preferences (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE COLLATE NOCASE,
      val TEXT NOT NULL
    );

    CREATE TABLE publishers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      sort TEXT COLLATE NOCASE
    );

    CREATE TABLE ratings (
      id INTEGER PRIMARY KEY,
      rating INTEGER NOT NULL CHECK(rating > 0 AND rating < 11) UNIQUE
    );

    CREATE TABLE series (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      sort TEXT COLLATE NOCASE
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    -- Create indexes
    CREATE INDEX authors_idx ON authors(sort);
    CREATE INDEX books_idx ON books(sort);
    CREATE INDEX books_authors_link_aidx ON books_authors_link(author);
    CREATE INDEX books_authors_link_bidx ON books_authors_link(book);
    CREATE INDEX books_languages_link_bidx ON books_languages_link(book);
    CREATE INDEX books_publishers_link_a_idx ON books_publishers_link(publisher);
    CREATE INDEX books_publishers_link_b_idx ON books_publishers_link(book);
    CREATE INDEX books_ratings_link_bidx ON books_ratings_link(book);
    CREATE INDEX books_series_link_book_idx ON books_series_link(book);
    CREATE INDEX books_tags_link_aidx ON books_tags_link(tag);
    CREATE INDEX books_tags_link_bidx ON books_tags_link(book);
    CREATE INDEX comments_idx ON comments(book);
    CREATE INDEX data_book_index ON data(book);
    CREATE INDEX data_format_index ON data(format);
    CREATE INDEX publishers_idx ON publishers(sort);
    CREATE INDEX series_idx ON series(sort);
    CREATE INDEX tags_idx ON tags(name);
  `);

  // Prepare statements for bulk insertion
  const insertAuthor = db.query("INSERT INTO authors (name, sort, link) VALUES (?, ?, '')");
  const insertBook = db.query(`
    INSERT INTO books (title, sort, timestamp, pubdate, series_index, author_sort, isbn, lccn, path, flags, uuid, has_cover, last_modified)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 1, ?, ?, ?)
  `);
  const insertBooksAuthorsLink = db.query("INSERT INTO books_authors_link (book, author) VALUES (?, ?)");
  const insertBooksTagsLink = db.query("INSERT INTO books_tags_link (book, tag) VALUES (?, ?)");
  const insertBooksSeriesLink = db.query("INSERT INTO books_series_link (book, series) VALUES (?, ?)");
  const insertBooksPublishersLink = db.query("INSERT INTO books_publishers_link (book, publisher) VALUES (?, ?)");
  const insertBooksRatingsLink = db.query("INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)");
  const insertTag = db.query("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertSeries = db.query("INSERT OR IGNORE INTO series (name, sort) VALUES (?, ?)");
  const insertPublisher = db.query("INSERT OR IGNORE INTO publishers (name, sort) VALUES (?, ?)");
  const insertRating = db.query("INSERT OR IGNORE INTO ratings (rating) VALUES (?)");
  const insertData = db.query("INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)");
  const insertComment = db.query("INSERT INTO comments (book, text) VALUES (?, ?)");

  // Pre-populate ratings
  for (let i = 1; i <= 10; i++) {
    insertRating.run(i);
  }

  // Pre-populate some tags
  console.log("🏷️  Creating tags...");
  const tagIds = new Map<string, number>();
  for (const tag of TAGS.slice(0, 100)) {
    insertTag.run(tag);
    const row = db.query("SELECT id FROM tags WHERE name = ?").get(tag) as { id: number } | undefined;
    if (row) tagIds.set(tag, row.id);
  }

  // Track unique authors, series, publishers
  const authorIds = new Map<string, number>();
  const seriesIds = new Map<string, number>();
  const publisherIds = new Map<string, number>();

  const formats = ["EPUB", "MOBI", "AZW3", "PDF", "TXT"];

  // Generate books in batches
  const batchSize = 10000;
  const totalBatches = Math.ceil(bookCount / batchSize);

  console.log(`📝 Generating ${bookCount.toLocaleString()} books in ${totalBatches} batches...`);

  const startTime = Date.now();

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * batchSize + 1;
    const batchEnd = Math.min((batch + 1) * batchSize, bookCount);

    db.transaction(() => {
      for (let i = batchStart; i <= batchEnd; i++) {
        const title = generateTitle();
        const author = generateAuthor();
        const hasCover = Math.random() > 0.3 ? 1 : 0;
        const pubdate = generateDate(new Date(1900, 0, 1), new Date(2024, 11, 31));
        const timestamp = generateDate(new Date(2010, 0, 1), new Date(2024, 11, 31));
        const lastModified = generateDate(new Date(2020, 0, 1), new Date(2024, 11, 31));
        const uuid = generateUUID();
        const isbn = generateISBN();
        const path = `Unknown/${title.replace(/[^a-zA-Z0-9]/g, ' ').trim().slice(0, 50)} (${uuid})`;
        const authorSort = author.sort;

        // Insert book
        insertBook.run(
          title,
          title.toLowerCase(),
          timestamp,
          pubdate,
          randomInt(1, 20), // series_index
          authorSort,
          isbn,
          path,
          uuid,
          hasCover,
          lastModified
        );

        // Get book ID
        const bookId = i;

        // Insert author if new
        if (!authorIds.has(author.name)) {
          insertAuthor.run(author.name, author.sort);
          const row = db.query("SELECT id FROM authors WHERE name = ?").get(author.name) as { id: number } | undefined;
          if (row) authorIds.set(author.name, row.id);
        }
        const authorId = authorIds.get(author.name);
        if (authorId) insertBooksAuthorsLink.run(bookId, authorId);

        // Maybe add to series (50% chance)
        if (Math.random() > 0.5) {
          const seriesName = `${randomItem(SERIES_NAMES)} ${randomItem(NOUNS)}`;
          if (!seriesIds.has(seriesName)) {
            insertSeries.run(seriesName, seriesName.toLowerCase());
            const row = db.query("SELECT id FROM series WHERE name = ?").get(seriesName) as { id: number } | undefined;
            if (row) seriesIds.set(seriesName, row.id);
          }
          const seriesId = seriesIds.get(seriesName);
          if (seriesId) insertBooksSeriesLink.run(bookId, seriesId);
        }

        // Maybe add publisher (70% chance)
        if (Math.random() > 0.3) {
          const publisherName = randomItem(PUBLISHERS);
          if (!publisherIds.has(publisherName)) {
            insertPublisher.run(publisherName, publisherName.toLowerCase());
            const row = db.query("SELECT id FROM publishers WHERE name = ?").get(publisherName) as { id: number } | undefined;
            if (row) publisherIds.set(publisherName, row.id);
          }
          const publisherId = publisherIds.get(publisherName);
          if (publisherId) insertBooksPublishersLink.run(bookId, publisherId);
        }

        // Maybe add rating (40% chance)
        if (Math.random() > 0.6) {
          const rating = randomInt(1, 10);
          insertBooksRatingsLink.run(bookId, rating);
        }

        // Add 1-5 random tags (deduplicated)
        const numTags = randomInt(1, 5);
        const bookTags = [...new Set(randomItems(TAGS, numTags))]; // Deduplicate tags
        for (const tagName of bookTags) {
          let tagId = tagIds.get(tagName);
          if (!tagId) {
            insertTag.run(tagName);
            const row = db.query("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number } | undefined;
            if (row) {
              tagId = row.id;
              tagIds.set(tagName, tagId);
            }
          }
          if (tagId) {
            try {
              insertBooksTagsLink.run(bookId, tagId);
            } catch {
              // Ignore duplicate tag link errors
            }
          }
        }

        // Add formats (1-3 formats per book)
        const numFormats = randomInt(1, 3);
        const bookFormats = randomItems(formats, numFormats);
        for (const format of bookFormats) {
          const size = randomInt(100_000, 10_000_000); // 100KB to 10MB
          const name = title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
          insertData.run(bookId, format, size, name);
        }

        // Maybe add comment (30% chance)
        const comment = generateComment();
        if (comment) {
          insertComment.run(bookId, comment);
        }
      }
    })();

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = Math.round(batchEnd / elapsed);
    const remaining = Math.round((bookCount - batchEnd) / rate);

    process.stdout.write(`\r📚 Batch ${batch + 1}/${totalBatches}: ${batchEnd.toLocaleString()} books | ${rate.toLocaleString()} books/sec | ETA: ${remaining}s`);
  }

  console.log("\n");

  // Insert library ID
  db.query("INSERT INTO library_id (id, uuid) VALUES (1, ?)").run(generateUUID());

  // Vacuum to optimize
  console.log("🔧 Optimizing database...");
  db.exec("VACUUM;");
  db.exec("ANALYZE;");

  db.close();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Created test library with ${bookCount.toLocaleString()} books in ${totalTime}s`);
  console.log(`📁 Location: ${TEST_LIBRARY_PATH}`);

  // Print stats
  const statsDb = new Database(DB_PATH, { readonly: true });
  const stats = {
    books: (statsDb.query("SELECT COUNT(*) as c FROM books").get() as { c: number }).c,
    authors: (statsDb.query("SELECT COUNT(*) as c FROM authors").get() as { c: number }).c,
    series: (statsDb.query("SELECT COUNT(*) as c FROM series").get() as { c: number }).c,
    tags: (statsDb.query("SELECT COUNT(*) as c FROM tags").get() as { c: number }).c,
    publishers: (statsDb.query("SELECT COUNT(*) as c FROM publishers").get() as { c: number }).c,
  };
  statsDb.close();

  console.log("\n📊 Library Stats:");
  console.log(`   Books:      ${stats.books.toLocaleString()}`);
  console.log(`   Authors:    ${stats.authors.toLocaleString()}`);
  console.log(`   Series:     ${stats.series.toLocaleString()}`);
  console.log(`   Tags:       ${stats.tags.toLocaleString()}`);
  console.log(`   Publishers: ${stats.publishers.toLocaleString()}`);
}

// Generate 1 million books by default
const BOOK_COUNT = parseInt(process.argv[2] ?? "1000000", 10);
createTestLibrary(BOOK_COUNT);
