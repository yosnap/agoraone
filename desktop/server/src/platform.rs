//! Operating-system boundary for filesystem safety (no-follow handles, file identity, hard-link counts,
//! permissions), subprocess groups / Windows Job Objects, termination signals and standard user folders.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
#[cfg(windows)]
use std::path::Prefix;
use std::path::{Component, Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, UNIX_EPOCH};

use tokio::process::{Child, Command};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileId(pub u64, pub u64);

#[derive(Clone, Copy, Debug)]
pub struct FileInfo {
    pub is_file: bool,
    pub nlink: u64,
    pub len: u64,
    pub id: FileId,
}

/// Drops Windows `\\?\` verbatim prefixes on drive and UNC paths so canonical paths match plain user paths.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            match prefix.kind() {
                Prefix::VerbatimDisk(drive) => {
                    let mut out = PathBuf::from(format!("{}:\\", char::from(drive)));
                    out.extend(components.filter(|c| !matches!(c, Component::RootDir)));
                    return out;
                }
                Prefix::VerbatimUNC(server, share) => {
                    let mut out = PathBuf::from(r"\\");
                    out.push(server);
                    out.push(share);
                    out.extend(components.filter(|c| !matches!(c, Component::RootDir)));
                    return out;
                }
                _ => {}
            }
        }
    }
    path
}

/// Canonical path on disk without Windows `\\?\` verbatim decoration.
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(strip_verbatim)
}

/// True when `path` resolves to itself without traversing symlinks or NTFS junctions.
pub fn is_same_real_path(path: &Path) -> io::Result<bool> {
    let real = canonicalize(path)?;
    let expected = normalize(path);
    #[cfg(windows)]
    {
        Ok(real.as_os_str().eq_ignore_ascii_case(expected.as_os_str()))
    }
    #[cfg(not(windows))]
    {
        Ok(real == expected)
    }
}

/// Lexical path resolution preserving Windows drive prefixes as well as rooted paths.
pub fn normalize(path: &Path) -> PathBuf {
    let rooted = path.is_absolute() || path.has_root();
    let raw = if rooted {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let clean = strip_verbatim(raw);
    let mut out = PathBuf::new();
    let mut has_prefix = false;
    for part in clean.components() {
        match part {
            Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
                has_prefix = true;
            }
            Component::RootDir => {
                if has_prefix {
                    out.push(std::path::MAIN_SEPARATOR_STR);
                } else {
                    out.push("/");
                }
            }
            Component::ParentDir => {
                out.pop();
                if out.as_os_str().is_empty() && !has_prefix {
                    out.push("/");
                }
            }
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        out
    }
}

/// `HOME`, or on Windows (where it is usually unset) `USERPROFILE`.
pub fn home_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|v| !v.is_empty());
    #[cfg(windows)]
    let home = home.or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()));
    home.map(PathBuf::from)
}

pub fn default_system_path() -> String {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        format!(r"{root}\System32;{root}")
    }
    #[cfg(not(windows))]
    {
        "/usr/bin:/bin".into()
    }
}

/// Essential OS variables a cleared subprocess environment still needs on Windows to load system DLLs.
pub fn apply_minimal_os_env(command: &mut Command) {
    #[cfg(windows)]
    {
        for name in ["SystemRoot", "TEMP", "TMP", "PATHEXT", "ComSpec"] {
            if let Ok(value) = std::env::var(name)
                && !value.is_empty()
            {
                command.env(name, value);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// A relative path written with `/`, as on macOS: Windows' `\` separators are turned into `/`, while on
/// macOS and Linux a `\` is part of a file name and stays.
pub fn slash_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { text.replace('\\', "/") } else { text.into_owned() }
}

pub fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| (d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6).round() as i64)
        .unwrap_or(0)
}

pub fn dir_entry_is_link(entry: &fs::DirEntry) -> bool {
    let Ok(kind) = entry.file_type() else { return true };
    if kind.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        entry.metadata().map(|m| (m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0).unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn is_real_dir(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if (meta.file_attributes() & 0x0400) != 0 {
            return false;
        }
    }
    meta.is_dir() && is_same_real_path(path).unwrap_or(false)
}

pub fn create_dir_mode(path: &Path, recursive: bool, mode: u32) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    builder.create(path)
}

pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

pub fn create_mode_file(path: &Path, create_new: bool, truncate: bool, mode: u32) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true);
    if create_new {
        opts.create_new(true);
    } else {
        opts.create(true).truncate(truncate);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    opts.open(path)
}

#[cfg(unix)]
pub fn open_nofollow_read(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
}

#[cfg(windows)]
pub fn open_nofollow_read(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    if !inspect_handle(&file)?.is_file {
        return Err(io::Error::other("Reparse point or non-regular file"));
    }
    Ok(file)
}

#[cfg(unix)]
pub fn open_nofollow_rw(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW).open(path)
}

#[cfg(windows)]
pub fn open_nofollow_rw(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    if !inspect_handle(&file)?.is_file {
        return Err(io::Error::other("Reparse point or non-regular file"));
    }
    Ok(file)
}

#[cfg(unix)]
pub fn create_new_nofollow(path: &Path, mode: u32) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(mode).open(path)
}

#[cfg(windows)]
pub fn create_new_nofollow(path: &Path, _mode: u32) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = OpenOptions::new().write(true).create_new(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    if !inspect_handle(&file)?.is_file {
        let _ = fs::remove_file(path);
        return Err(io::Error::other("Reparse point"));
    }
    Ok(file)
}

