---
title: "API documentation for the database interface — calibre 9.2.1 documentation"
source_url: https://manual.calibre-ebook.com/db_api.html
fetched_date: 2026-02-07
type: web
status: temporary
---

# API documentation for the database interface — calibre 9.2.1 documentation

**By:** author_data(author_ids=None) → dict[int, dict[str, str]][source]¶

**Summary:** This API is thread safe (it uses a multiple reader, single writer locking scheme).  You can access this API like this:

**URL:** https://manual.calibre-ebook.com/db_api.html

---

This API is thread safe (it uses a multiple reader, single writer locking scheme). You can access this API like this:

from calibre.library import db
db \= db('Path to calibre library folder').new\*api

If you are in a calibre plugin that is part of the main calibre GUI, you get access to it like this instead:

db \= self.gui.current\*db.new\*api

*class*calibre.db.cache.Cache(*backend*,*library\*database\*instance\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache)[¶](#calibre.db.cache.Cache "Link to this definition")

An in-memory cache of the metadata.db file from a calibre library. This class also serves as a threadsafe API for accessing the database. The in-memory cache is maintained in normal form for maximum performance.

SQLITE is simply used as a way to read and write from metadata.db robustly. All table reading/sorting/searching/caching logic is re-implemented. This was necessary for maximum performance and flexibility.

*class*EventType(*\*values*)[¶](#calibre.db.cache.Cache.EventType "Link to this definition")

book\*created*\= 4*[¶](#calibre.db.cache.Cache.EventType.book*created "Link to this definition")

When a new book record is created in the database, with the book id as the only argument

book\*edited*\= 8*[¶](#calibre.db.cache.Cache.EventType.book*edited "Link to this definition")

When a book format is edited, with arguments: (book\*id, fmt)

books\*removed*\= 5*[¶](#calibre.db.cache.Cache.EventType.books*removed "Link to this definition")

When books are removed from the database with the list of book ids as the only argument

format\*added*\= 2*[¶](#calibre.db.cache.Cache.EventType.format*added "Link to this definition")

When a format is added to a book, with arguments: (book\*id, format)

formats\*removed*\= 3*[¶](#calibre.db.cache.Cache.EventType.formats*removed "Link to this definition")

When formats are removed from a book, with arguments: (mapping of book id to set of formats removed from the book)

indexing\*progress\*changed*\= 9*[¶](#calibre.db.cache.Cache.EventType.indexing*progress*changed "Link to this definition")

When the indexing progress changes

items\*removed*\= 7*[¶](#calibre.db.cache.Cache.EventType.items*removed "Link to this definition")

When items such as tags or authors are removed from some books. Arguments: (field\*name, affected book ids, ids of removed items)

items\*renamed*\= 6*[¶](#calibre.db.cache.Cache.EventType.items*renamed "Link to this definition")

When items such as tags or authors are renamed in some or all books. Arguments: (field\*name, affected book ids, map of old item id to new item id)

links\*changed*\= 11*[¶](#calibre.db.cache.Cache.EventType.links*changed "Link to this definition")

When the links associated with items(s) are changed, with arguments: (field\*name, item\*ids)

metadata\*changed*\= 1*[¶](#calibre.db.cache.Cache.EventType.metadata*changed "Link to this definition")

When some metadata is changed for some books, with arguments: (name of changed field, set of affected book ids)

notes\*changed*\= 10*[¶](#calibre.db.cache.Cache.EventType.notes*changed "Link to this definition")

When the notes associated with item(s) are changed, with arguments: (field\*name, item\*ids)

add\*books(*books*,*add\*duplicates\=True*,*apply\*import\*tags\=True*,*preserve\*uuid\=False*,*run\*hooks\=True*,*dbapi\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.add*books)[¶](#calibre.db.cache.Cache.add*books "Link to this definition")

Add the specified books to the library. Books should be an iterable of 2-tuples, each 2-tuple of the form `(mi, format*map)` where mi is a Metadata object and format\*map is a dictionary of the form `{fmt: path*or*stream}`, for example: `{'EPUB': '/path/to/file.epub'}`.

Returns a pair of lists: `ids, duplicates`. `ids` contains the book ids for all newly created books in the database. `duplicates` contains the `(mi, format*map)` for all books that already exist in the database as per the simple duplicate detection heuristic used by [`has*book()`](#calibre.db.cache.Cache.has*book "calibre.db.cache.Cache.has*book").

add\*custom\*book\*data(*name*,*val\*map*,*delete\*first\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.add*custom*book*data)[¶](#calibre.db.cache.Cache.add*custom*book*data "Link to this definition")

Add data for name where val\*map is a map of book\*ids to values. If delete\*first is True, all previously stored data for name will be removed.

Add extra data files

add\*format(*book\*id*,*fmt*,*stream\*or\*path*,*replace\=True*,*run\*hooks\=True*,*dbapi\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.add*format)[¶](#calibre.db.cache.Cache.add*format "Link to this definition")

Add a format to the specified book. Return True if the format was added successfully.

Parameters:

-replace- If True replace existing format, otherwise if the format already exists, return False.

-run\*hooks- If True, file type plugins are run on the format before and after being added.

-dbapi- Internal use only.

add\*listener(*event\*callback\*function*,*check\*already\*added\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.add*listener)[¶](#calibre.db.cache.Cache.add*listener "Link to this definition")

Register a callback function that will be called after certain actions are taken on this database. The function must take three arguments: ([`EventType`](#calibre.db.cache.Cache.EventType "calibre.db.cache.Cache.EventType"), library\*id, event\*type\*specific\*data)

add\*notes\*resource(*path\*or\*stream\*or\*data*,*name: str*,*mtime: float \= None*) → int[\[source\]](*modules/calibre/db/cache.html#Cache.add*notes*resource)[¶](#calibre.db.cache.Cache.add*notes*resource "Link to this definition")

Add the specified resource so it can be referenced by notes and return its content hash

all\*annotation\*types()[\[source\]](*modules/calibre/db/cache.html#Cache.all*annotation*types)[¶](#calibre.db.cache.Cache.all*annotation*types "Link to this definition")

Return a tuple of all annotation types in the database.

all\*annotation\*users()[\[source\]](*modules/calibre/db/cache.html#Cache.all*annotation*users)[¶](#calibre.db.cache.Cache.all*annotation*users "Link to this definition")

Return a tuple of all (user\*type, user name) that have annotations.

all\*annotations(*restrict\*to\*user\=None*,*limit\=None*,*annotation\*type\=None*,*ignore\*removed\=False*,*restrict\*to\*book\*ids\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*annotations)[¶](#calibre.db.cache.Cache.all*annotations "Link to this definition")

Return a tuple of all annotations matching the specified criteria. ignore\*removed controls whether removed (deleted) annotations are also returned. Removed annotations are just a skeleton used for merging of annotations.

all\*annotations\*for\*book(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*annotations*for*book)[¶](#calibre.db.cache.Cache.all*annotations*for*book "Link to this definition")

Return a tuple containing all annotations for the specified book\*id as a dict with keys: format, user\*type, user, annotation. Here, annotation is the annotation data.

all\*book\*ids(*type=*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*book*ids)[¶](#calibre.db.cache.Cache.all*book*ids "Link to this definition")

Frozen set of all known book ids.

all\*field\*for(*field*,*book\*ids*,*default\*value\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*field*for)[¶](#calibre.db.cache.Cache.all*field*for "Link to this definition")

Same as field\*for, except that it operates on multiple books at once

all\*field\*ids(*name*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*field*ids)[¶](#calibre.db.cache.Cache.all*field*ids "Link to this definition")

Frozen set of ids for all values in the field `name`.

all\*field\*names(*field*)[\[source\]](*modules/calibre/db/cache.html#Cache.all*field*names)[¶](#calibre.db.cache.Cache.all*field*names "Link to this definition")

Frozen set of all fields names (should only be used for many-one and many-many fields)

annotation\*count\*for\*book(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.annotation*count*for*book)[¶](#calibre.db.cache.Cache.annotation*count*for*book "Link to this definition")

Return the number of annotations for the specified book available in the database.

annotations\*map\*for\*book(*book\*id*,*fmt*,*user\*type\='local'*,*user\='viewer'*)[\[source\]](*modules/calibre/db/cache.html#Cache.annotations*map*for*book)[¶](#calibre.db.cache.Cache.annotations*map*for*book "Link to this definition")

Return a map of annotation type -> annotation data for the specified book\*id, format, user and user\*type.

Return author data as a dictionary with keys: name, sort, link

If no authors with the specified ids are found an empty dictionary is returned. If author\*ids is None, data for all authors is returned.

author\*sort\*from\*authors(*authors*,*key\*func=.change\*case>*)[\[source\]](*modules/calibre/db/cache.html#Cache.author*sort*from*authors)[¶](#calibre.db.cache.Cache.author*sort*from*authors "Link to this definition")

Given a list of authors, return the author\*sort string for the authors, preferring the author sort associated with the author over the computed string.

author\*sorts(*author\*ids\=None*) → dict\[int, str\][\[source\]](*modules/calibre/db/cache.html#Cache.author*sorts)[¶](#calibre.db.cache.Cache.author*sorts "Link to this definition")

Return author sorts for specified authors.

If no authors with the specified ids are found an empty dictionary is returned. If author\*ids is None, data for all authors is returned.

books\*for\*field(*name*,*item\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.books*for*field)[¶](#calibre.db.cache.Cache.books*for*field "Link to this definition")

Return all the books associated with the item identified by `item*id`, where the item belongs to the field `name`.

Returned value is a set of book ids, or the empty set if the item or the field does not exist.

books\*in\*virtual\*library(*vl*,*search\*restriction\=None*,*virtual\*fields\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.books*in*virtual*library)[¶](#calibre.db.cache.Cache.books*in*virtual*library "Link to this definition")

Return the set of books in the specified virtual library

compress\*covers(*book\*ids*,*jpeg\*quality\=100*,*progress\*callback\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.compress*covers)[¶](#calibre.db.cache.Cache.compress*covers "Link to this definition")

Compress the cover images for the specified books. A compression quality of 100 will perform lossless compression, otherwise lossy compression.

The progress callback will be called with the book\*id and the old and new sizes for each book that has been processed. If an error occurs, the new size will be a string with the error details.

copy\*cover\*to(*book\*id*,*dest*,*use\*hardlink\=False*,*report\*file\*size\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.copy*cover*to)[¶](#calibre.db.cache.Cache.copy*cover*to "Link to this definition")

Copy the cover to the file like object `dest`. Returns False if no cover exists or dest is the same file as the current cover. dest can also be a path in which case the cover is copied to it if and only if the path is different from the current path (taking case sensitivity into account).

copy\*format\*to(*book\*id*,*fmt*,*dest*,*use\*hardlink\=False*,*report\*file\*size\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.copy*format*to)[¶](#calibre.db.cache.Cache.copy*format*to "Link to this definition")

Copy the format `fmt` to the file like object `dest`. If the specified format does not exist, raises `NoSuchFormat` error. dest can also be a path (to a file), in which case the format is copied to it, iff the path is different from the current path (taking case sensitivity into account).

cover(*book\*id*,*as\*file\=False*,*as\*image\=False*,*as\*path\=False*,*as\*pixmap\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.cover)[¶](#calibre.db.cache.Cache.cover "Link to this definition")

Return the cover image or None. By default, returns the cover as a bytestring.

WARNING: Using as\*path will copy the cover to a temp file and return the path to the temp file. You should delete the temp file when you are done with it.

Parameters:

-as\*file- If True return the image as an open file object (a SpooledTemporaryFile)

-as\*image- If True return the image as a QImage object

-as\*pixmap- If True return the image as a QPixmap object

-as\*path- If True return the image as a path pointing to a temporary file

data\*for\*find\*identical\*books()[\[source\]](*modules/calibre/db/cache.html#Cache.data*for*find*identical*books)[¶](#calibre.db.cache.Cache.data*for*find*identical*books "Link to this definition")

Return data that can be used to implement [`find*identical*books()`](#calibre.db.cache.Cache.find*identical*books "calibre.db.cache.Cache.find*identical*books") in a worker process without access to the db. See db.utils for an implementation.

data\*for\*has\*book()[\[source\]](*modules/calibre/db/cache.html#Cache.data*for*has*book)[¶](#calibre.db.cache.Cache.data*for*has*book "Link to this definition")

Return data suitable for use in [`has*book()`](#calibre.db.cache.Cache.has*book "calibre.db.cache.Cache.has*book"). This can be used for an implementation of [`has*book()`](#calibre.db.cache.Cache.has*book "calibre.db.cache.Cache.has*book") in a worker process without access to the db.

delete\*annotations(*annot\*ids*)[\[source\]](*modules/calibre/db/cache.html#Cache.delete*annotations)[¶](#calibre.db.cache.Cache.delete*annotations "Link to this definition")

Delete annotations with the specified ids.

delete\*custom\*book\*data(*name*,*book\*ids\=()*)[\[source\]](*modules/calibre/db/cache.html#Cache.delete*custom*book*data)[¶](#calibre.db.cache.Cache.delete*custom*book*data "Link to this definition")

Delete data for name. By default deletes all data, if you only want to delete data for some book ids, pass in a list of book ids.

delete\*trash\*entry(*book\*id*,*category*)[\[source\]](*modules/calibre/db/cache.html#Cache.delete*trash*entry)[¶](#calibre.db.cache.Cache.delete*trash*entry "Link to this definition")

Delete an entry from the trash. Here category is 'b' for books and 'f' for formats.

embed\*metadata(*book\*ids*,*only\*fmts\=None*,*report\*error\=None*,*report\*progress\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.embed*metadata)[¶](#calibre.db.cache.Cache.embed*metadata "Link to this definition")

Update metadata in all formats of the specified book\*ids to current metadata in the database.

expire\*old\*trash()[\[source\]](*modules/calibre/db/cache.html#Cache.expire*old*trash)[¶](#calibre.db.cache.Cache.expire*old*trash "Link to this definition")

Expire entries from the trash that are too old

export\*note(*field*,*item\*id*) → str[\[source\]](*modules/calibre/db/cache.html#Cache.export*note)[¶](#calibre.db.cache.Cache.export*note "Link to this definition")

Export the note as a single HTML document with embedded images as data: URLs

fast\*field\*for(*field\*obj*,*book\*id*,*default\*value\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.fast*field*for)[¶](#calibre.db.cache.Cache.fast*field*for "Link to this definition")

Same as field\*for, except that it avoids the extra lookup to get the field object

field\*for(*name*,*book\*id*,*default\*value\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.field*for)[¶](#calibre.db.cache.Cache.field*for "Link to this definition")

Return the value of the field `name` for the book identified by `book*id`. If no such book exists or it has no defined value for the field `name` or no such field exists, then `default*value` is returned.

`default*value` is not used for title, title\*sort, authors, author\*sort and series\*index. This is because these always have values in the db. `default*value` is used for all custom columns.

The returned value for is\*multiple fields are always tuples, even when no values are found (in other words, default\*value is ignored). The exception is identifiers for which the returned value is always a dictionary. The returned tuples are always in link order, that is, the order in which they were created.

field\*ids\*for(*name*,*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.field*ids*for)[¶](#calibre.db.cache.Cache.field*ids*for "Link to this definition")

Return the ids (as a tuple) for the values that the field `name` has on the book identified by `book*id`. If there are no values, or no such book, or no such field, an empty tuple is returned.

field\*supports\*notes(*field\=None*) → bool[\[source\]](*modules/calibre/db/cache.html#Cache.field*supports*notes)[¶](#calibre.db.cache.Cache.field*supports*notes "Link to this definition")

Return True iff the specified field supports notes. If field is None return frozenset of all fields that support notes.

find\*identical\*books(*mi*,*search\*restriction\=''*,*book\*ids\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.find*identical*books)[¶](#calibre.db.cache.Cache.find*identical*books "Link to this definition")

Finds books that have a superset of the authors in mi and the same title (title is fuzzy matched). See also [`data*for*find*identical*books()`](#calibre.db.cache.Cache.data*for*find*identical*books "calibre.db.cache.Cache.data*for*find*identical*books").

format(*book\*id*,*fmt*,*as\*file\=False*,*as\*path\=False*,*preserve\*filename\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.format)[¶](#calibre.db.cache.Cache.format "Link to this definition")

Return the e-book format as a bytestring or None if the format doesn't exist, or we don't have permission to write to the e-book file.

Parameters:

-as\*file- If True the e-book format is returned as a file object. Note that the file object is a SpooledTemporaryFile, so if what you want to do is copy the format to another file, use [`copy*format*to()`](#calibre.db.cache.Cache.copy*format*to "calibre.db.cache.Cache.copy*format*to") instead for performance.

-as\*path- Copies the format file to a temp file and returns the path to the temp file

-preserve\*filename- If True and returning a path the filename is the same as that used in the library. Note that using this means that repeated calls yield the same temp file (which is re-created each time)

format\*abspath(*book\*id*,*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.format*abspath)[¶](#calibre.db.cache.Cache.format*abspath "Link to this definition")

Return absolute path to the e-book file of format format. You should almost never use this, as it breaks the threadsafe promise of this API. Instead use, [`copy*format*to()`](#calibre.db.cache.Cache.copy*format*to "calibre.db.cache.Cache.copy*format*to").

Currently used only in calibredb list, the viewer, edit book, compare\*format to original format, open with, bulk metadata edit and the catalogs (via get\*data\*as\*dict()).

Apart from the viewer, open with and edit book, I don't believe any of the others do any file write I/O with the results of this call.

format\*hash(*book\*id*,*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.format*hash)[¶](#calibre.db.cache.Cache.format*hash "Link to this definition")

Return the hash of the specified format for the specified book. The kind of hash is backend dependent, but is usually SHA-256.

format\*metadata(*book\*id*,*fmt*,*allow\*cache\=True*,*update\*db\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.format*metadata)[¶](#calibre.db.cache.Cache.format*metadata "Link to this definition")

Return the path, size and mtime for the specified format for the specified book. You should not use path unless you absolutely have to, since accessing it directly breaks the threadsafe guarantees of this API. Instead use the [`copy*format*to()`](#calibre.db.cache.Cache.copy*format*to "calibre.db.cache.Cache.copy*format*to") method.

Parameters:

-allow\*cache- If `True` cached values are used, otherwise a slow filesystem access is done. The cache values could be out of date if access was performed to the filesystem outside of this API.

-update\*db- If `True` The max\*size field of the database is updated for this book.

formats(*book\*id*,*verify\*formats\=True*)[\[source\]](*modules/calibre/db/cache.html#Cache.formats)[¶](#calibre.db.cache.Cache.formats "Link to this definition")

Return tuple of all formats for the specified book. If verify\*formats is True, verifies that the files exist on disk.

get\*all\*items\*that\*have\*notes(*field\*name\=None*) → set\[int\] | dict\[str, set\[int\]\][\[source\]](*modules/calibre/db/cache.html#Cache.get*all*items*that*have*notes)[¶](#calibre.db.cache.Cache.get*all*items*that*have*notes "Link to this definition")

Return all item\*ids for items that have notes in the specified field or all fields if field\*name is None

get\*all\*link\*maps\*for\*book(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*all*link*maps*for*book)[¶](#calibre.db.cache.Cache.get*all*link*maps*for*book "Link to this definition")

Returns all links for all fields referenced by book identified by book\*id. If book\*id doesn't exist then the method returns {}.

Example: Assume author A has link X, author B has link Y, tag S has link F, and tag T has link G. If book 1 has author A and tag T, this method returns {'authors':{'A':'X'}, 'tags':{'T', 'G'}}. If book 2's author is neither A nor B and has no tags, this method returns {}.

Parameters:

book\*id- the book id in question.

Returns:

{field: {field\*value, link\*value}, … for all fields with a field\*value having a non-empty link value for that book

get\*book\*path(*book\*id*,*sep\='/'*,*unsafe\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*book*path)[¶](#calibre.db.cache.Cache.get*book*path "Link to this definition")

Return the relative book path for the given id. Prefer this because you can choose the directory separator, default use the os one. If unsafe is True, allow to return None if the book\*id is not in the library.

get\*categories(*sort\='name'*,*book\*ids\=None*,*already\*fixed\=None*,*first\*letter\*sort\=False*,*uncollapsed\*categories\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*categories)[¶](#calibre.db.cache.Cache.get*categories "Link to this definition")

Used internally to implement the Tag Browser

get\*custom\*book\*data(*name*,*book\*ids\=()*,*default\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*custom*book*data)[¶](#calibre.db.cache.Cache.get*custom*book*data "Link to this definition")

Get data for name. By default returns data for all book\*ids, pass in a list of book ids if you only want some data. Returns a map of book\*id to values. If a particular value could not be decoded, uses default for it.

get\*id\*map(*field*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*id*map)[¶](#calibre.db.cache.Cache.get*id*map "Link to this definition")

Return a mapping of id numbers to values for the specified field. The field must be a many-one or many-many field, otherwise a ValueError is raised.

get\*ids\*for\*custom\*book\*data(*name*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*ids*for*custom*book*data)[¶](#calibre.db.cache.Cache.get*ids*for*custom*book*data "Link to this definition")

Return the set of book ids for which name has data.

get\*item\*id(*field*,*item\*name*,*case\*sensitive\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*item*id)[¶](#calibre.db.cache.Cache.get*item*id "Link to this definition")

Return the item id for item\*name or None if not found. This function is very slow if doing lookups for multiple names use either get\*item\*ids() or get\*item\*name\*map(). Similarly, case sensitive lookups are faster than case insensitive ones.

get\*item\*ids(*field*,*item\*names*,*case\*sensitive\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*item*ids)[¶](#calibre.db.cache.Cache.get*item*ids "Link to this definition")

Return a dict mapping item\*name to the item id or None

get\*item\*name(*field*,*item\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*item*name)[¶](#calibre.db.cache.Cache.get*item*name "Link to this definition")

Return the item name for the item specified by item\*id in the specified field. See also [`get*id*map()`](#calibre.db.cache.Cache.get*id*map "calibre.db.cache.Cache.get*id*map").

get\*item\*name\*map(*field*,*normalize\*func\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*item*name*map)[¶](#calibre.db.cache.Cache.get*item*name*map "Link to this definition")

Return mapping of item values to ids

get\*link\*map(*for\*field*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*link*map)[¶](#calibre.db.cache.Cache.get*link*map "Link to this definition")

Return a dictionary of links for the supplied field.

Parameters:

for\*field- the lookup name of the field for which the link map is desired

Returns:

{field\*value:link\*value, …} for non-empty links

get\*metadata(*book\*id*,*get\*cover\=False*,*get\*user\*categories\=True*,*cover\*as\*data\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*metadata)[¶](#calibre.db.cache.Cache.get*metadata "Link to this definition")

Return metadata for the book identified by book\*id as a [`calibre.ebooks.metadata.book.base.Metadata`](generated/en/template*ref.html#calibre.ebooks.metadata.book.base.Metadata "calibre.ebooks.metadata.book.base.Metadata") object. Note that the list of formats is not verified. If get\*cover is True, the cover is returned, either a path to temp file as mi.cover or if cover\*as\*data is True then as mi.cover\*data.

get\*next\*series\*num\*for(*series*,*field\='series'*,*current\*indices\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*next*series*num*for)[¶](#calibre.db.cache.Cache.get*next*series*num*for "Link to this definition")

Return the next series index for the specified series, taking into account the various preferences that control next series number generation.

Parameters:

-field- The series-like field (defaults to the builtin series column)

-current\*indices- If True, returns a mapping of book\*id to current series\*index value instead.

get\*notes\*resource(*resource\*hash*) → dict | None[\[source\]](*modules/calibre/db/cache.html#Cache.get*notes*resource)[¶](#calibre.db.cache.Cache.get*notes*resource "Link to this definition")

Return a dict containing the resource data and name or None if no resource with the specified hash is found

get\*pages(*book\*id: int*) → Pages | None[\[source\]](*modules/calibre/db/cache.html#Cache.get*pages)[¶](#calibre.db.cache.Cache.get*pages "Link to this definition")

Return page count information for the specified book

get\*proxy\*metadata(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*proxy*metadata)[¶](#calibre.db.cache.Cache.get*proxy*metadata "Link to this definition")

Like [`get*metadata()`](#calibre.db.cache.Cache.get*metadata "calibre.db.cache.Cache.get*metadata") except that it returns a ProxyMetadata object that only reads values from the database on demand. This is much faster than get\*metadata when only a small number of fields need to be accessed from the returned metadata object.

get\*usage\*count\*by\*id(*field*)[\[source\]](*modules/calibre/db/cache.html#Cache.get*usage*count*by*id)[¶](#calibre.db.cache.Cache.get*usage*count*by*id "Link to this definition")

Return a mapping of id to usage count for all values of the specified field, which must be a many-one or many-many field.

has\*book(*mi*)[\[source\]](*modules/calibre/db/cache.html#Cache.has*book)[¶](#calibre.db.cache.Cache.has*book "Link to this definition")

Return True iff the database contains an entry with the same title as the passed in Metadata object. The comparison is case-insensitive. See also [`data*for*has*book()`](#calibre.db.cache.Cache.data*for*has*book "calibre.db.cache.Cache.data*for*has*book").

has\*format(*book\*id*,*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.has*format)[¶](#calibre.db.cache.Cache.has*format "Link to this definition")

Return True iff the format exists on disk

has\*id(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.has*id)[¶](#calibre.db.cache.Cache.has*id "Link to this definition")

Return True iff the specified book\*id exists in the db

import\*note(*field*,*item\*id*,*path\*to\*html\*file*,*path\*is\*data\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.import*note)[¶](#calibre.db.cache.Cache.import*note "Link to this definition")

Import a previously exported note or an arbitrary HTML file as the note for the specified item

init()[\[source\]](*modules/calibre/db/cache.html#Cache.init)[¶](#calibre.db.cache.Cache.init "Link to this definition")

Initialize this cache with data from the backend.

items\*with\*notes\*in\*book(*book\*id: int*) → dict\[str, dict\[int, str\]\][\[source\]](*modules/calibre/db/cache.html#Cache.items*with*notes*in*book)[¶](#calibre.db.cache.Cache.items*with*notes*in*book "Link to this definition")

Return a dict of field to items that have associated notes for that field for the specified book

link\*for(*field*,*item\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.link*for)[¶](#calibre.db.cache.Cache.link*for "Link to this definition")

Return the link, if any, for the specified item or None if no link is found

Get information about extra files in the book's directory.

Parameters:

-book\*id- the database book id for the book

-pattern- the pattern of filenames to search for. Empty pattern matches all extra files. Patterns must use / as separator. Use the DATA\*FILE\*PATTERN constant to match files inside the data directory.

Returns:

A tuple of all extra files matching the specified pattern. Each element of the tuple is ExtraFile(relpath, file\*path, stat\*result). Where relpath is the relative path of the file to the book directory using / as a separator. stat\*result is the result of calling os.stat() on the file.

mark\*for\*pages\*recount(*book\*id: int \= 0*) → None[\[source\]](*modules/calibre/db/cache.html#Cache.mark*for*pages*recount)[¶](#calibre.db.cache.Cache.mark*for*pages*recount "Link to this definition")

Mark all books for recount of pages

merge\*annotations\*for\*book(*book\*id*,*fmt*,*annots\*list*,*user\*type\='local'*,*user\='viewer'*)[\[source\]](*modules/calibre/db/cache.html#Cache.merge*annotations*for*book)[¶](#calibre.db.cache.Cache.merge*annotations*for*book "Link to this definition")

Merge the specified annotations into the existing annotations for book\*id, fm, user\*type, and user.

Merge the extra files from src\*ids into dest\*id. Conflicting files are auto-renamed unless replace=True in which case they are replaced.

move\*book\*from\*trash(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.move*book*from*trash)[¶](#calibre.db.cache.Cache.move*book*from*trash "Link to this definition")

Undelete a book from the trash directory

move\*format\*from\*trash(*book\*id*,*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.move*format*from*trash)[¶](#calibre.db.cache.Cache.move*format*from*trash "Link to this definition")

Undelete a format from the trash directory

multisort(*fields*,*ids\*to\*sort\=None*,*virtual\*fields\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.multisort)[¶](#calibre.db.cache.Cache.multisort "Link to this definition")

Return a list of sorted book ids. If ids\*to\*sort is None, all book ids are returned.

fields must be a list of 2-tuples of the form (field\*name, ascending=True or False). The most significant field is the first 2-tuple.

notes\*data\*for(*field*,*item\*id*) → str[\[source\]](*modules/calibre/db/cache.html#Cache.notes*data*for)[¶](#calibre.db.cache.Cache.notes*data*for "Link to this definition")

Return all notes data as a dict or None if note does not exist

notes\*for(*field*,*item\*id*) → str[\[source\]](*modules/calibre/db/cache.html#Cache.notes*for)[¶](#calibre.db.cache.Cache.notes*for "Link to this definition")

Return the notes document or an empty string if not found

notes\*resources\*used\*by(*field*,*item\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.notes*resources*used*by)[¶](#calibre.db.cache.Cache.notes*resources*used*by "Link to this definition")

Return the set of resource hashes of all resources used by the note for the specified item

pages\*needs\*scan(*books: Iterable\[int\] \= ()*) → set\[int\][\[source\]](*modules/calibre/db/cache.html#Cache.pages*needs*scan)[¶](#calibre.db.cache.Cache.pages*needs*scan "Link to this definition")

Return the subset of books (or all books if empty) that are marked as needing a scan to update page count

pref(*name*,*default\=None*,*namespace\=None*,*get\*default\*from\*defaults\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.pref)[¶](#calibre.db.cache.Cache.pref "Link to this definition")

Return the value for the specified preference or the value specified as `default` if the preference is not set.

queue\*pages\*scan(*book\*id: int \= 0*,*force: bool \= False*,*by\*user: bool \= True*) → None[\[source\]](*modules/calibre/db/cache.html#Cache.queue*pages*scan)[¶](#calibre.db.cache.Cache.queue*pages*scan "Link to this definition")

Start a scan updating page counts for all books that need a scan. If book\*id is specified, then only that book is scanned and it is always scanned. When force is True, the existing pages value, if any, is discarded so that the book is forcibly rescanned even if the existing value was up-to-date.

read\*backup(*book\*id*)[\[source\]](*modules/calibre/db/cache.html#Cache.read*backup)[¶](#calibre.db.cache.Cache.read*backup "Link to this definition")

Return the OPF metadata backup for the book as a bytestring or None if no such backup exists.

remove\*books(*book\*ids*,*permanent\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.remove*books)[¶](#calibre.db.cache.Cache.remove*books "Link to this definition")

Remove the books specified by the book\*ids from the database and delete their format files. If `permanent` is False, then the format files are placed in the per-library trash directory.

Delete the specified extra files, either to Recycle Bin or permanently.

remove\*formats(*formats\*map*,*db\*only\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.remove*formats)[¶](#calibre.db.cache.Cache.remove*formats "Link to this definition")

Remove the specified formats from the specified books.

Parameters:

-formats\*map- A mapping of book\*id to a list of formats to be removed from the book.

-db\*only- If True, only remove the record for the format from the db, do not delete the actual format file from the filesystem.

Returns:

A map of book id to set of formats actually deleted from the filesystem for that book

remove\*items(*field*,*item\*ids*,*restrict\*to\*book\*ids\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.remove*items)[¶](#calibre.db.cache.Cache.remove*items "Link to this definition")

Delete all items in the specified field with the specified ids. Returns the set of affected book ids. `restrict*to*book*ids` is an optional set of books ids. If specified the items will only be removed from those books.

Rename extra data files

rename\*items(*field*,*item\*id\*to\*new\*name\*map*,*change\*index\=True*,*restrict\*to\*book\*ids\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.rename*items)[¶](#calibre.db.cache.Cache.rename*items "Link to this definition")

Rename items from a many-one or many-many field such as tags or series.

Parameters:

-change\*index- When renaming in a series-like field also change the series\*index values.

-restrict\*to\*book\*ids- An optional set of book ids for which the rename is to be performed, defaults to all books.

restore\*book(*book\*id*,*mi*,*last\*modified*,*path*,*formats*,*annotations\=()*)[\[source\]](*modules/calibre/db/cache.html#Cache.restore*book)[¶](#calibre.db.cache.Cache.restore*book "Link to this definition")

Restore the book entry in the database for a book that already exists on the filesystem

restore\*original\*format(*book\*id*,*original\*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.restore*original*format)[¶](#calibre.db.cache.Cache.restore*original*format "Link to this definition")

Restore the specified format from the previously saved ORIGINAL\*FORMAT, if any. Return True on success. The ORIGINAL\*FORMAT is deleted after a successful restore.

*property*safe\*read\*lock[¶](#calibre.db.cache.Cache.safe*read*lock "Link to this definition")

A safe read lock is a lock that does nothing if the thread already has a write lock, otherwise it acquires a read lock. This is necessary to prevent DowngradeLockErrors, which can happen when updating the search cache in the presence of composite columns. Updating the search cache holds an exclusive lock, but searching a composite column involves reading field values via ProxyMetadata which tries to get a shared lock. There may be other scenarios that trigger this as well.

This property returns a new lock object on every access. This lock object is not recursive (for performance) and must only be used in a with statement as `with cache.safe*read*lock:` otherwise bad things will happen.

save\*original\*format(*book\*id*,*fmt*)[\[source\]](*modules/calibre/db/cache.html#Cache.save*original*format)[¶](#calibre.db.cache.Cache.save*original*format "Link to this definition")

Save a copy of the specified format as ORIGINAL\*FORMAT, overwriting any existing ORIGINAL\*FORMAT.

search(*query*,*restriction\=''*,*virtual\*fields\=None*,*book\*ids\=None*,*allow\*templates\=True*)[\[source\]](*modules/calibre/db/cache.html#Cache.search)[¶](#calibre.db.cache.Cache.search "Link to this definition")

Search the database for the specified query, returning a set of matched book ids.

Parameters:

-restriction- A restriction that is ANDed to the specified query. Note that restrictions are cached, therefore the search for a AND b will be slower than a with restriction b.

-virtual\*fields- Used internally (virtual fields such as on\*device to search over).

-book\*ids- If not None, a set of book ids for which books will be searched instead of searching all books.

search\*annotations(*fts\*engine\*query*,*use\*stemming\=True*,*highlight\*start\=None*,*highlight\*end\=None*,*snippet\*size\=None*,*annotation\*type\=None*,*restrict\*to\*book\*ids\=None*,*restrict\*to\*user\=None*,*ignore\*removed\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.search*annotations)[¶](#calibre.db.cache.Cache.search*annotations "Link to this definition")

Return of a tuple of annotations matching the specified Full-text query.

search\*notes(*fts\*engine\*query=''*,*use\*stemming=True*,*highlight\*start=None*,*highlight\*end=None*,*snippet\*size=None*,*restrict\*to\*fields=()*,*return\*text=True*,*result\*type=*,*process\*each\*result=None*,*limit=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.search*notes)[¶](#calibre.db.cache.Cache.search*notes "Link to this definition")

Search the text of notes using an FTS index. If the query is empty return all notes.

set\*annotations\*for\*book(*book\*id*,*fmt*,*annots\*list*,*user\*type\='local'*,*user\='viewer'*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*annotations*for*book)[¶](#calibre.db.cache.Cache.set*annotations*for*book "Link to this definition")

Set all annotations for the specified book\*id, fmt, user\*type and user.

set\*conversion\*options(*options*,*fmt\='PIPE'*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*conversion*options)[¶](#calibre.db.cache.Cache.set*conversion*options "Link to this definition")

options must be a map of the form {book\*id:conversion\*options}

set\*cover(*book\*id\*data\*map*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*cover)[¶](#calibre.db.cache.Cache.set*cover "Link to this definition")

Set the cover for this book. The data can be either a QImage, QPixmap, file object or bytestring. It can also be None, in which case any existing cover is removed.

set\*field(*name*,*book\*id\*to\*val\*map*,*allow\*case\*change\=True*,*do\*path\*update\=True*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*field)[¶](#calibre.db.cache.Cache.set*field "Link to this definition")

Set the values of the field specified by `name`. Returns the set of all book ids that were affected by the change.

Parameters:

-book\*id\*to\*val\*map- Mapping of book\*ids to values that should be applied.

-allow\*case\*change- If True, the case of many-one or many-many fields will be changed. For example, if a book has the tag `tag1` and you set the tag for another book to `Tag1` then the both books will have the tag `Tag1` if allow\*case\*change is True, otherwise they will both have the tag `tag1`.

-do\*path\*update- Used internally, you should never change it.

set\*link\*map(*field*,*value\*to\*link\*map*,*only\*set\*if\*no\*existing\*link\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*link*map)[¶](#calibre.db.cache.Cache.set*link*map "Link to this definition")

Sets links for item values in field. Note: this method doesn't change values not in the value\*to\*link\*map

Parameters:

-field- the lookup name

-value\*to\*link\*map- dict(field\*value:link, …). Note that these are values, not field ids.

Returns:

books changed by setting the link

set\*metadata(*book\*id*,*mi*,*ignore\*errors\=False*,*force\*changes\=False*,*set\*title\=True*,*set\*authors\=True*,*allow\*case\*change\=False*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*metadata)[¶](#calibre.db.cache.Cache.set*metadata "Link to this definition")

Set metadata for the book id from the Metadata object mi

Setting force\*changes=True will force set\*metadata to update fields even if mi contains empty values. In this case, 'None' is distinguished from 'empty'. If mi.XXX is None, the XXX is not replaced, otherwise it is. The tags, identifiers, and cover attributes are special cases. Tags and identifiers cannot be set to None so they will always be replaced if force\*changes is true. You must ensure that mi contains the values you want the book to have. Covers are always changed if a new cover is provided, but are never deleted. Also note that force\*changes has no effect on setting title or authors.

set\*notes\*for(*field*,*item\*id*,*doc: str*,*searchable\*text: str \= ''*,*resource\*hashes\=()*,*remove\*unused\*resources\=False*) → int[\[source\]](*modules/calibre/db/cache.html#Cache.set*notes*for)[¶](#calibre.db.cache.Cache.set*notes*for "Link to this definition")

Set the notes document. If the searchable text is different from the document, specify it as searchable\*text. If the document references resources their hashes must be present in resource\*hashes. Set remove\*unused\*resources to True to cleanup unused resources, note that updating a note automatically cleans up resources pertaining to that note anyway.

set\*pages(*book\*id: int*,*pages: int \= 0*,*algorithm: int \= 0*,*format: str \= ''*,*format\*size: int \= 0*) → None[\[source\]](*modules/calibre/db/cache.html#Cache.set*pages)[¶](#calibre.db.cache.Cache.set*pages "Link to this definition")

Set page count information for the specified book

set\*pref(*name*,*val*,*namespace\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.set*pref)[¶](#calibre.db.cache.Cache.set*pref "Link to this definition")

Set the specified preference to the specified value. See also [`pref()`](#calibre.db.cache.Cache.pref "calibre.db.cache.Cache.pref").

split\*if\*is\*multiple\*composite(*f*,*val*)[\[source\]](*modules/calibre/db/cache.html#Cache.split*if*is*multiple*composite)[¶](#calibre.db.cache.Cache.split*if*is*multiple*composite "Link to this definition")

If f is a composite column lookup key and the column is is\*multiple then split v into unique non-empty values. The comparison is case sensitive. Order is not preserved. Return a list() for compatibility with proxy metadata field getters, for example tags.

tags\*older\*than(*tag*,*delta\=None*,*must\*have\*tag\=None*,*must\*have\*authors\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.tags*older*than)[¶](#calibre.db.cache.Cache.tags*older*than "Link to this definition")

Return the ids of all books having the tag `tag` that are older than the specified time. tag comparison is case insensitive.

Parameters:

-delta- A timedelta object or None. If None, then all ids with the tag are returned.

-must\*have\*tag- If not None the list of matches will be restricted to books that have this tag

-must\*have\*authors- A list of authors. If not None the list of matches will be restricted to books that have these authors (case insensitive).

unretire\*note\*for(*field*,*item\*id*) → int[\[source\]](*modules/calibre/db/cache.html#Cache.unretire*note*for)[¶](#calibre.db.cache.Cache.unretire*note*for "Link to this definition")

Unretire a previously retired note for the specified item. Notes are retired when an item is removed from the database

update\*annotations(*annot\*id\*map*)[\[source\]](*modules/calibre/db/cache.html#Cache.update*annotations)[¶](#calibre.db.cache.Cache.update*annotations "Link to this definition")

Update annotations.

user\*categories\*for\*books(*book\*ids*,*proxy\*metadata\*map\=None*)[\[source\]](*modules/calibre/db/cache.html#Cache.user*categories*for*books)[¶](#calibre.db.cache.Cache.user*categories*for*books "Link to this definition")

Return the user categories for the specified books. proxy\*metadata\*map is optional and is useful for a performance boost, in contexts where a ProxyMetadata object for the books already exists. It should be a mapping of book\*ids to their corresponding ProxyMetadata objects.
