use std::{
    process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "macos")]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
};

use super::types::{
    SandboxBackendKind, SandboxError, SandboxErrorKind, SandboxExit, SandboxResourceLimits,
    SandboxTerminationReason,
};

pub trait SandboxedProcess {
    fn wait(&mut self) -> Result<SandboxExit, SandboxError>;
    fn terminate_tree(&mut self) -> Result<(), SandboxError>;
    fn native_pid(&self) -> Option<u32>;
}

pub struct SandboxChild {
    child: Child,
    backend: SandboxBackendKind,
    #[cfg(target_os = "windows")]
    job: Option<WindowsJobObject>,
    #[cfg(target_os = "macos")]
    memory_watchdog: Option<MacosMemoryWatchdog>,
}

impl SandboxChild {
    pub fn new(
        mut command: Command,
        backend: SandboxBackendKind,
        limits: SandboxResourceLimits,
    ) -> Result<Self, SandboxError> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|error| {
            SandboxError::new(
                SandboxErrorKind::SpawnFailed,
                format!("failed to spawn sandboxed process: {error}"),
            )
        })?;

        #[cfg(target_os = "windows")]
        {
            let job = WindowsJobObject::create(limits)?;
            if let Err(error) = job.assign_child(&child) {
                let _ = child.kill();
                return Err(error);
            }

            Ok(Self {
                child,
                backend,
                job: Some(job),
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            #[cfg(target_os = "macos")]
            {
                let memory_watchdog =
                    MacosMemoryWatchdog::start(child.id() as i32, limits.memory_bytes);
                return Ok(Self {
                    child,
                    backend,
                    memory_watchdog,
                });
            }

            #[cfg(not(target_os = "macos"))]
            {
                let _ = limits;
                Ok(Self { child, backend })
            }
        }
    }

    pub fn from_spawned_child(child: Child, backend: SandboxBackendKind) -> Self {
        Self {
            child,
            backend,
            #[cfg(target_os = "windows")]
            job: None,
            #[cfg(target_os = "macos")]
            memory_watchdog: None,
        }
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn wait_with_timeout(
        &mut self,
        timeout: Option<Duration>,
    ) -> Result<SandboxExit, SandboxError> {
        let Some(timeout) = timeout else {
            return self.wait();
        };
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| {
                SandboxError::new(
                    SandboxErrorKind::Io,
                    format!("failed to poll sandboxed process: {error}"),
                )
            })? {
                return Ok(self.exit_from_status(status, SandboxTerminationReason::Exit));
            }

            if Instant::now() >= deadline {
                self.terminate_tree()?;
                let status = self.child.wait().map_err(|error| {
                    SandboxError::new(
                        SandboxErrorKind::Timeout,
                        format!("failed to wait after sandbox timeout: {error}"),
                    )
                })?;

                return Ok(self.exit_from_status(status, SandboxTerminationReason::Timeout));
            }

            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn try_wait(&mut self) -> Result<Option<SandboxExit>, SandboxError> {
        self.child
            .try_wait()
            .map(|status| {
                status.map(|status| self.exit_from_status(status, SandboxTerminationReason::Exit))
            })
            .map_err(|error| {
                SandboxError::new(
                    SandboxErrorKind::Io,
                    format!("failed to poll sandboxed process: {error}"),
                )
            })
    }

    pub fn backend(&self) -> SandboxBackendKind {
        self.backend
    }

    fn exit_from_status(
        &mut self,
        status: ExitStatus,
        default_reason: SandboxTerminationReason,
    ) -> SandboxExit {
        let reason = if self.memory_limit_exceeded() {
            SandboxTerminationReason::MemoryLimit
        } else {
            default_reason
        };
        self.stop_memory_watchdog();
        exit_from_status(status, reason)
    }

    #[cfg(target_os = "macos")]
    fn memory_limit_exceeded(&self) -> bool {
        self.memory_watchdog
            .as_ref()
            .is_some_and(MacosMemoryWatchdog::tripped)
    }

    #[cfg(not(target_os = "macos"))]
    fn memory_limit_exceeded(&self) -> bool {
        false
    }

    #[cfg(target_os = "macos")]
    fn stop_memory_watchdog(&mut self) {
        if let Some(watchdog) = self.memory_watchdog.take() {
            watchdog.stop();
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn stop_memory_watchdog(&mut self) {}
}

impl SandboxedProcess for SandboxChild {
    fn wait(&mut self) -> Result<SandboxExit, SandboxError> {
        let status = self.child.wait().map_err(|error| {
            SandboxError::new(
                SandboxErrorKind::Io,
                format!("failed to wait for sandboxed process: {error}"),
            )
        })?;

        Ok(self.exit_from_status(status, SandboxTerminationReason::Exit))
    }

    fn terminate_tree(&mut self) -> Result<(), SandboxError> {
        self.stop_memory_watchdog();

        #[cfg(target_os = "windows")]
        {
            self.terminate_job()
        }

        #[cfg(not(target_os = "windows"))]
        {
            terminate_child_tree(&mut self.child)?;
            Ok(())
        }
    }

    fn native_pid(&self) -> Option<u32> {
        Some(self.child.id())
    }
}

fn exit_from_status(status: ExitStatus, reason: SandboxTerminationReason) -> SandboxExit {
    SandboxExit {
        code: status.code(),
        success: status.success() && reason == SandboxTerminationReason::Exit,
        termination_reason: reason,
    }
}

#[cfg(target_os = "macos")]
fn terminate_child_tree(child: &mut Child) -> Result<(), SandboxError> {
    let pgid = child.id() as i32;
    let result = unsafe { libc::killpg(pgid, libc::SIGTERM) };

    if result != 0 {
        let error = std::io::Error::last_os_error();
        let _ = child.kill();

        return Err(SandboxError::new(
            SandboxErrorKind::Io,
            format!("failed to terminate sandbox process group {pgid}: {error}"),
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
struct MacosMemoryWatchdog {
    stop: Arc<AtomicBool>,
    tripped: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
impl MacosMemoryWatchdog {
    fn start(process_group_id: i32, memory_limit_bytes: u64) -> Option<Self> {
        if memory_limit_bytes == 0 {
            return None;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let tripped = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_tripped = tripped.clone();
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                if let Ok(bytes) = process_group_rss_bytes(process_group_id) {
                    if bytes > memory_limit_bytes {
                        thread_tripped.store(true, Ordering::Relaxed);
                        terminate_process_group_for_memory_limit(process_group_id);
                        break;
                    }
                }

                sleep_interruptibly(&thread_stop, Duration::from_millis(250));
            }
        });

        Some(Self {
            stop,
            tripped,
            handle: Some(handle),
        })
    }

    fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }

    fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosMemoryWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(target_os = "macos")]
fn process_group_rss_bytes(process_group_id: i32) -> std::io::Result<u64> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pgid=,rss="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;

    Ok(parse_process_group_rss_bytes(
        &String::from_utf8_lossy(&output.stdout),
        process_group_id,
    ))
}

fn parse_process_group_rss_bytes(ps_output: &str, process_group_id: i32) -> u64 {
    ps_output
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let pgid = columns.next()?.parse::<i32>().ok()?;
            let rss_kib = columns.next()?.parse::<u64>().ok()?;

            if pgid == process_group_id {
                Some(rss_kib.saturating_mul(1024))
            } else {
                None
            }
        })
        .sum()
}

#[cfg(target_os = "macos")]
fn terminate_process_group_for_memory_limit(process_group_id: i32) {
    unsafe {
        libc::killpg(process_group_id, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(500));
    unsafe {
        libc::killpg(process_group_id, libc::SIGKILL);
    }
}

#[cfg(target_os = "macos")]
fn sleep_interruptibly(stop: &AtomicBool, duration: Duration) {
    let mut slept = Duration::ZERO;

    while slept < duration && !stop.load(Ordering::Relaxed) {
        let step = Duration::from_millis(50).min(duration - slept);
        thread::sleep(step);
        slept += step;
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn terminate_child_tree(child: &mut Child) -> Result<(), SandboxError> {
    child.kill().map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::Io,
            format!("failed to terminate sandboxed process: {error}"),
        )
    })
}

#[cfg(target_os = "windows")]
fn terminate_child_tree(child: &mut Child) -> Result<(), SandboxError> {
    child.kill().map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::Io,
            format!("failed to terminate sandboxed process: {error}"),
        )
    })
}

