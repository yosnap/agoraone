//! YouTube in a hidden window (1.7): the videos whose owners do not allow the embed (most record labels) play in a
//! window of this app that is never shown, with YouTube's own page. AgoraOne's screen leaves its orders in the core and
//! this collects them by asking and waiting; how the video goes is read from the window every second and handed to
//! AgoraOne's window as an event. The YouTube window has no native commands (the app grants none to any window), is
//! refused the microphone, camera and every other permission, keeps nothing between launches (private data store),
//! only goes to YouTube's pages, opens no other window and downloads nothing. Stopping leaves it on an empty page (never destroyed while
//! orders may follow), and it goes blank too whenever AgoraOne's window loads again, so it never plays unseen.

use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "youtube";
const SCRIPT: &str = include_str!("youtube-window.js");
/// The last state handed over, so the same one is not sent every second; emptied with each new order.
static LAST: Mutex<String> = Mutex::new(String::new());

/// Only YouTube's own pages (and its cookie consent) load in the hidden window, besides the empty page.
fn youtube_page(url: &Url) -> bool {
    url.as_str() == "about:blank"
        || url.scheme() == "https"
            && matches!(url.host_str(), Some("www.youtube.com" | "youtube.com" | "m.youtube.com" | "consent.youtube.com"))
}

fn forget() {
    LAST.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Silence: the hidden window goes to the empty page (AgoraOne's window loading again, or «stop»).
pub fn silence(app: &AppHandle) {
    forget();
    if let (Some(window), Ok(blank)) = (app.get_webview_window(LABEL), Url::parse("about:blank")) {
        let _ = window.navigate(blank);
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What the page says, reduced to known fields of bounded size before it reaches AgoraOne's window.
fn clean(raw: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = value.get("id")?.as_str()?;
    let state = value.get("state")?.as_str()?;
    if !(id.is_empty() || valid_id(id)) || !matches!(state, "consent" | "loading" | "playing" | "paused" | "ended" | "error") {
        return None;
    }
    let number = |key: &str| value.get(key).and_then(|n| n.as_f64()).filter(|n| n.is_finite() && *n >= 0.0 && *n < 1e6).unwrap_or(0.0);
    let title: String = value.get("title").and_then(|t| t.as_str()).unwrap_or("").chars().filter(|c| !c.is_control()).take(200).collect();
    Some(serde_json::json!({
        "id": id, "state": state, "t": number("t"), "d": number("d"), "title": title,
        "ad": value.get("ad").and_then(|a| a.as_bool()).unwrap_or(false), "volume": number("volume").min(100.0),
    }))
}

/// Hands the window's state to AgoraOne's window (a JSON literal: data, never code).
fn tell(app: &AppHandle, state: &serde_json::Value) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('agora:youtube', {{ detail: {state} }}))"));
    }
}

/// The hidden window never downloads: a download started from a page would go unseen, so every one is refused.
fn allow_download(_event: &DownloadEvent) -> bool {
    false
}

fn open(app: &AppHandle, url: Url) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("YouTube (AgoraOne)")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .incognito(true)
        .inner_size(960.0, 600.0)
        .initialization_script(SCRIPT)
        .on_navigation(youtube_page)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, event| allow_download(&event))
        .build()
}

