# Tauri calls annotated plugin commands and deserializes arguments by reflection.
-keep class xyz.carpediem.subrosa.nativebridge.SubRosaPlugin { *; }
-keep @app.tauri.annotation.InvokeArg class xyz.carpediem.subrosa.nativebridge.** { *; }