#[cfg(target_os = "windows")]
struct WindowsJobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsJobObject {}

#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsJobObject {}

#[cfg(target_os = "windows")]
impl WindowsJobObject {
    fn create(limits: SandboxResourceLimits) -> Result<Self, SandboxError> {
        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };

        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(SandboxError::unavailable(format!(
                "failed to create Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.BasicLimitInformation.ActiveProcessLimit = limits.active_process_limit;
        info.JobMemoryLimit = limits.memory_bytes as usize;

        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if ok == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }

            return Err(SandboxError::unavailable(format!(
                "failed to configure Windows Job Object: {error}"
            )));
        }

        Ok(Self { handle })
    }

    fn assign_child(&self, child: &Child) -> Result<(), SandboxError> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let process_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let ok = unsafe { AssignProcessToJobObject(self.handle, process_handle) };

        if ok == 0 {
            return Err(SandboxError::unavailable(format!(
                "failed to assign process to Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        Ok(())
    }

    fn terminate(&self) -> Result<(), SandboxError> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        let ok = unsafe { TerminateJobObject(self.handle, 1) };

        if ok == 0 {
            return Err(SandboxError::new(
                SandboxErrorKind::Io,
                format!(
                    "failed to terminate Windows Job Object: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }

        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl SandboxedProcess for WindowsJobObject {
    fn wait(&mut self) -> Result<SandboxExit, SandboxError> {
        unreachable!("WindowsJobObject is managed by SandboxChild")
    }

    fn terminate_tree(&mut self) -> Result<(), SandboxError> {
        self.terminate()
    }

    fn native_pid(&self) -> Option<u32> {
        None
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(target_os = "windows")]
impl SandboxChild {
    pub fn terminate_job(&mut self) -> Result<(), SandboxError> {
        if let Some(job) = &self.job {
            job.terminate()?;
            return Ok(());
        }

        self.child.kill().map_err(|error| {
            SandboxError::new(
                SandboxErrorKind::Io,
                format!("failed to terminate sandboxed process: {error}"),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_process_group_rss_from_ps_output() {
        let output = "\
          10   512
          42  1024
          42  2048
          xx  4096
        ";

        assert_eq!(parse_process_group_rss_bytes(output, 42), 3 * 1024 * 1024);
        assert_eq!(parse_process_group_rss_bytes(output, 7), 0);
    }
}
