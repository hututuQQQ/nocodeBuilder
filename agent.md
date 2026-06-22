# Agent Notes

- When the user asks to package or build a distributable app, keep executable outputs only in the Tauri release output directories, such as `src-tauri/target/release/` and `src-tauri/target/release/bundle/`. Do not copy generated `.exe` files into the repository root or other ad hoc locations.
