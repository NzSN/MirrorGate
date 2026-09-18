use crate::{Error, Result};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{FileTypeExt, MetadataExt},
        unix::net::UnixStream,
    },
    path::{Component, Path},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProcessCloseState {
    NotOwned,
    Exited(i32),
    Signaled(i32),
    ReapedUnknown,
    Unconfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlCloseReceipt {
    pub transport_closed: bool,
    pub process_owned: bool,
    pub process_state: ProcessCloseState,
    pub terminate_requested: bool,
    pub kill_requested: bool,
}
impl ControlCloseReceipt {
    #[must_use]
    pub fn process_shutdown_confirmed(&self) -> bool {
        self.transport_closed
            && matches!(
                (&self.process_owned, &self.process_state),
                (false, ProcessCloseState::NotOwned)
                    | (
                        true,
                        ProcessCloseState::Exited(_)
                            | ProcessCloseState::Signaled(_)
                            | ProcessCloseState::ReapedUnknown
                    )
            )
    }
}

pub(crate) struct Transport {
    reader: Option<File>,
    writer: Option<File>,
    child: Option<Child>,
    attached: bool,
    buffer: Vec<u8>,
    io_timeout: Duration,
    close_timeout: Duration,
    closed: bool,
    stderr_stop: Arc<AtomicBool>,
    stderr_thread: Option<thread::JoinHandle<()>>,
    close_receipt: Option<ControlCloseReceipt>,
}

fn wait_fd(fd: i32, events: i16, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut descriptor = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::deadline("transport deadline exceeded"));
        }
        let milliseconds =
            i32::try_from(remaining.as_millis().max(1).min(i32::MAX as u128)).unwrap_or(i32::MAX);
        // SAFETY: descriptor points to one initialized pollfd for the duration of the call.
        let result = unsafe { libc::poll(&raw mut descriptor, 1, milliseconds) };
        if result > 0 {
            if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(Error::disconnected("transport poll failed"));
            }
            return Ok(());
        }
        if result == 0 {
            return Err(Error::deadline("transport deadline exceeded"));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(Error::transport(error.to_string()));
        }
    }
}

