use super::*;

#[test]
fn the_block_is_appended_after_the_last_line_and_removed_byte_for_byte() {
    for original in [
        "",
        "export A=1\n",
        "export A=1",
        "alias x=y\r\nexport B=2\r\n",
    ] {
        let added = with_block(original);
        assert!(added.starts_with(original.trim_end_matches('\n')));
        assert!(has_block(&added));
        let back = without_block(&added).expect("the block is found");
        let expected = if original.is_empty() || original.ends_with('\n') {
            original.to_owned()
        } else {
            format!("{original}\n")
        };
        assert_eq!(back, expected);
    }
}

#[test]
fn text_around_the_block_is_kept_and_an_unfinished_block_is_left_alone() {
    let profile = format!("a\n{}b\n", with_block(""));
    assert_eq!(without_block(&profile).as_deref(), Some("a\nb\n"));
    let unfinished = format!("a\n{BLOCK_START}\nexport PATH=x\n");
    assert_eq!(without_block(&unfinished), None);
    // The marker quoted inside another line is not Amby's block.
    let quoted = format!("echo '{BLOCK_START}'\n{BLOCK_END}\n");
    assert_eq!(without_block(&quoted), None);
    assert!(!has_block(&quoted));
}

#[test]
fn path_entries_are_compared_as_whole_entries() {
    let dir = Path::new("/Users/p/.local/bin");
    assert!(path_has("/usr/bin:/Users/p/.local/bin/:/bin", dir, ':'));
    assert!(!path_has("/usr/bin:/Users/p/.local/bin2", dir, ':'));
    let win = Path::new("C:\\Program Files\\Amby");
    assert!(path_has(
        "%USERPROFILE%\\bin;c:\\program files\\amby\\",
        win,
        ';'
    ));
    assert!(!path_has("C:\\Program Files\\Amby2", win, ';'));
}

#[test]
fn the_windows_user_path_gains_and_loses_only_amby() {
    let dir = Path::new("C:\\Program Files\\Amby");
    assert_eq!(windows_path_with("", dir), "C:\\Program Files\\Amby");
    assert_eq!(
        windows_path_with("%USERPROFILE%\\bin;", dir),
        "%USERPROFILE%\\bin;C:\\Program Files\\Amby"
    );
    assert_eq!(
        windows_path_without("%USERPROFILE%\\bin;;C:\\Program Files\\Amby\\;D:\\x", dir),
        "%USERPROFILE%\\bin;;D:\\x"
    );
}

#[cfg(unix)]
mod unix_flow {
    use super::*;
    use std::fs;

    struct Home(PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn home() -> Home {
        let dir = std::env::temp_dir().join(format!(
            "amby-cli-path-{}-{}",
            std::process::id(),
            ulid::Ulid::generate()
        ));
        fs::create_dir_all(&dir).unwrap();
        Home(fs::canonicalize(&dir).unwrap())
    }

    fn env(home: &Path, shell: &str, login_path: Option<&str>) -> UnixEnv {
        let app = home.join("Amby.app/Contents/MacOS");
        fs::create_dir_all(&app).unwrap();
        let cli = app.join("amby");
        fs::write(&cli, "#!/bin/sh\n").unwrap();
        UnixEnv {
            home: home.to_path_buf(),
            shell: Some(PathBuf::from(shell)),
            cli: Some(cli),
            appimage: None,
            login_path: login_path.map(str::to_owned),
        }
    }

    #[test]
    fn install_links_the_cli_and_adds_the_line_once_then_remove_restores_the_profile() {
        let home = home();
        let profile = home.0.join(".zprofile");
        fs::write(&profile, "export EDITOR=vim").unwrap();
        let env = env(&home.0, "/bin/zsh", Some("/usr/bin:/bin"));
        assert_eq!(status(&env).state, CliPathState::Off);
        assert_eq!(
            status(&env).profile.as_deref(),
            Some(profile.to_str().unwrap())
        );

        let done = install(&env).unwrap();
        assert_eq!(done.state, CliPathState::On);
        let link = home.0.join(".local/bin/amby");
        assert_eq!(fs::read_link(&link).unwrap(), env.cli.clone().unwrap());
        install(&env).unwrap();
        let text = fs::read_to_string(&profile).unwrap();
        assert!(text.starts_with("export EDITOR=vim\n"));
        assert_eq!(text.matches(BLOCK_START).count(), 1);

        assert_eq!(remove(&env).unwrap().state, CliPathState::Off);
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_to_string(&profile).unwrap(), "export EDITOR=vim\n");
    }

