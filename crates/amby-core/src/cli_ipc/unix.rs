use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tokio::net::{UnixListener, UnixStream};

pub type Stream = UnixStream;

fn uid() -> u32 {
    // SAFETY: geteuid has no arguments or memory preconditions.
    unsafe { libc::geteuid() }
}

fn directory(profile: &Path) -> io::Result<PathBuf> {
    // Keep socket paths within sockaddr_un even for deeply nested profiles.
    Ok(Path::new("/tmp").join(format!("amby-{}-{}", uid(), super::profile_key(profile)?)))
}

fn check_directory(directory: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(directory)?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn authenticate(stream: Stream) -> io::Result<Stream> {
    if stream.peer_cred()?.uid() != uid() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(stream)
}

pub struct Listener {
    listener: UnixListener,
    socket: PathBuf,
    _lease: File,
}

impl Listener {
    pub fn bind(profile: &Path) -> io::Result<Self> {
        let directory = directory(profile)?;
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        check_directory(&directory)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join("listen.lock"))?;
        if !lease.metadata()?.is_file() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        lease.try_lock().map_err(io::Error::from)?;
        let socket = directory.join("local.sock");
        match fs::symlink_metadata(&socket) {
            Ok(meta) if meta.file_type().is_socket() && meta.uid() == uid() => {
                fs::remove_file(&socket)?
            }
            Ok(_) => return Err(io::ErrorKind::PermissionDenied.into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            listener,
            socket,
            _lease: lease,
        })
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
        authenticate(self.listener.accept().await?.0)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
    }
}

pub async fn connect(profile: &Path) -> io::Result<Stream> {
    let directory = directory(profile)?;
    check_directory(&directory)?;
    authenticate(Stream::connect(directory.join("local.sock")).await?)
}