impl Transport {
    pub(crate) fn launch(
        command: &crate::control::ControllerCommand,
        io_timeout: Duration,
        close_timeout: Duration,
        stderr_limit: usize,
    ) -> Result<Self> {
        if command.program.as_os_str().is_empty() {
            return Err(Error::argument("controller program is required"));
        }
        let mut builder = Command::new(&command.program);
        builder
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &command.cwd {
            builder.current_dir(cwd);
        }
        if let Some(env) = &command.env {
            builder.env_clear().envs(env);
        }
        let mut child = builder
            .spawn()
            .map_err(|e| Error::transport(format!("launch controller: {e}")))?;
        let acquired = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(stdin), Some(stdout), Some(mut stderr)) = acquired else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::transport("controller stdio unavailable"));
        };
        let stdout_fd: OwnedFd = stdout.into();
        let stdin_fd: OwnedFd = stdin.into();
        if let Err(error) = set_nonblocking(stdout_fd.as_raw_fd())
            .and_then(|()| set_nonblocking(stdin_fd.as_raw_fd()))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stderr_stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stderr_stop);
        let stderr_thread = thread::spawn(move || {
            let fd = stderr.as_raw_fd();
            let mut total = 0_usize;
            let mut chunk = [0_u8; 4096];
            while !thread_stop.load(Ordering::Acquire) {
                let mut pollfd = libc::pollfd {
                    fd,
                    events: libc::POLLIN | libc::POLLHUP,
                    revents: 0,
                };
                // SAFETY: pollfd is initialized and borrowed only for this call.
                let ready = unsafe { libc::poll(&raw mut pollfd, 1, 50) };
                if ready <= 0 {
                    continue;
                }
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        total = total.saturating_add(count).min(stderr_limit);
                    }
                }
            }
        });
        Ok(Self {
            reader: Some(File::from(stdout_fd)),
            writer: Some(File::from(stdin_fd)),
            child: Some(child),
            attached: false,
            buffer: Vec::new(),
            io_timeout,
            close_timeout,
            closed: false,
            stderr_stop,
            stderr_thread: Some(stderr_thread),
            close_receipt: None,
        })
    }

    pub(crate) fn connect_unix(
        path: &Path,
        connect_timeout: Duration,
        io_timeout: Duration,
    ) -> Result<Self> {
        let before = verify_socket(path)?;
        let bytes = path.as_os_str().as_encoded_bytes();
        // SAFETY: libc socket returns a new descriptor or -1 and has no borrowed pointers.
        let raw_fd = unsafe {
            libc::socket(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                0,
            )
        };
        if raw_fd < 0 {
            return Err(Error::transport(
                std::io::Error::last_os_error().to_string(),
            ));
        }
        // SAFETY: raw_fd was returned as a new uniquely owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let connected = (|| {
            // SAFETY: zero is a valid initial representation for sockaddr_un.
            let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
            address.sun_family = libc::AF_UNIX as libc::sa_family_t;
            if bytes.len() >= address.sun_path.len() {
                return Err(Error::argument("Unix socket path exceeds 107 bytes"));
            }
            for (target, source) in address.sun_path.iter_mut().zip(bytes) {
                *target = *source as libc::c_char;
            }
            let length = libc::socklen_t::try_from(
                std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1,
            )
            .map_err(|_| Error::argument("Unix socket path is too long"))?;
            // SAFETY: address is initialized and length covers its family/path prefix.
            let result = unsafe {
                libc::connect(
                    fd.as_raw_fd(),
                    (&raw const address).cast::<libc::sockaddr>(),
                    length,
                )
            };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINPROGRESS) {
                    return Err(Error::transport(format!("connect Unix socket: {error}")));
                }
                wait_fd(fd.as_raw_fd(), libc::POLLOUT, connect_timeout)?;
                let mut socket_error = 0_i32;
                let mut size = libc::socklen_t::try_from(std::mem::size_of::<i32>()).unwrap();
                // SAFETY: socket_error and size are valid output pointers for SO_ERROR.
                if unsafe {
                    libc::getsockopt(
                        fd.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_ERROR,
                        (&raw mut socket_error).cast(),
                        &raw mut size,
                    )
                } < 0
                    || socket_error != 0
                {
                    return Err(Error::transport(if socket_error == 0 {
                        std::io::Error::last_os_error().to_string()
                    } else {
                        std::io::Error::from_raw_os_error(socket_error).to_string()
                    }));
                }
            }
            Ok(())
        })();
        connected?;
        let after = verify_socket(path)?;
        if before != after {
            return Err(Error::transport(
                "Unix socket identity changed during connect",
            ));
        }
        let stream = UnixStream::from(fd);
        stream.set_nonblocking(true)?;
        let reader_fd: OwnedFd = stream.try_clone()?.into();
        let writer_fd: OwnedFd = stream.into();
        Ok(Self {
            reader: Some(File::from(reader_fd)),
            writer: Some(File::from(writer_fd)),
            child: None,
            attached: true,
            buffer: Vec::new(),
            io_timeout,
            close_timeout: Duration::from_secs(5),
            closed: false,
            stderr_stop: Arc::new(AtomicBool::new(false)),
            stderr_thread: None,
            close_receipt: None,
        })
    }

    pub(crate) fn write_frame(&mut self, payload: &[u8], max_bytes: usize) -> Result<()> {
        if self.closed {
            return Err(Error::disconnected("transport is closed"));
        }
        if payload.is_empty() || payload.len() > max_bytes {
            return Err(Error::limit("frame byte limit exceeded"));
        }
        if payload.iter().any(|b| matches!(b, b'\n' | b'\r')) {
            return Err(Error::protocol("frame contains raw line terminator"));
        }
        let mut bytes = Vec::with_capacity(payload.len() + 1);
        bytes.extend_from_slice(payload);
        bytes.push(b'\n');
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| Error::disconnected("transport writer is closed"))?;
        let deadline = Instant::now() + self.io_timeout;
        let mut at = 0;
        while at < bytes.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::deadline("transport write deadline exceeded"));
            }
            wait_fd(writer.as_raw_fd(), libc::POLLOUT, remaining)?;
            match writer.write(&bytes[at..]) {
                Ok(0) => return Err(Error::disconnected("transport closed during write")),
                Ok(count) => at += count,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(Error::transport(e.to_string())),
            }
        }
        Ok(())
    }

    pub(crate) fn read_frame(&mut self, max_bytes: usize, timeout: Duration) -> Result<Vec<u8>> {
        if self.closed {
            return Err(Error::disconnected("transport is closed"));
        }
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(newline) = self.buffer.iter().position(|b| *b == b'\n') {
                if newline > max_bytes {
                    return Err(Error::limit("frame byte limit exceeded"));
                }
                let mut frame = self.buffer.drain(..=newline).collect::<Vec<_>>();
                frame.pop();
                if frame.is_empty() {
                    return Err(Error::protocol("empty JSONL frame"));
                }
                if frame.contains(&b'\r') {
                    return Err(Error::protocol("raw CR in JSONL frame"));
                }
                return Ok(frame);
            }
            if self.buffer.len() > max_bytes {
                return Err(Error::limit("frame byte limit exceeded"));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::deadline("transport read deadline exceeded"));
            }
            let reader = self
                .reader
                .as_mut()
                .ok_or_else(|| Error::disconnected("transport reader is closed"))?;
            wait_fd(reader.as_raw_fd(), libc::POLLIN | libc::POLLHUP, remaining)?;
            let mut chunk = [0_u8; 8192];
            match reader.read(&mut chunk) {
                Ok(0) if self.buffer.is_empty() => {
                    return Err(Error::disconnected("transport reached EOF"));
                }
                Ok(0) => return Err(Error::protocol("unterminated JSONL frame")),
                Ok(count) => self.buffer.extend_from_slice(&chunk[..count]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(Error::transport(e.to_string())),
            }
        }
    }

    pub(crate) fn close(&mut self) -> ControlCloseReceipt {
        if let Some(receipt) = &self.close_receipt {
            return receipt.clone();
        }
        self.closed = true;
        self.writer.take();
        if self.attached {
            // SAFETY: reader is the remaining descriptor for the connected socket.
            if let Some(reader) = &self.reader {
                unsafe {
                    libc::shutdown(reader.as_raw_fd(), libc::SHUT_RDWR);
                }
            }
            self.reader.take();
            let receipt = ControlCloseReceipt {
                transport_closed: true,
                process_owned: false,
                process_state: ProcessCloseState::NotOwned,
                terminate_requested: false,
                kill_requested: false,
            };
            self.close_receipt = Some(receipt.clone());
            return receipt;
        }
        let Some(mut child) = self.child.take() else {
            self.reader.take();
            self.stderr_stop.store(true, Ordering::Release);
            if let Some(thread) = self.stderr_thread.take() {
                let _ = thread.join();
            }
            let receipt = ControlCloseReceipt {
                transport_closed: true,
                process_owned: true,
                process_state: ProcessCloseState::ReapedUnknown,
                terminate_requested: false,
                kill_requested: false,
            };
            self.close_receipt = Some(receipt.clone());
            return receipt;
        };
        let mut terminate = false;
        let mut kill = false;
        let mut status = wait_child(&mut child, self.close_timeout);
        if status.is_none() {
            terminate = true;
            unsafe {
                libc::kill(i32::try_from(child.id()).unwrap_or(i32::MAX), libc::SIGTERM);
            }
            status = wait_child(&mut child, Duration::from_millis(250));
        }
        if status.is_none() {
            kill = true;
            let _ = child.kill();
            status = wait_child(&mut child, Duration::from_millis(250));
        }
        let process_state = status.map_or_else(
            || {
                thread::spawn(move || {
                    let _ = child.wait();
                });
                ProcessCloseState::Unconfirmed
            },
            |status| {
                use std::os::unix::process::ExitStatusExt;
                status.code().map_or_else(
                    || {
                        status.signal().map_or(
                            ProcessCloseState::ReapedUnknown,
                            ProcessCloseState::Signaled,
                        )
                    },
                    ProcessCloseState::Exited,
                )
            },
        );
        self.reader.take();
        self.stderr_stop.store(true, Ordering::Release);
        if let Some(thread) = self.stderr_thread.take() {
            let _ = thread.join();
        }
        let receipt = ControlCloseReceipt {
            transport_closed: true,
            process_owned: true,
            process_state,
            terminate_requested: terminate,
            kill_requested: kill,
        };
        self.close_receipt = Some(receipt.clone());
        receipt
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.close();
        }
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }
    None
}