    #[test]
    fn a_shell_that_already_searches_the_folder_keeps_its_profile_untouched() {
        let home = home();
        let path = format!("/usr/bin:{}", home.0.join(".local/bin").display());
        let env = env(&home.0, "/bin/zsh", Some(&path));
        assert_eq!(install(&env).unwrap().state, CliPathState::On);
        assert!(!home.0.join(".zprofile").exists());
    }

    #[test]
    fn a_foreign_amby_is_never_replaced_or_removed() {
        let home = home();
        let env = env(&home.0, "/bin/zsh", None);
        let link = home.0.join(".local/bin/amby");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        fs::write(&link, "someone else's amby").unwrap();
        assert_eq!(status(&env).state, CliPathState::Taken);
        assert_eq!(install(&env), Err(CliPathError::Taken));
        remove(&env).unwrap();
        assert_eq!(fs::read_to_string(&link).unwrap(), "someone else's amby");
        assert!(!home.0.join(".zprofile").exists());
    }

    #[test]
    fn a_link_left_by_an_app_that_moved_is_replaced() {
        let home = home();
        let env = env(&home.0, "/bin/zsh", None);
        let link = home.0.join(".local/bin/amby");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("/Volumes/Gone/Amby.app/Contents/MacOS/amby", &link).unwrap();
        assert_eq!(status(&env).state, CliPathState::Off);
        assert_eq!(install(&env).unwrap().state, CliPathState::On);
        assert_eq!(fs::read_link(&link).unwrap(), env.cli.clone().unwrap());
    }

    #[test]
    fn a_profile_kept_as_a_link_stays_a_link_after_removal() {
        let home = home();
        let real = home.0.join("dotfiles-zprofile");
        fs::write(&real, "export A=1\n").unwrap();
        std::os::unix::fs::symlink(&real, home.0.join(".zprofile")).unwrap();
        let env = env(&home.0, "/bin/zsh", None);
        install(&env).unwrap();
        assert!(fs::read_to_string(&real).unwrap().contains(BLOCK_START));
        remove(&env).unwrap();
        assert!(fs::symlink_metadata(home.0.join(".zprofile"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "export A=1\n");
    }

    #[test]
    fn an_unknown_shell_gets_the_link_and_a_note_to_add_the_folder() {
        let home = home();
        let env = env(&home.0, "/usr/bin/fish", Some("/usr/bin"));
        let done = install(&env).unwrap();
        assert_eq!(done.state, CliPathState::NeedsPath);
        assert_eq!(done.profile, None);
    }

    #[test]
    fn an_appimage_gets_a_wrapper_that_runs_the_cli_inside_it() {
        let home = home();
        let image = home.0.join("Amby's.AppImage");
        fs::write(&image, "").unwrap();
        let mut env = env(&home.0, "/bin/bash", None);
        env.cli = None;
        env.appimage = Some(image);
        install(&env).unwrap();
        let script = fs::read_to_string(home.0.join(".local/bin/amby")).unwrap();
        assert!(script.contains("'\\''s.AppImage' --amby-cli \"$@\""));
        assert_eq!(status(&env).state, CliPathState::On);
        remove(&env).unwrap();
        assert!(!home.0.join(".local/bin/amby").exists());
    }

    #[test]
    fn without_a_bundled_cli_nothing_is_offered() {
        let home = home();
        let mut env = env(&home.0, "/bin/zsh", None);
        env.cli = None;
        assert_eq!(status(&env).state, CliPathState::Unavailable);
        assert_eq!(install(&env), Err(CliPathError::Unavailable));
    }
}