fn apply(app: &AppHandle, command: &serde_json::Value) {
    let action = command.get("action").and_then(|a| a.as_str()).unwrap_or("");
    let window = app.get_webview_window(LABEL);
    match action {
        "play" => {
            let Some(id) = command.get("id").and_then(|i| i.as_str()).filter(|i| valid_id(i)) else { return };
            let Ok(url) = Url::parse(&format!("https://www.youtube.com/watch?v={id}")) else { return };
            forget();
            let played = match window {
                Some(window) => window.navigate(url).is_ok(),
                None => open(app, url).is_ok(),
            };
            if !played {
                tell(app, &serde_json::json!({ "id": id, "state": "error", "t": 0, "d": 0, "title": "", "ad": false, "volume": 100 }));
            }
        }
        "stop" => {
            silence(app);
            tell(app, &serde_json::json!({ "id": "", "state": "stopped", "t": 0, "d": 0, "title": "", "ad": false, "volume": 100 }));
        }
        "pause" | "resume" => {
            if let Some(window) = window {
                let _ = window.eval(format!("window.__agora && window.__agora.{action}()"));
            }
        }
        "volume" => {
            let level = command.get("volume").and_then(|v| v.as_u64()).unwrap_or(100).min(100);
            if let Some(window) = window {
                let _ = window.eval(format!("window.__agora && window.__agora.volume({level})"));
            }
        }
        "seek" => {
            let seconds = command.get("seconds").and_then(|s| s.as_f64()).filter(|s| s.is_finite() && *s >= 0.0).unwrap_or(0.0);
            if let Some(window) = window {
                let _ = window.eval(format!("window.__agora && window.__agora.seek({seconds})"));
            }
        }
        _ => {}
    }
}

/// While the desktop app runs: the screen's orders, as they come, and every second how the video goes.
pub fn youtube_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    let orders = app.clone();
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::new();
        let mut seen: i64 = -1;
        loop {
            let path = format!("/internal/youtube/hidden/next?after={seen}");
            let Ok(answer) = agora_server::core::core_request(&http, &link, &path, None).await else {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            };
            // A core that started again counts from zero: follow its count.
            seen = answer.get("seq").and_then(|s| s.as_i64()).unwrap_or(seen);
            for command in answer.get("commands").and_then(|c| c.as_array()).into_iter().flatten() {
                let (app, command) = (orders.clone(), command.clone());
                let _ = orders.run_on_main_thread(move || apply(&app, &command));
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let Some(window) = app.get_webview_window(LABEL) else { continue };
            let app = app.clone();
            let _ = window.eval_with_callback("window.__agora ? window.__agora.state() : null", move |raw| {
                let Some(state) = clean(&raw) else { return };
                let text = state.to_string();
                let mut previous = LAST.lock().unwrap_or_else(|p| p.into_inner());
                if *previous != text {
                    *previous = text;
                    tell(&app, &state);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_paginas_de_youtube() {
        assert!(youtube_page(&Url::parse("https://www.youtube.com/watch?v=5g2hT4GmAGU").unwrap()));
        assert!(youtube_page(&Url::parse("https://consent.youtube.com/m?continue=x").unwrap()));
        assert!(youtube_page(&Url::parse("about:blank").unwrap()));
        assert!(!youtube_page(&Url::parse("about:srcdoc").unwrap()));
        assert!(!youtube_page(&Url::parse("http://www.youtube.com/").unwrap()));
        assert!(!youtube_page(&Url::parse("https://evil.example/youtube.com").unwrap()));
        assert!(!youtube_page(&Url::parse("http://127.0.0.1:4318/").unwrap()));
    }

    #[test]
    fn no_descarga_nada() {
        let mut destination = std::path::PathBuf::from("descarga.bin");
        let url = Url::parse("https://www.youtube.com/archivo.bin").unwrap();
        assert!(!allow_download(&DownloadEvent::Requested { url: url.clone(), destination: &mut destination }));
        assert!(!allow_download(&DownloadEvent::Finished { url, path: None, success: true }));
    }

    #[test]
    fn el_estado_se_limpia() {
        let state = clean(r#"{"id":"5g2hT4GmAGU","state":"playing","t":12,"d":200,"title":"Despechá\u0000</script>","ad":false,"volume":80,"extra":"x"}"#).unwrap();
        assert_eq!(state["title"], "Despechá</script>");
        assert!(state.get("extra").is_none());
        assert!(clean(r#"{"id":"');alert(1)//","state":"playing"}"#).is_none());
        assert!(clean(r#"{"id":"5g2hT4GmAGU","state":"hack"}"#).is_none());
        assert!(clean("null").is_none());
        // The literal handed to AgoraOne's window is JSON: a title cannot close the string.
        assert!(state.to_string().contains(r#""Despechá</script>""#));
    }
}