fn verify_socket(path: &Path) -> Result<(u64, u64)> {
    let raw = path.as_os_str().as_encoded_bytes();
    if !path.is_absolute() || raw.len() > 107 || raw.contains(&0) || raw.last() == Some(&b'/') {
        return Err(Error::argument(
            "Unix socket path must be canonical, absolute, and at most 107 bytes",
        ));
    }
    if raw
        .split(|b| *b == b'/')
        .enumerate()
        .any(|(index, part)| (index > 0 && part.is_empty()) || matches!(part, b"." | b".."))
    {
        return Err(Error::argument("unsafe Unix socket path component"));
    }
    let components = path.components().collect::<Vec<_>>();
    if components
        .iter()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(Error::argument("unsafe Unix socket path"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::argument("Unix socket requires a private parent directory"))?;
    let mut current = std::path::PathBuf::from("/");
    for part in components.iter().skip(1) {
        current.push(part.as_os_str());
        let metadata = std::fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(Error::argument("Unix socket path contains a symlink"));
        }
    }
    let parent_meta = std::fs::symlink_metadata(parent)?;
    let socket_meta = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if !parent_meta.is_dir() || parent_meta.uid() != uid || parent_meta.mode() & 0o777 != 0o700 {
        return Err(Error::argument(
            "Unix socket parent ownership or mode is invalid",
        ));
    }
    if !socket_meta.file_type().is_socket()
        || socket_meta.uid() != uid
        || socket_meta.mode() & 0o777 != 0o600
    {
        return Err(Error::argument("Unix socket ownership or mode is invalid"));
    }
    Ok((socket_meta.dev(), socket_meta.ino()))
}

