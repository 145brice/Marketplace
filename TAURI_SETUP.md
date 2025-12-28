# Tauri Desktop App Setup

## What is Tauri?
Tauri allows you to build desktop applications from your web app. Your Marketplace Finder can now run as a native macOS, Windows, or Linux application.

## Prerequisites Installed ✓
- Node.js and npm
- Rust toolchain
- Tauri CLI

## Project Structure
```
Marketplace/
├── server.js           # Your Node.js backend
├── package.json        # npm configuration with Tauri scripts
└── src-tauri/          # Tauri configuration
    ├── Cargo.toml      # Rust dependencies
    ├── tauri.conf.json # Tauri app configuration
    └── src/
        ├── main.rs     # Rust entry point
        └── lib.rs      # Tauri library code
```

## Available Commands

### Development Mode
Run the app in development mode (with hot reload):
```bash
npm run tauri:dev
```

This will:
1. Start your Node.js server on port 8020
2. Launch a desktop window with your Marketplace Finder UI
3. Enable hot reload - changes to server.js will require restart, but Tauri will reconnect automatically

### Build for Production
Create a distributable desktop app:
```bash
npm run tauri:build
```

This creates platform-specific installers in `src-tauri/target/release/bundle/`:
- **macOS**: `.app` bundle and `.dmg` installer
- **Windows**: `.exe` and `.msi` installer
- **Linux**: `.deb` and `.AppImage`

### Regular Web Server (No Desktop App)
To run just the web server without Tauri:
```bash
npm start
```
Then visit http://localhost:8020 in your browser

## Configuration

### App Settings
Edit `src-tauri/tauri.conf.json` to customize:
- **productName**: Application name
- **identifier**: Bundle identifier (com.marketplace.finder)
- **window settings**: Size, title, resizable, etc.

### Adding Icons
To add custom icons for your desktop app:

1. Create a 1024x1024 PNG icon and save it as `app-icon.png` in the project root
2. Run the icon generator:
```bash
npx tauri icon app-icon.png
```

This will generate all required icon sizes and formats automatically.

## How It Works

When you run `npm run tauri:dev`:
1. Tauri starts your Node.js server (via the `beforeDevCommand` in tauri.conf.json)
2. Waits for the server to be ready on http://localhost:8020
3. Opens a native desktop window that loads your web UI
4. The window acts like a browser, but it's a native app with access to system APIs

## Benefits of Tauri

✅ **Native Performance**: Runs as a real desktop app, not in a browser
✅ **Small File Size**: ~3-5MB instead of 100+MB like Electron
✅ **System Integration**: Can access files, notifications, system tray
✅ **Cross-Platform**: One codebase for macOS, Windows, Linux
✅ **Secure**: Sandboxed execution with permission controls
✅ **No Browser Required**: Users don't need to open a browser

## Next Steps

1. **Test Development Mode**:
   ```bash
   npm run tauri:dev
   ```

2. **Customize Window**: Edit window size/settings in `src-tauri/tauri.conf.json`

3. **Add Icons**: Create and generate app icons (see above)

4. **Build Release**: When ready, create a distributable app:
   ```bash
   npm run tauri:build
   ```

5. **Distribute**: Share the installer from `src-tauri/target/release/bundle/`

## Troubleshooting

**Error: "Node server not responding"**
- Make sure port 8020 is not already in use
- Check that `npm start` works independently

**Build Errors**
- Ensure Rust is up to date: `rustup update`
- Clear build cache: `cd src-tauri && cargo clean`

**Icon Errors**
- Icons are optional for development
- To fix: either generate icons or set `"icon": []` in tauri.conf.json

## Resources
- [Tauri Documentation](https://tauri.app)
- [Tauri API Reference](https://tauri.app/reference/)
- [Rust Documentation](https://doc.rust-lang.org/)
