//! Windows' counterpart of a private Unix mode (0o700, 0o600): a protected DACL whose only entry gives the current
//! user full control. "Protected" drops the entries inherited from the parent folder (Users, Authenticated
//! Users…), so nobody else on the machine can read the data folder or the access token. On a folder the entry is
//! inherited by what is created inside, as a 0o700 folder keeps its contents out of reach.

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE};
use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
use windows_sys::Win32::Security::{
    ACL, ACL_REVISION, AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetLengthSid, GetTokenInformation,
    InitializeAcl, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// The current user's SID, as the TOKEN_USER buffer that holds it (the SID points inside the buffer).
pub(crate) struct CurrentUser {
    buffer: Vec<u64>, // u64 keeps the TOKEN_USER aligned
}

impl CurrentUser {
    pub(crate) fn get() -> io::Result<Self> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut needed = 0u32;
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
            if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { buffer })
        })();
        unsafe { CloseHandle(token) };
        result
    }

    pub(crate) fn sid(&self) -> *mut c_void {
        unsafe { (*self.buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

/// Replaces the DACL of `path` with one entry: full control for the current user, inherited by the folder's
/// contents when `path` is a folder.
pub(crate) fn restrict_to_owner(path: &Path) -> io::Result<()> {
    let user = CurrentUser::get()?;
    let sid = user.sid();
    // ACL header + one ACCESS_ALLOWED_ACE (header + mask, then the SID in place of SidStart), rounded to 4.
    let size = (8 + 8 + unsafe { GetLengthSid(sid) } as usize).next_multiple_of(4);
    let mut acl = vec![0u32; size / 4];
    let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
    let size = u32::try_from(size).map_err(io::Error::other)?;
    if unsafe { InitializeAcl(acl_ptr, size, ACL_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let inherit = if path.is_dir() { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 };
    if unsafe { AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, inherit, FILE_ALL_ACCESS, sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl_ptr,
            std::ptr::null(),
        )
    };
    if status != 0 { Err(io::Error::from_raw_os_error(status as i32)) } else { Ok(()) }
}

/// For the tests: whether every entry of the DACL of `path` (its own and the inherited ones) is for the current
/// user, so nobody else is let in.
#[cfg(test)]
pub(crate) fn is_owner_only(path: &Path) -> io::Result<bool> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, EqualSid, GetAce};

    let user = CurrentUser::get()?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let (mut dacl, mut descriptor): (*mut ACL, *mut c_void) = (std::ptr::null_mut(), std::ptr::null_mut());
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let answer = (|| {
        if dacl.is_null() {
            return false; // a null DACL lets everybody in
        }
        let count = unsafe { (*dacl).AceCount };
        count > 0
            && (0..u32::from(count)).all(|index| {
                let mut ace: *mut c_void = std::ptr::null_mut();
                let found = unsafe { GetAce(dacl, index, &mut ace) } != 0;
                // The SID starts where ACCESS_ALLOWED_ACE.SidStart is.
                found && unsafe { EqualSid((&raw mut (*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast(), user.sid()) } != 0
            })
    })();
    unsafe { LocalFree(descriptor) };
    Ok(answer)
}
