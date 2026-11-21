//! Starting a process inside its Job Object with no gap: it is created suspended, put in the job and only then
//! resumed. Assigning it after it starts would leave a moment in which whatever it launches first (uv starting
//! Python, Python starting an MCP server) is outside the job and would outlive it.

use std::io;

use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next};
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

use super::ProcessGroup;

/// Spawns `command` (without a console window) inside a new Job Object that closes with the returned group.
pub(crate) fn spawn_suspended_in_job(command: &mut Command) -> io::Result<(Child, ProcessGroup)> {
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    let group = ProcessGroup::attach(&child);
    // Resumed even if it could not join the job: it then runs as it did before, just without one.
    if let Err(error) = child.id().ok_or_else(|| io::Error::other("sin proceso")).and_then(resume) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok((child, group))
}

/// Resumes the threads of a process created suspended (just its first one).
fn resume(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..unsafe { std::mem::zeroed() } };
    let mut resumed = 0;
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                if unsafe { ResumeThread(thread) } != u32::MAX {
                    resumed += 1;
                }
                unsafe { CloseHandle(thread) };
            }
        }
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if resumed == 0 { Err(io::Error::other("no se pudo reanudar el proceso")) } else { Ok(()) }
}
