//! Disposable loopback provider for the native IPC contract, never in production.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

pub fn start() -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = respond(stream);
            });
        }
    });
    Ok(format!("http://{address}"))
}

fn respond(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk)?;
        if count == 0 || request.len() + count > 1024 * 1024 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..count]);
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    if length > 1024 * 1024 {
        return Ok(());
    }
    while request.len() < header_end + length {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..count]);
    }
    let body: Value = match serde_json::from_slice(&request[header_end..header_end + length]) {
        Ok(body) => body,
        Err(_) => return Ok(()),
    };
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let results: Vec<&Value> = messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    let message = match results.len() {
        0 => {
            json!({"content":"", "tool_calls":[{"function":{"name":"search_notes","arguments":{"query":"mercury","limit":10}}}]})
        }
        1 => {
            let result: Value =
                serde_json::from_str(results[0]["content"].as_str().unwrap_or("{}"))
                    .unwrap_or_default();
            match result["notes"][0]["id"].as_str() {
                Some(id) if results[0]["tool_name"] == "search_notes" => {
                    json!({"content":"", "tool_calls":[{"function":{"name":"read_note","arguments":{"id":id}}}]})
                }
                _ => json!({"content":"search failed"}),
            }
        }
        _ => {
            let result: Value =
                serde_json::from_str(results[1]["content"].as_str().unwrap_or("{}"))
                    .unwrap_or_default();
            if results[1]["tool_name"] == "read_note"
                && result["content"]
                    .as_str()
                    .is_some_and(|value| value.contains("mercury"))
                && result["citation"] == 1
            {
                json!({"content":"Found mercury [1]."})
            } else {
                json!({"content":"read failed"})
            }
        }
    };
    let payload = format!(
        "{}\n{}\n",
        json!({"message":message,"done":false}),
        json!({"message":{"content":""},"done":true})
    );
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", payload.len(), payload)?;
    Ok(())
}
