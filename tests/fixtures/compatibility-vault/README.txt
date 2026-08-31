Compatibility vault

Permanent source fixtures for index and lossless-editor regression tests.
They intentionally include generic and duplicate identities, malformed YAML,
Unicode, wikilinks, HTML, tables, code, and unsupported directive syntax.
Do not edit this directory from tests: copy it to a unique temporary vault
first. CRLF/BOM-specific byte preservation remains covered by the focused
frontmatter and desktop reliability tests because repository patches are text
normalized by tooling.
