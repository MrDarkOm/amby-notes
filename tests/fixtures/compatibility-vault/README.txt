Compatibility vault

Permanent source fixtures for index and lossless-editor regression tests.
They intentionally include generic and duplicate identities, malformed YAML,
Unicode, wikilinks, HTML, tables, code, and unsupported directive syntax.
Do not edit this directory from tests: copy it to a unique temporary vault
first. CRLF.md contains actual CRLF bytes; BOM.md starts with EF BB BF.
.gitattributes disables Git text conversion for these two files and the entire
corpus is excluded from Prettier. Rust verifies the byte markers and compares
every Markdown file before and after deleting/rebuilding only SQLite.

Coverage inventory:
Plain Markdown: paragraphs, tables, code, raw HTML, unknown directives.
Unicode: Russian/Ukrainian/Japanese/emoji and wiki links.
YAML presentation: comments, both quote styles, inline/nested YAML, aliases,
heading links, transclusion, custom fence language.
Generic id: external text alongside trusted amby-id.
External canonical ULID: generic id is only a migration candidate.
Duplicate primary/copy: both notes remain visible with an identity diagnostic.
Malformed YAML: searchable body without automatic source repair.
CRLF/BOM: explicit byte encodings preserved by rebuild and body-write tests.