#[cfg(unix)]
pub fn inspect_handle(file: &File) -> io::Result<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileInfo { is_file: meta.is_file(), nlink: meta.nlink(), len: meta.len(), id: FileId(meta.dev(), meta.ino()) })
}

#[cfg(windows)]
pub fn inspect_handle(file: &File) -> io::Result<FileInfo> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let is_file = (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
    let len = ((info.nFileSizeHigh as u64) << 32) | (info.nFileSizeLow as u64);
    let index = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);
    Ok(FileInfo { is_file, nlink: info.nNumberOfLinks as u64, len, id: FileId(info.dwVolumeSerialNumber as u64, index) })
}

#[cfg(unix)]
pub fn inspect_path_nofollow(path: &Path) -> io::Result<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path)?;
    Ok(FileInfo { is_file: meta.is_file(), nlink: meta.nlink(), len: meta.len(), id: FileId(meta.dev(), meta.ino()) })
}

#[cfg(windows)]
pub fn inspect_path_nofollow(path: &Path) -> io::Result<FileInfo> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
    let file = OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    inspect_handle(&file)
}

#[cfg_attr(unix, allow(unused_mut))]
pub fn write_all_at(file: &File, mut data: &[u8], mut offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(data, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        while !data.is_empty() {
            let written = file.seek_write(data, offset)?;
            if written == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "failed to write whole buffer"));
            }
            data = &data[written..];
            offset += written as u64;
        }
        Ok(())
    }
}

pub fn open_url(url: &str) -> io::Result<ExitStatus> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open").arg(url).status()
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).status()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).status()
    }
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (mut interrupt, mut terminate, mut hangup) = (
            signal(SignalKind::interrupt()).expect("señal"),
            signal(SignalKind::terminate()).expect("señal"),
            signal(SignalKind::hangup()).expect("señal"),
        );
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
            _ = hangup.recv() => {}
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub fn process_alive(pid: i64) -> bool {
    if pid <= 1 || pid > i32::MAX as i64 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
        if handle.is_null() {
            return unsafe { GetLastError() == ERROR_ACCESS_DENIED };
        }
        let mut code: u32 = 0;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
        unsafe { CloseHandle(handle) };
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

pub async fn stop_child(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        }
        if tokio::time::timeout(grace, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
    #[cfg(windows)]
    {
        let _ = grace;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

pub fn configure_group(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(unix)]
#[derive(Clone)]
pub struct ProcessGroup {
    pid: Option<u32>,
}

#[cfg(unix)]
impl ProcessGroup {
    pub fn attach(child: &Child) -> Self {
        Self { pid: child.id() }
    }

    pub fn terminate(&self) {
        if let Some(pid) = self.pid {
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
        }
    }

    pub fn kill(&self) {
        if let Some(pid) = self.pid {
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        }
    }

    pub fn reap(&self) {
        let Some(pid) = self.pid else { return };
        let group = -(pid as libc::pid_t);
        if unsafe { libc::kill(group, 0) } != 0 {
            return;
        }
        unsafe { libc::kill(group, libc::SIGTERM) };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if unsafe { libc::kill(group, 0) } == 0 {
                unsafe { libc::kill(group, libc::SIGKILL) };
            }
        });
    }
}

#[cfg(windows)]
struct JobHandle(*mut std::ffi::c_void);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
#[derive(Clone)]
pub struct ProcessGroup {
    job: Option<std::sync::Arc<JobHandle>>,
}

#[cfg(windows)]
impl ProcessGroup {
    pub fn attach(child: &Child) -> Self {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        let Some(pid) = child.id() else { return Self { job: None } };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Self { job: None };
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(job) };
            return Self { job: None };
        }
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            unsafe { CloseHandle(job) };
            return Self { job: None };
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        unsafe { CloseHandle(process) };
        if assigned == 0 {
            unsafe { CloseHandle(job) };
            return Self { job: None };
        }
        Self { job: Some(std::sync::Arc::new(JobHandle(job))) }
    }

    pub fn terminate(&self) {
        self.kill();
    }

    pub fn kill(&self) {
        if let Some(job) = &self.job {
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job.0, 1) };
        }
    }

    pub fn reap(&self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_preserves_drive_and_rooted_paths() {
        #[cfg(windows)]
        {
            assert_eq!(normalize(Path::new(r"\\?\E:\Desarrollo\foo\..\agoraone")), PathBuf::from(r"E:\Desarrollo\agoraone"));
            assert_eq!(strip_verbatim(PathBuf::from(r"\\?\UNC\servidor\recurso\carpeta")), PathBuf::from(r"\\servidor\recurso\carpeta"));
        }
        assert_eq!(normalize(Path::new("/otro/a/../b")), PathBuf::from("/otro/b"));
    }

    #[test]
    fn nofollow_and_real_dir_reject_links_and_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonicalize(dir.path()).unwrap();
        let (outside, file) = (base.join("fuera"), base.join("nota.txt"));
        fs::create_dir(&outside).unwrap();
        fs::write(&file, "secreto").unwrap();
        assert!(is_real_dir(&outside));
        assert_eq!(inspect_path_nofollow(&file).unwrap().nlink, 1);

        let hard = base.join("copia-dura.txt");
        fs::hard_link(&file, &hard).unwrap();
        assert_eq!(inspect_path_nofollow(&file).unwrap().nlink, 2);

        let linked_dir = base.join("carpeta-enlazada");
        crate::test_links::create_test_link(&outside, &linked_dir).unwrap();
        assert!(!is_real_dir(&linked_dir));
        assert!(open_nofollow_read(&linked_dir).is_err());
        assert!(open_nofollow_rw(&linked_dir).is_err());
    }
}
