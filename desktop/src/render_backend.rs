//! WebKitGTK render backend selection.
//!
//! WebKitGTK resolves its compositing path from the process environment while
//! GTK initializes, so a launcher that exports nothing gets whatever WebKit's
//! heuristics pick. That heuristic is wrong on NVIDIA: the proprietary and the
//! open-kernel module both break the GBM/dmabuf path, and the failure looks
//! like a blank or flickering view rather than an error. Selecting the backend
//! here, before any webview exists, keeps the decision inside the application.

use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Session {
    Wayland,
    X11,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Choice {
    Dmabuf,
    Fallback,
    Software,
}

pub(crate) struct Observed {
    pub session: Session,
    pub nvidia: bool,
    pub request: Option<String>,
    pub dmabuf_env: Option<String>,
}

/// The caller's own `WEBKIT_DISABLE_DMABUF_RENDERER`.
const DMABUF_RENDERER_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// Compositing on top of whichever renderer remains.
const COMPOSITING_MODE_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
/// Explicit operator choice, for the machine where the heuristic is wrong.
const BACKEND_REQUEST_ENV: &str = "NEUXIE_RENDER_BACKEND";

static CURRENT: OnceLock<Choice> = OnceLock::new();

/// First match wins. A pre-set `WEBKIT_DISABLE_DMABUF_RENDERER` is the
/// launcher's decision and is never reinterpreted through `request`.
pub(crate) fn choose(observed: &Observed) -> Choice {
    if let Some(value) = observed.dmabuf_env.as_deref() {
        return if value.is_empty() || value == "0" {
            Choice::Dmabuf
        } else {
            Choice::Fallback
        };
    }
    match normalized_request(observed).as_deref() {
        Some("dmabuf") => return Choice::Dmabuf,
        Some("fallback") => return Choice::Fallback,
        Some("software") => return Choice::Software,
        _ => {}
    }
    // Vendor, not session: NVIDIA breaks the dmabuf path under both X11 and
    // Wayland, so the compositor in use cannot rescue it.
    if observed.nvidia {
        Choice::Fallback
    } else {
        Choice::Dmabuf
    }
}

/// Observes the real process, sets the render environment, and reports the
/// decision in one line. Must run before `tauri::generate_context!()`, because
/// the web process inherits the environment GTK started with.
pub(crate) fn apply() -> Choice {
    let observed = observe();
    let choice = choose(&observed);
    let explicit_environment = observed.dmabuf_env.is_some();
    match choice {
        Choice::Fallback => std::env::set_var(DMABUF_RENDERER_ENV, "1"),
        Choice::Software => {
            std::env::set_var(DMABUF_RENDERER_ENV, "1");
            std::env::set_var(COMPOSITING_MODE_ENV, "1");
        }
        Choice::Dmabuf => {
            if !explicit_environment {
                std::env::remove_var(DMABUF_RENDERER_ENV);
            }
        }
    }
    // A stale export would silently disable hardware compositing on a machine
    // that never asked for software rendering.
    if !explicit_environment && choice != Choice::Software {
        std::env::remove_var(COMPOSITING_MODE_ENV);
    }
    let _ = CURRENT.set(choice);
    crate::write_diagnostic(format_args!(
        "render: backend={choice:?} session={:?} nvidia={} reason={}",
        observed.session,
        observed.nvidia,
        reason(&observed)
    ));
    choice
}

pub(crate) fn current() -> Choice {
    CURRENT.get().copied().unwrap_or(Choice::Dmabuf)
}

fn observe() -> Observed {
    Observed {
        session: session(),
        nvidia: nvidia_present(),
        request: std::env::var(BACKEND_REQUEST_ENV).ok(),
        dmabuf_env: std::env::var_os(DMABUF_RENDERER_ENV)
            .map(|value| value.to_string_lossy().into_owned()),
    }
}

fn normalized_request(observed: &Observed) -> Option<String> {
    observed
        .request
        .as_deref()
        .map(|request| request.trim().to_lowercase())
}

fn reason(observed: &Observed) -> &'static str {
    if observed.dmabuf_env.is_some() {
        return "environment";
    }
    match normalized_request(observed).as_deref() {
        Some("dmabuf" | "fallback" | "software") => "request",
        _ if observed.nvidia => "nvidia",
        _ => "default",
    }
}

fn session() -> Session {
    if let Ok(backend) = std::env::var("GDK_BACKEND") {
        if backend.contains("x11") {
            return Session::X11;
        }
    }
    match std::env::var("WAYLAND_DISPLAY") {
        Ok(display) if !display.is_empty() => Session::Wayland,
        _ => Session::X11,
    }
}

fn nvidia_present() -> bool {
    Path::new("/proc/driver/nvidia/version").exists()
        || Path::new("/sys/module/nvidia/version").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(
        session: Session,
        nvidia: bool,
        request: Option<&str>,
        dmabuf_env: Option<&str>,
    ) -> Observed {
        Observed {
            session,
            nvidia,
            request: request.map(str::to_owned),
            dmabuf_env: dmabuf_env.map(str::to_owned),
        }
    }

    #[test]
    fn nvidia_on_wayland_falls_back() {
        assert_eq!(
            choose(&observed(Session::Wayland, true, None, None)),
            Choice::Fallback
        );
    }

    #[test]
    fn nvidia_on_x11_falls_back() {
        assert_eq!(
            choose(&observed(Session::X11, true, None, None)),
            Choice::Fallback
        );
    }

    #[test]
    fn other_vendor_on_wayland_keeps_dmabuf() {
        assert_eq!(
            choose(&observed(Session::Wayland, false, None, None)),
            Choice::Dmabuf
        );
    }

    #[test]
    fn other_vendor_on_x11_keeps_dmabuf() {
        assert_eq!(
            choose(&observed(Session::X11, false, None, None)),
            Choice::Dmabuf
        );
    }

    #[test]
    fn request_selects_each_backend() {
        for (request, expected) in [
            ("dmabuf", Choice::Dmabuf),
            ("fallback", Choice::Fallback),
            ("software", Choice::Software),
        ] {
            assert_eq!(
                choose(&observed(Session::Wayland, true, Some(request), None)),
                expected,
                "{request}"
            );
        }
    }

    #[test]
    fn request_is_case_and_space_insensitive() {
        assert_eq!(
            choose(&observed(Session::X11, false, Some("AUTO"), None)),
            Choice::Dmabuf,
            "auto falls through to the vendor rule"
        );
        assert_eq!(
            choose(&observed(Session::X11, true, Some(" Software "), None)),
            Choice::Software
        );
    }

    #[test]
    fn unknown_request_falls_through_to_vendor() {
        assert_eq!(
            choose(&observed(Session::Wayland, true, Some("vulkan"), None)),
            Choice::Fallback
        );
        assert_eq!(
            choose(&observed(Session::Wayland, false, Some("vulkan"), None)),
            Choice::Dmabuf
        );
    }

    #[test]
    fn enabled_dmabuf_environment_wins() {
        assert_eq!(
            choose(&observed(Session::X11, true, Some("fallback"), Some("0"))),
            Choice::Dmabuf
        );
    }

    #[test]
    fn disabled_dmabuf_environment_wins_over_request() {
        assert_eq!(
            choose(&observed(Session::X11, false, Some("dmabuf"), Some("1"))),
            Choice::Fallback
        );
    }

    #[test]
    fn empty_dmabuf_environment_counts_as_enabled() {
        assert_eq!(
            choose(&observed(Session::Wayland, true, None, Some(""))),
            Choice::Dmabuf
        );
    }
}
