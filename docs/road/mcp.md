# MCP implementation plan

Amby's stdio server already exposes four read tools and three opt-in note edit
tools. The goal is an MCP client that can manage notes, database records and
creative workshops against one selected vault, including while desktop Amby has
that vault open.

Status: notes, archive, database management and workshop creation tools are implemented. The [tool contract](../mcp.md) lists the supported operations.

## 1. Structural note operations

- Add preview and execution tools for rename, move, archive and restore.
- Reuse the structural planner and journal. Report the source, destination,
  affected paths and link rewrites before publication.
- Check the grant against the entire plan under the same lock as publication.
  A folder grant covers both sides of a move and every rewritten note. Archive
  paths are checked against their logical vault location. Refuse a plan that
  exceeds the grant and leave the vault unchanged.
- Keep previews read-only and available under the same write grant as their
  matching operation. Do not replay an unrelated journal as a side effect of a
  scoped request.

## 2. Database tools

- List databases, inspect property definitions and query rows with bounded results.
- Create a database and its records and update supported values through the
  existing database domain. Accept stable IDs and revisions where the write
  API requires them. Return stable tool errors and use the domain journals for
  multi-file publication.
- Prove the write scope before accepting a mutation. A relation value that can
  change a different record requires a plan that covers both ends of the
  relation. Expose only explicitly supported property and value operations.
- Create reciprocal properties with both manifest revisions and edit Relation
  values with previews covering all inverse additions and removals.

## 3. Workshop tools

- List workshops and inspect their stories and sections.
- Use the journaled workshop domain to create workshops, stories and sections.
  Validate the destination container and return stable, vault-relative results.
- Check the complete destination and any existing files the domain updates
  before accepting a folder-scoped operation. Leave recovery to the existing
  owner of the relevant journal.

## Editing existing databases and workshops

- Rename database and property labels against the current manifest revision,
  preserving their paths, identifiers and stored values.
- Update workshop names and tags using the workshop journal and current revision.
- Read story text configuration and create manuscript pages with validated levels
  and parents in the story's own attached database.

## 4. Desktop delegation, client contract and verification

- Delegate mutations when the running desktop owns the vault lease. Verify the
  active canonical vault and the same grant and publish through the desktop's
  mutation gate. Keep read-only discovery independent of desktop state.
- Document the tool schemas, capability flags, preview semantics, output limits
  and errors. Keep existing stdio clients and the desktop AI bridge compatible.
- Test the stdio client with an isolated vault, including rejected cross-scope
  rewrites and stale revisions. Run the native storage contract with a live
  desktop and verify both durable changes and the refreshed index, alongside
  the normal repository checks.
