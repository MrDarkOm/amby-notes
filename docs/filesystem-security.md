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

## Residual TOCTOU risk

Pathname validation cannot prevent a privileged concurrent process from
swapping a directory for a symlink after validation. A directory-handle-based
capability API would be required for complete cross-platform protection; this
is tracked as a hardening follow-up. It does not weaken the traversal and
pre-existing-symlink protections covered by the test suite.
