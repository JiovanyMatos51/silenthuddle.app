use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

mod call_service;
mod clipboard_files;

const SETTINGS_FILE: &str = "settings.json";
const INCOMING_DIRECTORY: &str = "incoming-files";

struct IncomingFile {
    path: PathBuf,
    name: String,
    expected_size: u64,
    written: u64,
}

#[derive(Default)]
struct IncomingFileStore(Mutex<HashMap<String, IncomingFile>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFileResult {
    path: String,
    name: String,
    size: u64,
}

#[tauri::command]
fn load_app_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_app_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(directory.join(SETTINGS_FILE), contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn cleanup_temp_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, IncomingFileStore>,
) -> Result<(), String> {
    let directory = incoming_directory(&app)?;
    state
        .0
        .lock()
        .map_err(|_| "Falha ao acessar arquivos temporários".to_string())?
        .clear();
    if directory.exists() {
        fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
fn prepare_incoming_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, IncomingFileStore>,
    file_id: String,
    file_name: String,
    size: u64,
) -> Result<(), String> {
    validate_file_id(&file_id)?;
    let directory = incoming_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let safe_name = sanitize_file_name(&file_name);
    let path = directory.join(format!("{file_id}-{safe_name}"));
    fs::File::create(&path).map_err(|error| error.to_string())?;
    state
        .0
        .lock()
        .map_err(|_| "Falha ao acessar arquivos temporários".to_string())?
        .insert(
            file_id,
            IncomingFile {
                path,
                name: safe_name,
                expected_size: size,
                written: 0,
            },
        );
    Ok(())
}

#[tauri::command]
fn append_incoming_file_chunk(
    state: tauri::State<'_, IncomingFileStore>,
    file_id: String,
    base64_data: String,
) -> Result<(), String> {
    let bytes = BASE64
        .decode(base64_data.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut files = state
        .0
        .lock()
        .map_err(|_| "Falha ao acessar arquivos temporários".to_string())?;
    let incoming = files
        .get_mut(&file_id)
        .ok_or_else(|| "Arquivo temporário não foi preparado".to_string())?;
    let next_size = incoming.written.saturating_add(bytes.len() as u64);
    if next_size > incoming.expected_size {
        return Err("O arquivo recebido excede o tamanho anunciado".to_string());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(&incoming.path)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    incoming.written = next_size;
    Ok(())
}

#[tauri::command]
fn finalize_incoming_file(
    state: tauri::State<'_, IncomingFileStore>,
    file_id: String,
) -> Result<StoredFileResult, String> {
    let mut files = state
        .0
        .lock()
        .map_err(|_| "Falha ao acessar arquivos temporários".to_string())?;
    let incoming = files
        .remove(&file_id)
        .ok_or_else(|| "Arquivo temporário não encontrado".to_string())?;
    if incoming.written != incoming.expected_size {
        let _ = fs::remove_file(&incoming.path);
        return Err(format!(
            "Arquivo incompleto: esperado {} bytes, recebido {}",
            incoming.expected_size, incoming.written
        ));
    }
    Ok(StoredFileResult {
        path: incoming.path.to_string_lossy().into_owned(),
        name: incoming.name,
        size: incoming.written,
    })
}

#[tauri::command]
fn save_received_file(
    app: tauri::AppHandle,
    source_path: String,
    file_name: String,
) -> Result<String, String> {
    let incoming = incoming_directory(&app)?;
    let allowed_directory = fs::canonicalize(incoming).map_err(|error| error.to_string())?;
    let source = fs::canonicalize(source_path).map_err(|error| error.to_string())?;
    if !source.starts_with(&allowed_directory) || !source.is_file() {
        return Err("Caminho de arquivo não autorizado".to_string());
    }

    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let destination = available_download_path(&downloads, &sanitize_file_name(&file_name));
    fs::copy(source, &destination).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().into_owned())
}

fn incoming_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(INCOMING_DIRECTORY))
}

fn validate_file_id(file_id: &str) -> Result<(), String> {
    if file_id.is_empty()
        || file_id.len() > 64
        || !file_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Identificador de arquivo inválido".to_string());
    }
    Ok(())
}

fn sanitize_file_name(file_name: &str) -> String {
    let base_name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let sanitized: String = base_name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

fn available_download_path(directory: &Path, file_name: &str) -> PathBuf {
    let initial = directory.join(file_name);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let candidate_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-download"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(target_os = "android")]
    let builder = builder.plugin(call_service::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(IncomingFileStore::default())
        .manage(clipboard_files::ClipboardFileStore::default())
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            cleanup_temp_files,
            prepare_incoming_file,
            append_incoming_file_chunk,
            finalize_incoming_file,
            save_received_file,
            clipboard_files::read_clipboard_files,
            clipboard_files::read_clipboard_file_chunk,
            clipboard_files::clear_clipboard_files,
            call_service::set_android_call_service
        ])
        .run(tauri::generate_context!())
        .expect("error while running SilentHuddle");
}
