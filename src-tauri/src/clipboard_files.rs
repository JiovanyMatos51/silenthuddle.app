//! Windows Explorer copies files as CF_HDROP, which WebView2 does not always
//! expose as DOM File objects. Read only those explicitly pasted files and
//! retain open handles so large attachments can be sent in bounded chunks.
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;

struct Source {
    owner: String,
    file: File,
    size: u64,
}

#[derive(Default)]
pub struct ClipboardFileStore(Mutex<HashMap<String, Source>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    source_id: String,
    name: String,
    size: u64,
    preview_path: String,
}

static NEXT_SOURCE: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn read_clipboard_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClipboardFileStore>,
    owner: String,
) -> Result<Vec<ClipboardFile>, String> {
    if owner.len() != 36 {
        return Err("Sessão inválida".into());
    }
    let paths = clipboard_paths()?;
    let mut sources = state.0.lock().map_err(|_| "Falha ao acessar anexos")?;
    if sources.len() + paths.len() > 256 {
        return Err("Limite de anexos da sessão atingido".into());
    }
    let mut result = Vec::new();
    for path in paths {
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| error.to_string())?;
        let source_id = format!("clipboard-{}", NEXT_SOURCE.fetch_add(1, Ordering::Relaxed));
        result.push(ClipboardFile {
            source_id: source_id.clone(),
            name: name.to_string(),
            size: metadata.len(),
            preview_path: path.to_string_lossy().into_owned(),
        });
        sources.insert(
            source_id,
            Source {
                owner: owner.clone(),
                file,
                size: metadata.len(),
            },
        );
    }
    Ok(result)
}

#[tauri::command]
pub fn read_clipboard_file_chunk(
    state: tauri::State<'_, ClipboardFileStore>,
    source_id: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    if length > 64 * 1024 {
        return Err("Bloco de arquivo muito grande".into());
    }
    let mut sources = state.0.lock().map_err(|_| "Falha ao acessar anexos")?;
    let source = sources.get_mut(&source_id).ok_or("Anexo expirado")?;
    if offset > source.size {
        return Err("Posição inválida no anexo".into());
    }
    let count = (source.size - offset).min(length as u64) as usize;
    let mut bytes = vec![0; count];
    source
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    source
        .file
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

#[tauri::command]
pub fn clear_clipboard_files(state: tauri::State<'_, ClipboardFileStore>, owner: String) {
    if let Ok(mut sources) = state.0.lock() {
        sources.retain(|_, source| source.owner != owner);
    }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_paths() -> Result<Vec<PathBuf>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn clipboard_paths() -> Result<Vec<PathBuf>, String> {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt};
    #[link(name = "user32")]
    extern "system" {
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn OpenClipboard(window: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(drop: *mut c_void, index: u32, buffer: *mut u16, count: u32) -> u32;
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    const CF_HDROP: u32 = 15;
    // The clipboard handle is owned by Windows and is only valid while open.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Área de transferência ocupada".into());
        }
        let _guard = ClipboardGuard;
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() {
            return Ok(Vec::new());
        }
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        if count > 64 {
            return Err("Cole no máximo 64 arquivos por vez".into());
        }
        let mut paths = Vec::new();
        for index in 0..count {
            let length = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            if length == 0 || length > 32_767 {
                continue;
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), buffer.len() as u32);
            if copied == 0 {
                continue;
            }
            buffer.truncate(copied as usize);
            paths.push(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
        }
        Ok(paths)
    }
}