fn set_nonblocking(fd: i32) -> Result<()> {
    // SAFETY: fcntl operates on the valid owned descriptor supplied by the caller.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(Error::transport(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{control::ControllerCommand, strict};
    use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};

    fn shell(script: &str) -> ControllerCommand {
        ControllerCommand {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: Some(BTreeMap::new()),
        }
    }
    #[test]
    fn owned_close_is_cached_and_reaped() {
        let mut transport = Transport::launch(
            &shell("exit 0"),
            Duration::from_millis(100),
            Duration::from_secs(1),
            1024,
        )
        .unwrap();
        let first = transport.close();
        let second = transport.close();
        assert_eq!(first, second);
        assert!(
            first.process_owned && first.transport_closed && first.process_shutdown_confirmed()
        );
        assert!(transport.reader.is_none() && transport.writer.is_none());
    }
    #[test]
    fn stalled_owned_writer_obeys_deadline() {
        let mut transport = Transport::launch(
            &shell("sleep 2"),
            Duration::from_millis(30),
            Duration::from_millis(30),
            1024,
        )
        .unwrap();
        let payload = vec![b'x'; strict::CONTROL_FRAME_BYTES];
        let started = Instant::now();
        assert!(
            transport
                .write_frame(&payload, strict::CONTROL_FRAME_BYTES)
                .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        let receipt = transport.close();
        assert!(
            receipt.terminate_requested
                || receipt.kill_requested
                || receipt.process_shutdown_confirmed()
        );
    }
    #[test]
    fn attached_close_releases_fd_and_never_owns_daemon() {
        let (stream, _daemon) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        let reader: OwnedFd = stream.try_clone().unwrap().into();
        let writer: OwnedFd = stream.into();
        let mut transport = Transport {
            reader: Some(File::from(reader)),
            writer: Some(File::from(writer)),
            child: None,
            attached: true,
            buffer: Vec::new(),
            io_timeout: Duration::from_secs(1),
            close_timeout: Duration::from_secs(1),
            closed: false,
            stderr_stop: Arc::new(AtomicBool::new(false)),
            stderr_thread: None,
            close_receipt: None,
        };
        let receipt = transport.close();
        assert_eq!(receipt.process_state, ProcessCloseState::NotOwned);
        assert!(!receipt.process_owned);
        assert!(receipt.process_shutdown_confirmed());
        assert!(transport.reader.is_none() && transport.writer.is_none());
        assert_eq!(transport.close(), receipt);
    }
    #[test]
    fn inconsistent_close_receipts_never_confirm_process_shutdown() {
        for (process_owned, process_state) in [
            (true, ProcessCloseState::NotOwned),
            (true, ProcessCloseState::Unconfirmed),
            (false, ProcessCloseState::Exited(0)),
            (false, ProcessCloseState::Signaled(9)),
            (false, ProcessCloseState::ReapedUnknown),
            (false, ProcessCloseState::Unconfirmed),
        ] {
            let receipt = ControlCloseReceipt {
                transport_closed: true,
                process_owned,
                process_state,
                terminate_requested: false,
                kill_requested: false,
            };
            assert!(!receipt.process_shutdown_confirmed(), "{receipt:?}");
        }
        let incomplete = ControlCloseReceipt {
            transport_closed: false,
            process_owned: true,
            process_state: ProcessCloseState::Exited(0),
            terminate_requested: false,
            kill_requested: false,
        };
        assert!(!incomplete.process_shutdown_confirmed());
    }
    #[test]
    fn filesystem_unix_connect_checks_identity_and_preserves_listener() {
        let directory = unique_temp();
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = directory.join("control.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let accept = thread::spawn(move || {
            let (_first, _) = listener.accept().unwrap();
            let (_second, _) = listener.accept().unwrap();
        });
        let mut first =
            Transport::connect_unix(&socket, Duration::from_secs(1), Duration::from_secs(1))
                .unwrap();
        assert_eq!(first.close().process_state, ProcessCloseState::NotOwned);
        let mut second =
            Transport::connect_unix(&socket, Duration::from_secs(1), Duration::from_secs(1))
                .unwrap();
        assert_eq!(second.close().process_state, ProcessCloseState::NotOwned);
        accept.join().unwrap();
        std::fs::remove_file(&socket).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
    #[test]
    fn rejects_noncanonical_socket_spelling() {
        assert!(verify_socket(Path::new("/tmp//control.sock")).is_err());
        assert!(verify_socket(Path::new("/tmp/./control.sock")).is_err());
        assert!(verify_socket(Path::new("relative.sock")).is_err());
    }
    fn unique_temp() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        std::env::temp_dir().join(format!(
            "mirrorgate-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
