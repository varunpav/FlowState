//! Seconds since the last keyboard/mouse input, session-local (per MSDN: not
//! visible across other sessions, e.g. a locked/switched-user session reads as
//! permanently idle — which is the behavior we want for a hydration reminder).

#[cfg(target_os = "windows")]
pub fn idle_seconds() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            // GetTickCount and dwTime are both 32-bit millisecond ticks that wrap
            // every ~49.7 days; wrapping_sub is required so a wrap doesn't underflow.
            (GetTickCount().wrapping_sub(info.dwTime) / 1000) as u64
        } else {
            0
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn idle_seconds() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn tick_count_wraparound_does_not_underflow() {
        // GetTickCount just wrapped past zero; dwTime was recorded 901ms before
        // the wrap. A plain `-` would underflow; wrapping_sub must still yield
        // the correct small elapsed time.
        let tick_count_now: u32 = 100;
        let last_input_time: u32 = u32::MAX - 900;
        let idle_ms = tick_count_now.wrapping_sub(last_input_time);
        assert_eq!(idle_ms, 1001);
    }
}
