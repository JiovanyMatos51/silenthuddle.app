#[cfg(target_os = "android")]
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.silenthuddle.mobile";

#[cfg(target_os = "android")]
pub struct CallService<R: Runtime> {
    handle: PluginHandle<R>,
}

#[cfg(target_os = "android")]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("call-service")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CallServicePlugin")?;
            app.manage(CallService { handle });
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn set_android_call_service<R: Runtime>(
    app: AppHandle<R>,
    active: bool,
    camera_active: bool,
) -> Result<(), String> {
    app.state::<CallService<R>>()
        .handle
        .run_mobile_plugin::<()>(
            "setActive",
            serde_json::json!({ "active": active, "cameraActive": camera_active }),
        )
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn set_android_call_service(active: bool, camera_active: bool) -> Result<(), String> {
    let _ = (active, camera_active);
    Ok(())
}
