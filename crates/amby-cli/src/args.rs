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
    Search(Option<String>),
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
    Delete(String),
    Prop(Prop),
    Orphans,
    Unresolved,
    Info(String),
    Attachments(String),
    Attach { note: String, file: PathBuf },
    Bulk(Bulk),
    Templates,
    Daily { append: bool },
}

pub enum Bulk {
    Set { name: String, values: Vec<String> },
    Move { folder: String },
}

pub enum Prop {
    List(String),
    Set {
        note: String,
        name: String,
        values: Vec<String>,
    },
    Style {
        note: String,
        name: String,
    },
    Rename {
        note: String,
        name: String,
        new_name: String,
    },
    Delete {
        note: String,
        name: String,
    },
    Order {
        note: String,
        names: Vec<String>,
    },
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
    /// `search` filters.
    pub tags: Vec<String>,
    pub properties: Vec<String>,
    pub folder: Option<String>,
    pub limit: Option<usize>,
    /// `prop set` and `prop style`.
    pub property_type: Option<String>,
    pub icon: Option<String>,
    pub settings: Option<String>,
    /// `bulk`: a text query, and the confirmation that the edit may run.
    pub query: Option<String>,
    pub yes: bool,
    /// `attach`.
    pub name: Option<String>,
    pub no_link: bool,
    /// `new` and `daily`: the template to start from.
    pub template: Option<String>,
    /// `daily`: the day, `YYYY-MM-DD`.
    pub date: Option<String>,
}

impl Options {
    fn has_search_filters(&self) -> bool {
        !self.tags.is_empty()
            || !self.properties.is_empty()
            || self.folder.is_some()
            || self.limit.is_some()
    }

