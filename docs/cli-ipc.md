# Local CLI protocol

When a structural write cannot acquire the vault's process lease, the CLI
connects to desktop Amby for the same app-data profile. The desktop may operate
only on its current canonical vault. It checks that root while holding the
mutation gate, which also orders vault switches and editor saves. The desktop
uses the same structural planner, no-replace writes and recovery journal as the
standalone CLI.

## Transport

On Unix the endpoint is a Unix-domain socket in a private directory under
`/tmp`. The directory is specific to the local user and to a digest of the
canonical app-data profile path. The client and server also verify the peer's
effective user ID. A listener lock prevents a second server from taking over a
live endpoint. The next server can remove a stale socket after acquiring the
listener lock.

On Windows the endpoint is a local named pipe specific to the current user SID
and the canonical app-data profile. The protected pipe ACL grants access to that
SID. Remote clients are rejected and the client checks the server's user SID
before sending a request.

Each connection carries one request and one response. A frame starts with a
four-byte unsigned big-endian length followed by a UTF-8 JSON document. The
maximum request size is 64 KiB. The maximum response size is 8 MiB. The server
allows five seconds to receive a request. The CLI waits for the result for up to
five minutes. A disconnect or timeout after connecting leaves the outcome
unconfirmed and returns `desktopRequestInterrupted`. The CLI never resends the
request or writes directly in that case.

## Version 1

```json
{
  "version": 1,
  "vault": "/canonical/path/to/vault",
  "action": { "kind": "rename", "path": "Projects/Old.md", "name": "New" }
}
```

The action is `rename` with `path` and `name`, `move` with `path` and `folder`,
`archive` or `restore` with `path`, or `recover`. The additive `tool` action carries the MCP mutation and its folder grant. The desktop checks that grant before publication and never replays an unrelated journal for a tool request. Paths in the action are relative
to the vault or, for `restore`, to the archive. The server returns
`desktopProtocolVersion` for another version, `invalidArguments` for an invalid
action, and `vaultNotActive` for an inactive or different vault.

```json
{
  "version": 1,
  "result": {
    "Ok": {
      "kind": "mutation",
      "value": {
        "source": "Projects/Old.md",
        "destination": "Projects/New.md",
        "rewrittenPaths": ["Reference.md"],
        "dryRun": false
      }
    }
  }
}
```

Recovery returns `{"Ok":{"kind":"recovery","value":true}}` when a structural
journal was resumed and `false` when there was no structural journal. An error
uses `{"Err":"code"}` in the result. The CLI converts these frames to its usual
[command output and exit codes](cli.md#json-and-exit-codes).
