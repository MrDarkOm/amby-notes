use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::null_mut;

use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_PIPE_BUSY, HANDLE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub type Stream = NamedPipeServer;

fn pipe_name(profile: &Path, sid: &str) -> io::Result<String> {
    Ok(format!(
        r"\\.\pipe\amby-notes-{}-{sid}",
        super::profile_key(profile)?
    ))
}

struct LocalAllocation(*mut std::ffi::c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: the Windows conversion functions allocate these buffers with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

fn sid_string(sid: PSID) -> io::Result<String> {
    let mut text = null_mut();
    // SAFETY: sid is supplied by a live TokenUser buffer. Windows returns a NUL-terminated string.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = LocalAllocation(text.cast());
    // SAFETY: the allocated string contains a terminator and stays alive through the conversion.
    let len = (0..)
        .take_while(|&offset| unsafe { *text.add(offset) } != 0)
        .count();
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) }).map_err(io::Error::other)
}

fn user_sid(process: HANDLE) -> io::Result<String> {
    let mut token = null_mut();
    // SAFETY: process is a live process handle and token is a writable output parameter.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned ownership of a real handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut bytes = 0;
    // SAFETY: the null buffer asks the API for its required size.
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut bytes) };
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        || bytes < size_of::<TOKEN_USER>() as u32
    {
        return Err(io::Error::last_os_error());
    }
    // Use pointer-aligned storage for TOKEN_USER and the trailing SID data.
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the buffer is aligned and has at least the requested size.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation initialized a TOKEN_USER whose SID is inside this buffer.
    sid_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}

fn current_sid() -> io::Result<String> {
    // SAFETY: the current process pseudo-handle is always valid and does not need closing.
    user_sid(unsafe { GetCurrentProcess() })
}

fn open_listener(name: &str, sid: &str, first: bool) -> io::Result<NamedPipeServer> {
    let dacl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain([0])
        .collect();
    let mut descriptor = null_mut();
    // SAFETY: dacl is a NUL-terminated SDDL string and descriptor is a writable output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            dacl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let _allocation = LocalAllocation(descriptor);
    let mut attrs = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: attrs and its descriptor are valid until CreateNamedPipeW returns.
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .max_instances(2)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
}

pub struct Listener {
    name: String,
    sid: String,
    next: NamedPipeServer,
}

impl Listener {
    pub fn bind(profile: &Path) -> io::Result<Self> {
        let sid = current_sid()?;
        let name = pipe_name(profile, &sid)?;
        let next = open_listener(&name, &sid, true)?;
        Ok(Self { name, sid, next })
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
        self.next.connect().await?;
        let replacement = open_listener(&self.name, &self.sid, false)?;
        Ok(std::mem::replace(&mut self.next, replacement))
    }
}

fn check_server(stream: &NamedPipeClient, expected: &str) -> io::Result<()> {
    let mut pid = 0;
    // SAFETY: the named pipe is connected, and pid is a writable output parameter.
    if unsafe { GetNamedPipeServerProcessId(stream.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcess accepts the system-supplied process ID.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcess returned an owned handle.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    if user_sid(process.as_raw_handle())? != expected {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub async fn connect(profile: &Path) -> io::Result<NamedPipeClient> {
    let sid = current_sid()?;
    let name = pipe_name(profile, &sid)?;
    loop {
        // Tokio uses SECURITY_IDENTIFICATION so the server cannot impersonate this client.
        match ClientOptions::new().open(&name) {
            Ok(stream) => {
                check_server(&stream, &sid)?;
                return Ok(stream);
            }
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    }
}
