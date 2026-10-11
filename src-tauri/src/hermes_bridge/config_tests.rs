use super::*;

#[test]
fn render_hermes_config_roundtrips_windows_paths() {
    // Keep Windows paths literal so this regression is caught on every OS.
    // Include escapes that YAML would either reject (\U) or silently decode
    // (\n, \t), plus spaces and Unicode from real profile names.
    for root in [
        r"C:\Users\Renée Test\AppData\Roaming\xyz.carpediem.subrosa",
        r"\\server\notes\team space",
    ] {
        for memory_enabled in [true, false] {
            let command = format!(r"{root}\hermes\venv\Scripts\python.exe");
            let coordinates_path = PathBuf::from(format!(r"{root}\hermes-mcp\june_web_proxy.json"));
            let context = JuneContextMcpConfig {
                command: command.clone(),
                script_path: PathBuf::from(format!(r"{root}\hermes-mcp\june_context_mcp.py")),
                database_path: PathBuf::from(format!(r"{root}\notes.sqlite3")),
                coordinates_path: coordinates_path.clone(),
                memory_enabled,
            };
            let web = JuneWebMcpConfig {
                command: command.clone(),
                script_path: PathBuf::from(format!(r"{root}\hermes-mcp\june_web_mcp.py")),
                coordinates_path: coordinates_path.clone(),
            };
            let media = JuneMediaMcpConfig {
                command: command.clone(),
                script_path: PathBuf::from(format!(r"{root}\hermes-mcp\june_media_mcp.py")),
                coordinates_path: coordinates_path.clone(),
            };
            let studio = JuneStudioMcpConfig {
                command: command.clone(),
                script_path: PathBuf::from(format!(r"{root}\hermes-mcp\june_studio_mcp.py")),
                coordinates_path: coordinates_path.clone(),
            };
            let skill_dir = format!(r"{root}\skills\team");
            let rendered = render_hermes_config(
                "test-model",
                "http://127.0.0.1:4242/v1",
                "test-token",
                &CRON_SANDBOXED_TOOLSETS.join(", "),
                &[PathBuf::from(&skill_dir)],
                Some(true),
                Some(&context),
                Some(&web),
                Some(&media),
                Some(&studio),
            );
            let parsed: serde_json::Value =
                serde_yaml::from_str(&rendered).expect("generated config must be valid YAML");
            assert_eq!(parsed["model"]["provider"], "custom");
            assert_eq!(parsed["model"]["default"], "test-model");
            assert_eq!(parsed["model"]["base_url"], "http://127.0.0.1:4242/v1");
            assert_eq!(parsed["model"]["api_key"], "test-token");
            assert_eq!(
                parsed["skills"]["external_dirs"],
                serde_json::json!([skill_dir])
            );

            let servers = &parsed["mcp_servers"];
            let mut context_args = vec![
                context.script_path.to_string_lossy().into_owned(),
                context.database_path.to_string_lossy().into_owned(),
            ];
            if !memory_enabled {
                context_args.push("--memory=off".to_string());
            }
            context_args.push(format!("--proxy={}", coordinates_path.to_string_lossy()));
            assert_eq!(servers["june_context"]["command"], command);
            assert_eq!(
                servers["june_context"]["args"],
                serde_json::json!(context_args)
            );
            for (name, script) in [
                ("june_web", &web.script_path),
                ("june_media", &media.script_path),
                ("june_studio", &studio.script_path),
            ] {
                assert_eq!(servers[name]["command"], command);
                assert_eq!(
                    servers[name]["args"],
                    serde_json::json!([
                        script.to_string_lossy(),
                        coordinates_path.to_string_lossy()
                    ])
                );
            }
        }
    }
}

/// The runtime's own browser tools fail inside the jail and the agent tried
/// them before the app's browser (QA 1.89.1 row 10): the config switches
/// the `browser` toolset off for every chat, whatever the vision lines say,
/// keeps the rest of the `agent:` block, and keeps the app's browser server.
#[test]
fn render_hermes_config_switches_the_runtime_browser_off() {
    let studio = JuneStudioMcpConfig {
        command: "/venv/bin/python3".to_string(),
        script_path: PathBuf::from("/data/hermes-mcp/june_studio_mcp.py"),
        coordinates_path: PathBuf::from("/data/hermes-mcp/june_web_proxy.json"),
    };
    for vision in [Some(true), Some(false), None] {
        let rendered = render_hermes_config(
            "glm",
            "http://127.0.0.1:9/v1",
            "tok",
            &CRON_SANDBOXED_TOOLSETS.join(", "),
            &[],
            vision,
            None,
            None,
            None,
            Some(&studio),
        );
        let parsed: serde_json::Value =
            serde_yaml::from_str(&rendered).expect("generated config must be valid YAML");
        assert_eq!(
            parsed["agent"]["disabled_toolsets"],
            serde_json::json!(["browser"])
        );
        assert_eq!(parsed["agent"]["max_turns"], 200);
        assert_eq!(
            parsed["agent"]["image_input_mode"].as_str(),
            (vision == Some(true)).then_some("native")
        );
        assert!(parsed["mcp_servers"]["june_browser"]["command"].is_string());
    }
}
