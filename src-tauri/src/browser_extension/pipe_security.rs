//! Who may open the app's named pipe on Windows (ADR-0100).
//!
//! A named pipe created with default security takes the creator's default
//! DACL, which on some systems lets other accounts on the machine (and
//! `Everyone` under some policies) connect. The Unix socket is owner-only
//! and checks the peer's uid; the pipe gets the same rule as an explicit
//! DACL: full access for the user the app runs as, nobody else, nothing
//! inherited. The descriptor is written in SDDL from the user's SID, so the
//! rule is a string a test can read.

/// The security descriptor, in SDDL, for a pipe only `user_sid` may open:
/// a protected DACL (`P`, no inherited entries) with one entry granting
/// generic all (`GA`) to that SID. `None` for anything that is not a SID,
/// so a malformed value never becomes a looser rule.
pub fn pipe_sddl(user_sid: &str) -> Option<String> {
    is_sid(user_sid).then(|| format!("D:P(A;;GA;;;{user_sid})"))
}

/// `S-1-<authority>-<sub>...`, digits only between the dashes.
fn is_sid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("S-1-") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(windows)]
pub use platform::SecurityAttributes;

#[cfg(windows)]
mod platform {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn failed(context: &str, error: windows::core::Error) -> std::io::Error {
        std::io::Error::other(format!("{context}: {error}"))
    }

    /// The string SID of the user this process runs as.
    pub fn current_user_sid() -> std::io::Result<String> {
        // SAFETY: each call is given buffers it owns for the duration of the
        // call; the token handle and the string SID are released below.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|error| failed("OpenProcessToken", error))?;
            let mut needed = 0_u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut buffer = vec![0_u8; needed as usize];
            let read = GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                needed,
                &mut needed,
            );
            let _ = CloseHandle(token);
            read.map_err(|error| failed("GetTokenInformation", error))?;
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text)
                .map_err(|error| failed("ConvertSidToStringSidW", error))?;
            let sid = text.to_string();
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            sid.map_err(|error| std::io::Error::other(error.to_string()))
        }
    }

    /// `SECURITY_ATTRIBUTES` holding the pipe's descriptor, freed on drop.
    pub struct SecurityAttributes {
        attributes: SECURITY_ATTRIBUTES,
        descriptor: PSECURITY_DESCRIPTOR,
    }

    impl SecurityAttributes {
        /// For a pipe only the current user may open.
        pub fn current_user_only() -> std::io::Result<Self> {
            let sid = current_user_sid()?;
            let sddl = super::pipe_sddl(&sid).ok_or_else(|| {
                std::io::Error::other("the current user's SID is not one a DACL can name")
            })?;
            let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            // SAFETY: `wide` is NUL-terminated and outlives the call; the
            // descriptor it allocates is released in `Drop`.
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(wide.as_ptr()),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    None,
                )
                .map_err(|error| {
                    failed(
                        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                        error,
                    )
                })?;
            }
            Ok(Self {
                attributes: SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor.0,
                    bInheritHandle: false.into(),
                },
                descriptor,
            })
        }

        /// What `ServerOptions::create_with_security_attributes_raw` takes.
        /// Valid while `self` lives.
        pub fn as_mut_ptr(&mut self) -> *mut std::ffi::c_void {
            std::ptr::addr_of_mut!(self.attributes).cast()
        }
    }

    // SAFETY: the descriptor is a heap block this value alone owns (it is
    // never shared, and freed once in `Drop`); moving it to another thread
    // moves that ownership, as for any `Box`.
    unsafe impl Send for SecurityAttributes {}

    impl Drop for SecurityAttributes {
        fn drop(&mut self) {
            // SAFETY: allocated by the conversion above, freed once.
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_user_is_granted_anything() {
        assert_eq!(
            pipe_sddl("S-1-5-21-3623811015-3361044348-30300820-1013").as_deref(),
            Some("D:P(A;;GA;;;S-1-5-21-3623811015-3361044348-30300820-1013)")
        );
        // Nothing else is ever written into the rule.
        for bad in [
            "",
            "S-1-",
            "S-1-5-21-x",
            "WD",
            "S-1-5-21-1)(A;;GA;;;WD",
            "s-1-5-18",
            "S-1-5--18",
        ] {
            assert_eq!(pipe_sddl(bad), None, "{bad}");
        }
    }
}
