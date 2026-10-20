//! The tmux.newSession verb must start tmux without scoutd's instance env:
//! a tmux server keeps its starter's env as every later pane's global env.
//! Runs the real `scoutd probes serve` as a separate process (so its env can
//! carry instance keys without mutating this test process's env).

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("scoutd-tmux-env-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn tmux_new_session_verb_strips_instance_env_from_the_tmux_process() {
    let dir = temp_dir();
    let env_file = dir.join("tmux-env.txt");
    let fake_tmux = dir.join("tmux");
    fs::write(
        &fake_tmux,
        format!("#!/bin/sh\nenv > '{}'\nexit 0\n", env_file.display()),
    )
    .unwrap();
    fs::set_permissions(&fake_tmux, fs::Permissions::from_mode(0o755)).unwrap();
    let socket = dir.join("probes.sock");

    let mut server = Command::new(env!("CARGO_BIN_EXE_scoutd"))
        .args(["probes", "serve"])
        .env("HOME", &dir)
        .env("OPENSCOUT_HOME", dir.join("home"))
        .env("OPENSCOUT_SUPPORT_DIRECTORY", dir.join("support"))
        .env("OPENSCOUT_CONTROL_HOME", dir.join("control"))
        .env("OPENSCOUT_PROBES_SOCKET", &socket)
        .env("OPENSCOUT_TMUX_BIN", &fake_tmux)
        // The service env scoutd itself carries.
        .env("OPENSCOUT_INSTANCE", "prod")
        .env("OPENSCOUT_BROKER_PORT", "43110")
        .env("OPENSCOUT_CLIENT_INSTANCE", "dev-leak-test")
        .env("OPENSCOUT_SERVICE_LABEL", "app.openscout")
        .env("SCOUT_KEEP_ME", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("scoutd probes serve starts");

    let mut connected = None;
    for _ in 0..200 {
        if let Ok(stream) = UnixStream::connect(&socket) {
            connected = Some(stream);
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let mut stream = connected.expect("probe socket comes up");
    stream
        .write_all(br#"{"schema":"openscout.exec.request/v1","verb":"tmux.newSession","args":{"sessionName":"scout-env","detached":true,"command":"sh","timeoutMs":2000}}"#)
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let _ = server.kill();
    let _ = server.wait();

    assert!(response.contains("\"ok\":true"), "response: {response}");
    let tmux_env = fs::read_to_string(&env_file).expect("fake tmux ran");
    for key in [
        "OPENSCOUT_INSTANCE=",
        "OPENSCOUT_BROKER_PORT=",
        "OPENSCOUT_CLIENT_INSTANCE=",
        "OPENSCOUT_SERVICE_LABEL=",
        "OPENSCOUT_HOME=",
        "OPENSCOUT_SUPPORT_DIRECTORY=",
        "OPENSCOUT_CONTROL_HOME=",
    ] {
        assert!(
            !tmux_env.lines().any(|line| line.starts_with(key)),
            "{key} leaked into tmux"
        );
    }
    assert!(tmux_env.lines().any(|line| line == "SCOUT_KEEP_ME=1"));
    let _ = fs::remove_dir_all(dir);
}
