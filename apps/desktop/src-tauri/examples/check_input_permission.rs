//! Prints the live input-injection permission status on this machine, and (if
//! granted) performs one harmless synthetic mouse move to prove real
//! injection works end-to-end. Used to verify graceful permission handling
//! without needing the full GUI app.

use lilypad_desktop_lib::input::{create_input_backend, MouseAction, PermissionStatus};

fn main() {
    let mut backend = create_input_backend();
    let _ = backend.initialize();
    match backend.permission_status() {
        PermissionStatus::Granted => println!("permission: GRANTED"),
        PermissionStatus::NotGranted => println!("permission: NOT GRANTED"),
        PermissionStatus::NotApplicable => {
            println!("permission: NOT APPLICABLE (this OS doesn't gate injection)")
        }
    }

    match backend.inject_mouse(MouseAction::Move { x: 0.5, y: 0.5 }) {
        Ok(()) => println!("inject_mouse: OK (cursor moved to center of main display)"),
        Err(e) => println!("inject_mouse: REJECTED ({e})"),
    }
}
