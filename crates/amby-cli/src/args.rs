use amby_core::note_edit::EditKind;
use std::ffi::OsString;
use std::path::PathBuf;

pub enum Command {
    Help,
    Version,
    VaultList,
    VaultUse(PathBuf),
    List(String),
    Cat(String),
    Search(String),
    Links { note: String, incoming: bool },
    Tags,
    Open(String),
    Edit { kind: EditKind, note: String },
    Rename { path: String, name: String },
    Move { path: String, folder: String },
    Archive(String),
    ArchiveList,
    Restore(String),
    Recover,
    Mcp,
}

pub enum WriteAccess {
    Vault,
    Folder(String),
}

#[derive(Default)]
pub struct Options {
    pub vault: Option<PathBuf>,
    pub json: bool,
    pub file: Option<PathBuf>,
    pub dry_run: bool,
    pub write_access: Option<WriteAccess>,
}

pub fn parse(args: impl IntoIterator<Item = OsString>) -> (Options, Result<Command, &'static str>) {
    let mut options = Options::default();
    let mut args = args.into_iter().peekable();
    let mut positional = Vec::new();
    let mut positional_only = false;
    let mut help = false;
    let mut invalid = false;
    while let Some(arg) = args.next() {
        match (positional_only, arg.to_str()) {
            (false, Some("--")) => positional_only = true,
            (false, Some("--json")) => options.json = true,
            (false, Some("--dry-run")) => options.dry_run = true,
            (false, Some("--allow-write")) if options.write_access.is_none() => {
                options.write_access = Some(WriteAccess::Vault);
            }
            (false, Some(arg)) if arg.starts_with("--allow-write=") => {
                let folder = &arg["--allow-write=".len()..];
                if folder.is_empty() || options.write_access.is_some() {
                    invalid = true;
                } else {
                    options.write_access = Some(WriteAccess::Folder(folder.to_owned()));
                }
            }
            (false, Some("--file")) => {
                if args.peek().is_some_and(|next| {
                    !next.is_empty() && !next.to_string_lossy().starts_with('-')
                }) {
                    options.file = args.next().map(PathBuf::from);
                } else {
                    invalid = true;
                }
            }
            (false, Some("--vault")) => {
                if args.peek().is_some_and(|next| {
                    !next.is_empty() && !next.to_string_lossy().starts_with('-')
                }) {
                    options.vault = args.next().map(PathBuf::from);
                } else {
                    invalid = true;
                }
            }
            (false, Some(arg)) if arg.starts_with("--vault=") => {
                if arg.len() == "--vault=".len() {
                    invalid = true;
                } else {
                    options.vault = Some(arg["--vault=".len()..].into());
                }
            }
            (false, Some("--help" | "-h")) => help = true,
            (false, Some("--version" | "-V")) => positional.push("version".into()),
            (false, Some(arg)) if arg.starts_with('-') => invalid = true,
            _ => positional.push(arg),
        }
    }
    let command = if invalid {
        Err("usage")
    } else if help {
        Ok(Command::Help)
    } else {
        parse_command(&positional).and_then(|command| {
            if options.file.is_some() && !matches!(command, Command::Edit { .. })
                || options.dry_run
                    && !matches!(
                        command,
                        Command::Edit { .. }
                            | Command::Rename { .. }
                            | Command::Move { .. }
                            | Command::Archive(_)
                            | Command::Restore(_)
                    )
                || options.write_access.is_some() && !matches!(command, Command::Mcp)
            {
                Err("usage")
            } else {
                Ok(command)
            }
        })
    };
    (options, command)
}

fn parse_command(args: &[OsString]) -> Result<Command, &'static str> {
    use Command::*;
    let text = |arg: &OsString| arg.to_str().map(str::to_owned).ok_or("invalidArguments");
    match args {
        [first, second, path] if first == "vault" && second == "use" => Ok(VaultUse(path.into())),
        _ => {
            let words: Vec<&str> = args
                .iter()
                .map(|arg| arg.to_str().ok_or("invalidArguments"))
                .collect::<Result<_, _>>()?;
            match words.as_slice() {
                [] | ["help"] => Ok(Help),
                ["version"] => Ok(Version),
                ["vault", "list"] => Ok(VaultList),
                ["ls"] => Ok(List(String::new())),
                ["ls", _] => Ok(List(text(&args[1])?)),
                ["cat", _] => Ok(Cat(text(&args[1])?)),
                ["search", _] => Ok(Search(text(&args[1])?)),
                [direction @ ("links" | "backlinks"), _] => Ok(Links {
                    note: text(&args[1])?,
                    incoming: *direction == "backlinks",
                }),
                ["tags"] => Ok(Tags),
                ["open", _] => Ok(Open(text(&args[1])?)),
                ["new", note] => Ok(Edit {
                    kind: EditKind::New,
                    note: (*note).to_owned(),
                }),
                ["append", note] => Ok(Edit {
                    kind: EditKind::Append,
                    note: (*note).to_owned(),
                }),
                ["write", note] => Ok(Edit {
                    kind: EditKind::Write,
                    note: (*note).to_owned(),
                }),
                ["rename", path, name] => Ok(Rename {
                    path: (*path).into(),
                    name: (*name).into(),
                }),
                ["move", path, folder] => Ok(Move {
                    path: (*path).into(),
                    folder: (*folder).into(),
                }),
                ["archive", "list"] => Ok(ArchiveList),
                ["archive", path] => Ok(Archive((*path).into())),
                ["restore", path] => Ok(Restore((*path).into())),
                ["recover"] => Ok(Recover),
                ["mcp"] => Ok(Mcp),
                _ => Err("usage"),
            }
        }
    }
}
