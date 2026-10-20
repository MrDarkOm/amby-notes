# Filesystem security matrix

Vault paths are scoped through `paths::guard` / `paths::confine`. Existing
paths and the nearest existing ancestor for new paths are canonicalized before
the path is accepted, so a traversal or symlink cannot escape the active vault.

| Operation              | Input                               | Scope and test coverage                                                                                                |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Read/write note        | IPC absolute path or note ID        | Active-vault guard; traversal and symlink escape tests                                                                 |
| Create/rename/move     | IPC paths                           | Both operands guarded before mutation; target collisions fail without overwrite                                        |
| Delete                 | IPC path                            | `recycle_bin::preview_move_to_trash` canonicalizes and verifies the resolved path is under the vault before its rename |
| Import                 | External source + vault destination | Source may be external; destination is guarded and `atomic_copy_file_new` refuses replacement                          |
| App data               | Relative path                       | `confine_rel` rejects absolute paths and `..` traversal                                                                |
| History/recovery/trash | Internal paths                      | Roots derive from a canonical active vault; generated identifiers name data files                                      |

`remove_dir_all` is only used for temporary test vault cleanup and app-data
directories derived from the application data root. Vault deletion is a rename
into `.amby/trash`, not a recursive deletion.

## Opening files and addresses with the system

A click on an attachment card or a bookmark card asks the backend (`open_attachment`,
`open_web_address` in `src-tauri/src/commands/external.rs`) to hand it to the system's
own program. Opening a program or a script means running it, and a note can come from
outside, so the rule is a list of what may be opened, not a list of what may not:

- A file is opened only if its real path (symbolic links followed) lies inside the vault,
  under an `assets` folder, in no hidden folder, and its real extension is on the
  list of documents and media (`OPENABLE_EXTENSIONS`: pdf, txt, csv, docx, xlsx, pptx, odt,
  ods, odp, common audio, video and image formats). Archives, SVG, macro-enabled Office
  files and everything that runs are not on it. The extension is judged in any letter
  case and only the last one counts, so `file.pdf.command` is refused.
- An address is opened only if it is an `http` or `https` one with a host and no
  credentials.
- The webview sends the note and the address as written in the node it was clicked on;
  the refusal is a code (`AttachmentOutsideAssets`, `AttachmentTypeNotAllowed`, ...) that
  the webview turns into a sentence.
- "Save image as…" (`save_attachment_copy`, same file) judges the file by exactly the same
  rules, asks where to put it with the system's save dialog and copies the file's own
  bytes there; the webview never names a path outside the vault. It adds no plugin
  permission either.
- No Tauri plugin that opens paths or runs programs is added to any window's
  capabilities (`tauri-capabilities.test.ts` guards this).

## Fetching the title of a web page

The "Fetch title" button of a bookmark card is the only place where a note leads the app
to make a network request, and it is made by the backend (`fetch_page_info`,
`src-tauri/src/page_info.rs`), not by the webview, whose CSP still allows no remote
address. One press is one request, to one page the person has already written in the note:

- Only `http`/`https`; no credentials in the address; no cookies, no proxy, a neutral
  `User-Agent`, nothing about the user or the vault is sent.
- No address of this computer or of a local network: loopback, private (10/8, 172.16/12,
  192.168/16), link-local, unique-local IPv6, shared (100.64/10), documentation and
  reserved ranges, IPv4 inside IPv6 (mapped, NAT64, 6to4), and names such as `localhost`,
  `*.local`, `*.lan`, single-label names. The name is resolved by the backend, every address
  it resolves to must be public, and the connection is pinned to the checked address, so
  a second lookup cannot give another one. Every redirect (at most 5) is checked again.
- Ten seconds in all; the first 256 KB of the answer only; only `text/html` in UTF-8.
- Title and description are cut out as plain text: one line, no control or invisible
  characters, at most 200 and 300 characters. Brackets and angle brackets of a title are
  replaced by look-alikes so that it cannot become a link or an HTML tag. Nothing from the
  answer is run, shown as HTML or fetched (no images, icons or scripts).
- A refusal changes nothing in the note; the person gets a short message.

## Residual TOCTOU risk

Pathname validation cannot prevent a privileged concurrent process from
swapping a directory for a symlink after validation. A directory-handle-based
capability API would be required for complete cross-platform protection; this
is tracked as a hardening follow-up. It does not weaken the traversal and
pre-existing-symlink protections covered by the test suite.
