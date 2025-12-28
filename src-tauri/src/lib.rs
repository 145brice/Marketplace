use std::process::{Command, Child};
use std::thread;
use std::time::Duration;
use std::sync::Mutex;

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn start_node_server() -> Result<Child, std::io::Error> {
    // Try to find the bundled server.js
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // Try multiple locations for server.js
    let server_js = if exe_dir.join("../Resources/_up_/server.js").exists() {
        // Production macOS bundle: server.js is in Resources/_up_/
        exe_dir.join("../Resources/_up_/server.js")
    } else if exe_dir.join("server.js").exists() {
        // Production bundle: server.js is in the same directory as the executable
        exe_dir.join("server.js")
    } else if exe_dir.join("../../server.js").exists() {
        // Development mode: executable is in src-tauri/target/debug/, server.js is at project root
        exe_dir.join("../../server.js")
    } else {
        // Final fallback
        std::path::PathBuf::from("../server.js")
    };

    // Determine the working directory (where package.json and node_modules are located)
    let work_dir = if exe_dir.join("../Resources/_up_/package.json").exists() {
        // Production macOS bundle: resources are in Resources/_up_/
        exe_dir.join("../Resources/_up_")
    } else if exe_dir.join("../../package.json").exists() {
        // Development mode: project root
        exe_dir.join("../..")
    } else if exe_dir.join("package.json").exists() {
        // Fallback: current directory
        exe_dir.clone()
    } else {
        exe_dir.clone()
    };

    println!("Starting Node.js server from: {:?}", server_js);
    println!("Working directory: {:?}", work_dir);

    // Start the Node.js server
    Command::new("node")
        .arg(server_js)
        .current_dir(work_dir)
        .spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Only auto-start the server in release builds (production)
    // In debug builds, the server is started by beforeDevCommand
    #[cfg(not(debug_assertions))]
    {
        // Start the Node.js server in a separate thread
        thread::spawn(|| {
            match start_node_server() {
                Ok(child) => {
                    println!("Node.js server started successfully");
                    // Store the process handle for cleanup
                    *SERVER_PROCESS.lock().unwrap() = Some(child);
                    // The server will keep running in the background
                }
                Err(e) => {
                    eprintln!("Failed to start Node.js server: {}", e);
                    eprintln!("Make sure Node.js is installed and in your PATH");
                }
            }
        });

        // Give the server a moment to start
        thread::sleep(Duration::from_secs(2));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|_app| {
            println!("Tauri app setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Clean up: kill the server process when the app closes
    if let Some(mut child) = SERVER_PROCESS.lock().unwrap().take() {
        let _ = child.kill();
    }
}
