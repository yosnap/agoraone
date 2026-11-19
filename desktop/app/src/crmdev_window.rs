//! CRMDev's own web in a window of this app (1.7), for «Abrir en CRMDev» on a project, task, ticket or client and for
//! all of CRMDev that AgoraOne shows no native view of. Never in a frame: the user signs in with CRMDev's own login
//! (code by mail or password; passkeys may not work in every system's web view), and AgoraOne's key for CRMDev's API
//! never comes here.
//!
//! The window is the add-on window shared with Central and Mi fábrica (`addon_window.rs`): no native commands, every
//! permission and every download refused, only the origin of the CRMDev address saved in AgoraOne (`remote_origin`:
//! https, or http only on `localhost`, never AgoraOne's own host or ports), links to other sites told to AgoraOne's
//! window, a data store of its own (never the default one, nor Central's or the fábrica's) and closed when the module
//! is turned off or the address changes.

use tauri::AppHandle;

use crate::addon_window::{self, Spec, State, remote_origin};

pub(crate) static CRMDEV: Spec = Spec {
    label: "crmdev",
    title: "CRMDev (AgoraOne)",
    store: [0x37, 0x91, 0xa8, 0x4f, 0xc2, 0xd1, 0x2d, 0x96, 0x76, 0x8a, 0xe6, 0xc2, 0xdb, 0x7e, 0xba, 0xc9],
    origin: remote_origin,
    downloads: None,
    like_main: false,
    state: State::new(),
};

/// While the desktop app runs: the screen's orders to open or close CRMDev's window, as they come.
pub fn crmdev_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    addon_window::run(&CRMDEV, app, link);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::addon_window::allowed;
    use crate::{central_window::CENTRAL, fabrica_window::FABRICA};
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn cada_ventana_tiene_su_almacen_y_su_etiqueta() {
        let specs = [&CENTRAL, &CRMDEV, &FABRICA];
        for (i, a) in specs.iter().enumerate() {
            for b in &specs[i + 1..] {
                assert_ne!(a.store, b.store, "{} y {} no comparten almacén", a.label, b.label);
                assert_ne!(a.label, b.label);
            }
        }
        assert_ne!(CRMDEV.store, [0u8; 16]);
    }

    #[test]
    fn solo_el_origen_guardado_de_crmdev() {
        let saved = (CRMDEV.origin)(&url("https://crm.example.com/es/panel"), &[4317, 4318]);
        assert!(allowed(&url("https://crm.example.com/es/proyectos/x"), saved.as_ref()));
        assert!(!allowed(&url("https://otro-crm.example.com/"), saved.as_ref()), "otro CRMDev no es el guardado");
        assert!((CRMDEV.origin)(&url("http://127.0.0.1:3000/"), &[4317]).is_none(), "nunca el host de AgoraOne");
        assert!(CRMDEV.downloads.is_none(), "sin descargas");
        assert_eq!(CRMDEV.label, "crmdev");
    }
}
