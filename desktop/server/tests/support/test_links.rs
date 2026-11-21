//! Links for tests only: the integration tests include this file with `#[path]` and the crate's unit tests through
//! `crate::test_links` (compiled only under `cfg(test)`), so it never ships in the server.
//!
//! On macOS and Linux it is a plain symbolic link. On Windows a symbolic link needs Developer Mode or
//! administrator rights; without them the link is an NTFS junction, which leads outside just the same and is what
//! the code under test must refuse. Junctions only point at folders, so a link to a file points at its folder.
#![allow(dead_code)]

use std::io;
use std::path::Path;

/// Creates `link` pointing at `target`.
pub fn create_test_link(target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    let (target, link) = (target.as_ref(), link.as_ref());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        let made = if target.is_dir() { std::os::windows::fs::symlink_dir(target, link) } else { std::os::windows::fs::symlink_file(target, link) };
        match made {
            Err(error) if error.raw_os_error() == Some(1314) => {
                // ERROR_PRIVILEGE_NOT_HELD: no right to create symbolic links.
                // A target that does not exist here (a Unix path such as /etc/hosts): any folder outside will do.
                let folder = if target.is_dir() { target.to_path_buf() } else { target.parent().filter(|p| p.is_dir()).map_or_else(std::env::temp_dir, Path::to_path_buf) };
                junction(&std::fs::canonicalize(folder)?, link)
            }
            other => other,
        }
    }
}

/// Removes a link made by `create_test_link` (a junction is removed as a folder; what it points at is untouched).
pub fn remove_test_link(link: impl AsRef<Path>) -> io::Result<()> {
    let link = link.as_ref();
    std::fs::remove_file(link).or_else(|_| std::fs::remove_dir(link))
}

/// Makes `link` an NTFS junction to the folder `target` (an absolute, canonical path): an empty folder whose
/// mount-point reparse data names the target, set with FSCTL_SET_REPARSE_POINT.
#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    // «\\?\C:\x» from canonicalize becomes the NT name «\??\C:\x»; the print name is the plain «C:\x».
    let plain = target.to_string_lossy();
    let plain = plain.strip_prefix(r"\\?\").unwrap_or(&plain).to_string();
    let wide = |text: &str| std::ffi::OsStr::new(text).encode_wide().collect::<Vec<u16>>();
    let (substitute, print) = (wide(&format!(r"\??\{plain}")), wide(&plain));
    let bytes = |units: &[u16]| u16::try_from(units.len() * 2).map_err(|_| io::Error::other("ruta demasiado larga"));
    let (substitute_len, print_len) = (bytes(&substitute)?, bytes(&print)?);
    // Both names end in a NUL that the lengths leave out.
    let path_bytes = substitute_len + 2 + print_len + 2;
    let mut buffer = Vec::<u8>::with_capacity(16 + usize::from(path_bytes));
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend_from_slice(&(8 + path_bytes).to_le_bytes()); // ReparseDataLength: the four offsets + names
    buffer.extend_from_slice(&0u16.to_le_bytes()); // Reserved
    for field in [0, substitute_len, substitute_len + 2, print_len] {
        buffer.extend_from_slice(&field.to_le_bytes()); // SubstituteName offset/length, PrintName offset/length
    }
    for unit in substitute.iter().chain([&0]).chain(print.iter()).chain([&0]) {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }

    std::fs::create_dir(link)?;
    let set = (|| {
        let folder = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(link)?;
        let mut returned = 0u32;
        let ok = unsafe {
            windows_sys::Win32::System::IO::DeviceIoControl(
                folder.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                u32::try_from(buffer.len()).map_err(io::Error::other)?,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    })();
    if set.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    set
}
