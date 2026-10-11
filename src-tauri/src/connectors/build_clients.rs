//! The app's own OAuth clients a build carries (ADR-0092 and its addendum of
//! 2026-10-10).
//!
//! Google, Microsoft and GitHub sign in with client ids read at compile time
//! (`option_env!`). A build without one does not offer that connector, and
//! nothing at run time can add it back. So this file is compiled twice: into
//! the app, and into `build.rs` through `#[path]`, where it names the
//! connectors a build is about to leave out before anyone ships it. It may
//! therefore use nothing but `std`.

/// One client id the build reads.
pub struct BuildClient {
    /// The build variable `option_env!` reads it from.
    pub var: &'static str,
    /// The connector a build without it does not offer.
    pub connector: &'static str,
    /// The target operating systems where the provider can sign in at all;
    /// empty means every one. Google sends a browser back to an app's own
    /// scheme only for its iOS client type, which also serves the Mac; it
    /// refuses a custom scheme for its Desktop and Android types.
    pub platforms: &'static [&'static str],
}

pub const GOOGLE: BuildClient = BuildClient {
    var: "SUBROSA_GOOGLE_CLIENT_ID",
    connector: "Google",
    platforms: &["macos", "ios"],
};

pub const MICROSOFT: BuildClient = BuildClient {
    var: "SUBROSA_MS_CLIENT_ID",
    connector: "Microsoft",
    platforms: &[],
};

pub const GITHUB: BuildClient = BuildClient {
    var: "SUBROSA_GITHUB_CLIENT_ID",
    connector: "GitHub",
    platforms: &[],
};

pub const CLIENTS: [&BuildClient; 3] = [&GOOGLE, &MICROSOFT, &GITHUB];

/// Overrides where Google sends the browser back; read by `builtin.rs`.
pub const GOOGLE_REDIRECT_VAR: &str = "SUBROSA_GOOGLE_REDIRECT_URI";

/// The suffix of every Google OAuth client id.
const GOOGLE_ID_SUFFIX: &str = ".apps.googleusercontent.com";

impl BuildClient {
    /// Whether a build for `target_os` (Cargo's `CARGO_CFG_TARGET_OS`, or
    /// `std::env::consts::OS` at run time) can offer this provider.
    pub fn applies_to(&self, target_os: &str) -> bool {
        self.platforms.is_empty() || self.platforms.contains(&target_os)
    }
}

/// A build variable that holds something: blank counts as unset.
pub fn configured(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The connectors a build for `target_os` leaves out, given how it reads its
/// variables. A provider that cannot sign in on that platform is not
/// "missing": it is not offered there by design.
pub fn missing(
    target_os: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<&'static BuildClient> {
    CLIENTS
        .into_iter()
        .filter(|client| client.applies_to(target_os))
        .filter(|client| configured(lookup(client.var).as_deref()).is_none())
        .collect()
}

/// Where Google sends the browser back for an iOS-type client: its reversed
/// client id as the scheme, the form Google accepts for that type. `None`
/// for anything that is not a Google client id, which Google would refuse
/// to send back to the app.
pub fn google_redirect_for(client_id: &str) -> Option<String> {
    let prefix = client_id.trim().strip_suffix(GOOGLE_ID_SUFFIX)?;
    let well_formed = !prefix.is_empty()
        && prefix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    well_formed.then(|| format!("com.googleusercontent.apps.{prefix}:/oauth2redirect"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |var| {
            pairs
                .iter()
                .find(|(key, _)| key == var)
                .map(|(_, value)| value.clone())
        }
    }

    fn names(clients: Vec<&BuildClient>) -> Vec<&'static str> {
        clients.into_iter().map(|client| client.connector).collect()
    }

    #[test]
    fn an_empty_build_names_every_connector_it_leaves_out() {
        assert_eq!(
            names(missing("macos", env(&[]))),
            ["Google", "Microsoft", "GitHub"]
        );
        assert_eq!(
            names(missing("ios", env(&[]))),
            ["Google", "Microsoft", "GitHub"]
        );
    }

    #[test]
    fn google_is_not_missing_where_it_cannot_sign_in() {
        assert_eq!(names(missing("windows", env(&[]))), ["Microsoft", "GitHub"]);
        assert_eq!(names(missing("android", env(&[]))), ["Microsoft", "GitHub"]);
        assert!(!GOOGLE.applies_to("linux"));
        assert!(MICROSOFT.applies_to("android"));
    }

    #[test]
    fn a_blank_variable_counts_as_unset() {
        let lookup = env(&[
            (
                "SUBROSA_GOOGLE_CLIENT_ID",
                "123-abc.apps.googleusercontent.com",
            ),
            ("SUBROSA_MS_CLIENT_ID", "   "),
            ("SUBROSA_GITHUB_CLIENT_ID", "Ov23liAbCdEfGhIjKlMn"),
        ]);
        assert_eq!(names(missing("macos", lookup)), ["Microsoft"]);
        assert_eq!(configured(Some("  id  ")), Some("id"));
        assert_eq!(configured(Some("")), None);
        assert_eq!(configured(None), None);
    }

    #[test]
    fn a_full_build_leaves_nothing_out() {
        let lookup = env(&[
            (
                "SUBROSA_GOOGLE_CLIENT_ID",
                "123-abc.apps.googleusercontent.com",
            ),
            (
                "SUBROSA_MS_CLIENT_ID",
                "00000000-0000-0000-0000-000000000000",
            ),
            ("SUBROSA_GITHUB_CLIENT_ID", "Ov23liAbCdEfGhIjKlMn"),
        ]);
        assert!(missing("ios", lookup).is_empty());
    }

    #[test]
    fn google_comes_back_to_its_reversed_client_id() {
        assert_eq!(
            google_redirect_for("1234567890-abc123def.apps.googleusercontent.com").as_deref(),
            Some("com.googleusercontent.apps.1234567890-abc123def:/oauth2redirect")
        );
        assert_eq!(
            google_redirect_for(" 42-x.apps.googleusercontent.com\n").as_deref(),
            Some("com.googleusercontent.apps.42-x:/oauth2redirect")
        );
        assert_eq!(google_redirect_for("not-a-google-id"), None);
        assert_eq!(google_redirect_for(".apps.googleusercontent.com"), None);
        assert_eq!(google_redirect_for("a/b.apps.googleusercontent.com"), None);
    }
}
