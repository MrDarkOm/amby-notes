//! A minimal MCP server inside Amby, the only "hands" Codex has. It speaks JSON-RPC
//! over HTTP on 127.0.0.1, accepts only the per-turn bearer token and the exact local
//! Host, refuses anything that looks like a browser (Origin), and does nothing but list
//! and call the tools of a `ToolHost`. See docs/ai-codex-provider.md, step 4.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

pub use amby_core::mcp::ToolHost;

pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);

fn handle_rpc(host: &dyn ToolHost, message: &Value) -> Option<Value> {
    amby_core::mcp::handle_rpc(host, message, env!("CARGO_PKG_VERSION"))
}

/// A running server; dropping it does not stop it, `stop` does.
pub struct McpServer {
    pub addr: SocketAddr,
    pub token: String,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

fn new_token() -> String {
    format!("{}{}", ulid::Ulid::generate(), ulid::Ulid::generate()).to_lowercase()
}

/// Compares in time that does not depend on where the first difference is.
fn same_token(given: &str, expected: &str) -> bool {
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

struct Head {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn parse_head(text: &str) -> Option<Head> {
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path, version) = (first.next()?, first.next()?, first.next()?);
    if !version.starts_with("HTTP/1.") || first.next().is_some() {
        return None;
    }
    let headers = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_owned(), value.trim().to_owned()))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Head {
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
    })
}

async fn respond(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
    use tokio::io::AsyncWriteExt;
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let extra = if status == 401 {
        "WWW-Authenticate: Bearer\r\n"
    } else {
        ""
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Reads up to the end of the header block; leftover bytes are the start of the body.
async fn read_head(stream: &mut tokio::net::TcpStream) -> Result<(String, Vec<u8>), u16> {
    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            if end > MAX_HEADER_BYTES {
                return Err(431);
            }
            let rest = buffer.split_off(end + 4);
            buffer.truncate(end);
            let head = String::from_utf8(buffer).map_err(|_| 400u16)?;
            return Ok((head, rest));
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(431);
        }
        let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

async fn serve_connection(
    mut stream: tokio::net::TcpStream,
    host: Arc<dyn ToolHost>,
    token: String,
    addr: SocketAddr,
    read_timeout: Duration,
) {
    use tokio::io::AsyncReadExt;
    let received = tokio::time::timeout(read_timeout, async {
        let (head_text, mut body) = read_head(&mut stream).await?;
        let head = parse_head(&head_text).ok_or(400u16)?;
        if head.header("host") != Some(addr.to_string().as_str()) || head.header("origin").is_some()
        {
            return Err(403);
        }
        let authorised = head
            .header("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|given| same_token(given, &token));
        if !authorised {
            return Err(401);
        }
        if head.path != "/mcp" {
            return Err(404);
        }
        if head.method != "POST" {
            return Err(405);
        }
        if head.header("transfer-encoding").is_some() {
            return Err(411);
        }
        let length: usize = head
            .header("content-length")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        if length > MAX_BODY_BYTES {
            return Err(413);
        }
        while body.len() < length {
            let mut chunk = vec![0u8; (length - body.len()).min(8192)];
            let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
            if read == 0 {
                return Err(400);
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(length);
        serde_json::from_slice::<Value>(&body).map_err(|_| 400u16)
    })
    .await;
    let message = match received {
        Ok(Ok(message)) => message,
        Ok(Err(status)) => return respond(&mut stream, status, "").await,
        Err(_) => return, // too slow: just close
    };
    let reply = tokio::task::spawn_blocking(move || handle_rpc(host.as_ref(), &message))
        .await
        .ok()
        .flatten();
    match reply {
        Some(reply) => respond(&mut stream, 200, &reply.to_string()).await,
        None => respond(&mut stream, 202, "").await,
    }
}

impl McpServer {
    pub async fn start(host: Arc<dyn ToolHost>) -> std::io::Result<McpServer> {
        Self::start_with(host, READ_TIMEOUT).await
    }

    pub async fn start_with(
        host: Arc<dyn ToolHost>,
        read_timeout: Duration,
    ) -> std::io::Result<McpServer> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let token = new_token();
        let (shutdown, mut stop) = tokio::sync::watch::channel(false);
        let served_token = token.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let (host, token, mut stop) = (host.clone(), served_token.clone(), stop.clone());
                        tokio::spawn(async move {
                            tokio::select! {
                                _ = stop.changed() => {}
                                _ = serve_connection(stream, host, token, addr, read_timeout) => {}
                            }
                        });
                    }
                }
            }
        });
        Ok(McpServer {
            addr,
            token,
            shutdown,
            task,
        })
    }

    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests;