    /// Every option given fits the command.
    fn fit(&self, command: &Command) -> bool {
        use Command as C;
        let search = matches!(command, C::Search(_));
        let listing = matches!(command, C::Orphans | C::Unresolved);
        let bulk = matches!(command, C::Bulk(_));
        let daily = matches!(command, C::Daily { .. });
        let filters = !self.tags.is_empty() || !self.properties.is_empty();
        let new = matches!(
            command,
            C::Edit {
                kind: EditKind::New,
                ..
            }
        );
        if self.file.is_some() && !matches!(command, C::Edit { .. } | C::Daily { append: true }) {
            return false;
        }
        // A template is the content of the new note, so it does not mix with --file.
        if self.template.is_some() && (!(new || daily) || new && self.file.is_some()) {
            return false;
        }
        if self.date.is_some() && !daily {
            return false;
        }
        if self.dry_run
            && !matches!(
                command,
                C::Edit { .. }
                    | C::Rename { .. }
                    | C::Move { .. }
                    | C::Archive(_)
                    | C::Restore(_)
                    | C::Delete(_)
                    | C::Bulk(_)
                    | C::Daily { .. }
            )
        {
            return false;
        }
        if self.write_access.is_some() && !matches!(command, C::Mcp) {
            return false;
        }
        if filters && !(search || bulk) {
            return false;
        }
        if self.folder.is_some() && !(search || listing || bulk || daily) {
            return false;
        }
        if self.limit.is_some() && !(search || listing) {
            return false;
        }
        if matches!(command, C::Search(None)) && !self.has_search_filters() {
            return false;
        }
        if self.query.is_some() && !bulk || self.yes && !bulk {
            return false;
        }
        // A bulk edit names its notes and says whether it is a preview or the real run.
        if bulk
            && (self.dry_run == self.yes
                || !filters && self.folder.is_none() && self.query.is_none())
        {
            return false;
        }
        if self.property_type.is_some()
            && !matches!(
                command,
                C::Prop(Prop::Set { .. } | Prop::Style { .. }) | C::Bulk(Bulk::Set { .. })
            )
        {
            return false;
        }
        if (self.icon.is_some() || self.settings.is_some())
            && !matches!(command, C::Prop(Prop::Style { .. }))
        {
            return false;
        }
        if (self.name.is_some() || self.no_link) && !matches!(command, C::Attach { .. }) {
            return false;
        }
        true
    }
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
            (false, Some("--yes")) => options.yes = true,
            (false, Some("--no-link")) => options.no_link = true,
            (
                false,
                Some(
                    flag @ ("--tag" | "--property" | "--folder" | "--limit" | "--type" | "--icon"
                    | "--settings" | "--query" | "--name" | "--template" | "--date"),
                ),
            ) => {
                let Some(value) = args.next().and_then(|value| value.into_string().ok()) else {
                    invalid = true;
                    continue;
                };
                let once = |slot: &mut Option<String>, invalid: &mut bool| {
                    if slot.replace(value.clone()).is_some() {
                        *invalid = true;
                    }
                };
                match flag {
                    "--tag" if !value.is_empty() => options.tags.push(value),
                    "--property" if !value.is_empty() => options.properties.push(value),
                    "--folder" => once(&mut options.folder, &mut invalid),
                    "--limit" => match value.parse::<usize>() {
                        Ok(limit) if (1..=1000).contains(&limit) && options.limit.is_none() => {
                            options.limit = Some(limit)
                        }
                        _ => invalid = true,
                    },
                    "--type" => once(&mut options.property_type, &mut invalid),
                    "--icon" => once(&mut options.icon, &mut invalid),
                    "--settings" => once(&mut options.settings, &mut invalid),
                    "--query" if !value.trim().is_empty() => once(&mut options.query, &mut invalid),
                    "--name" => once(&mut options.name, &mut invalid),
                    "--template" if !value.trim().is_empty() => {
                        once(&mut options.template, &mut invalid)
                    }
                    "--date" => once(&mut options.date, &mut invalid),
                    _ => invalid = true,
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
            if options.fit(&command) {
                Ok(command)
            } else {
                Err("usage")
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
                ["search"] => Ok(Search(None)),
                ["search", _] => Ok(Search(Some(text(&args[1])?))),
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
                ["delete", path] => Ok(Delete((*path).into())),
                ["orphans"] => Ok(Orphans),
                ["unresolved"] => Ok(Unresolved),
                ["info", note] => Ok(Info((*note).into())),
                ["attachments", note] => Ok(Attachments((*note).into())),
                ["attach", note, _] => Ok(Attach {
                    note: (*note).into(),
                    file: args[2].clone().into(),
                }),
                ["prop", "order", note, names @ ..] if !names.is_empty() => {
                    Ok(Prop(self::Prop::Order {
                        note: (*note).into(),
                        names: names.iter().map(|name| (*name).to_owned()).collect(),
                    }))
                }
                ["bulk", "set", name, values @ ..] => Ok(Bulk(self::Bulk::Set {
                    name: (*name).into(),
                    values: values.iter().map(|value| (*value).to_owned()).collect(),
                })),
                ["bulk", "move", folder] => Ok(Bulk(self::Bulk::Move {
                    folder: (*folder).into(),
                })),
                ["prop", "list", note] => Ok(Prop(self::Prop::List((*note).into()))),
                ["prop", "set", note, name, values @ ..] => Ok(Prop(self::Prop::Set {
                    note: (*note).into(),
                    name: (*name).into(),
                    values: values.iter().map(|value| (*value).to_owned()).collect(),
                })),
                ["prop", "style", note, name] => Ok(Prop(self::Prop::Style {
                    note: (*note).into(),
                    name: (*name).into(),
                })),
                ["prop", "rename", note, name, new_name] => Ok(Prop(self::Prop::Rename {
                    note: (*note).into(),
                    name: (*name).into(),
                    new_name: (*new_name).into(),
                })),
                ["prop", "delete", note, name] => Ok(Prop(self::Prop::Delete {
                    note: (*note).into(),
                    name: (*name).into(),
                })),
                ["templates"] => Ok(Templates),
                ["daily"] => Ok(Daily { append: false }),
                ["daily", "append"] => Ok(Daily { append: true }),
                ["mcp"] => Ok(Mcp),
                _ => Err("usage"),
            }
        }
    }
}
