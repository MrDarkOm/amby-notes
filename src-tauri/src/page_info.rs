//! The title and the description of a web page, fetched once when the person presses
//! "fetch the title" on a bookmark. Everything here is about not trusting the address, the
//! network or the page:
//!
//! * only `http` and `https`, one request per press, no cookies, no credentials, a neutral
//!   `User-Agent`, no proxy;
//! * never a computer's own address or a local network: the name is resolved here, every
//!   address it resolves to must be a public one, and the connection is made to exactly
//!   the address that was checked. The check is repeated for every redirect, of which
//!   there are at most [`MAX_REDIRECTS`];
//! * ten seconds in all, the first [`MAX_BODY_BYTES`] of the answer at most, and only
//!   `text/html`;
//! * the answer is never run or shown as it is: the title and the description are cut
//!   out of it as plain text, on one line, without control characters, and cut short.
//!   Images, icons and everything else the page links to are not fetched.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::Serialize;

pub const MAX_REDIRECTS: usize = 5;
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ADDRESS_LEN: usize = 2048;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_DESCRIPTION_CHARS: usize = 300;
const USER_AGENT: &str = "Amby-Notes-link-preview";

/// The codes the webview turns into a sentence.
pub const ERR_ADDRESS_NOT_ALLOWED: &str = "AddressNotAllowed";
pub const ERR_PRIVATE_ADDRESS: &str = "PrivateAddress";
pub const ERR_TOO_MANY_REDIRECTS: &str = "TooManyRedirects";
pub const ERR_NOT_HTML: &str = "PageNotHtml";
pub const ERR_BAD_STATUS: &str = "PageBadStatus";
pub const ERR_ENCODING: &str = "PageEncodingUnsupported";
pub const ERR_NO_TITLE: &str = "PageHasNoTitle";
pub const ERR_NETWORK: &str = "PageNetworkFailed";
pub const ERR_TIMEOUT: &str = "PageTimeout";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub title: String,
    pub description: Option<String>,
}

/// Limits of one fetch. Only tests build anything but [`Limits::production`].
#[derive(Debug, Clone)]
pub struct Limits {
    pub allow_private: bool,
    pub total_timeout: Duration,
}

impl Limits {
    pub fn production() -> Self {
        Limits {
            allow_private: false,
            total_timeout: TOTAL_TIMEOUT,
        }
    }
}

// ── Which addresses are public ────────────────────────────────────────────────────────

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || a == 0
        // shared address space (carrier-grade NAT), 100.64.0.0/10
        || (a == 100 && (64..=127).contains(&b))
        // IETF protocol assignments 192.0.0.0/24, documentation ranges
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        // benchmarking 198.18.0.0/15
        || (a == 198 && (18..=19).contains(&b))
        // reserved 240.0.0.0/4
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    // IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an
    // IPv4 address that is judged the same way.
    if s[..6] == [0, 0, 0, 0, 0, 0] && !ip.is_unspecified() && !ip.is_loopback() {
        return is_public_v4(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            s[6] as u8,
            (s[7] >> 8) as u8,
            s[7] as u8,
        ));
    }
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return is_public_v4(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            s[6] as u8,
            (s[7] >> 8) as u8,
            s[7] as u8,
        ));
    }
    if s[0] == 0x2002 {
        return is_public_v4(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // unique local fc00::/7, link-local fe80::/10, site-local fec0::/10
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xffc0) == 0xfec0
        // documentation 2001:db8::/32, Teredo 2001::/32, benchmarking 2001:2::/48
        || (s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] == 0 || s[1] == 2)))
}

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

/// Names that mean "this computer" or "the network I am in", whatever they resolve to.
fn is_local_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || !host.contains('.')
        || [
            "localhost",
            "local",
            "localdomain",
            "internal",
            "lan",
            "home",
            "intranet",
            "corp",
        ]
        .iter()
        .any(|suffix| host.ends_with(&format!(".{suffix}")))
        || host.ends_with(".home.arpa")
        || host.ends_with(".in-addr.arpa")
        || host.ends_with(".ip6.arpa")
}

fn parse_http_url(address: &str) -> Result<Url, &'static str> {
    let address = address.trim();
    if address.is_empty()
        || address.len() > MAX_ADDRESS_LEN
        || address.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(ERR_ADDRESS_NOT_ALLOWED);
    }
    let url = Url::parse(address).map_err(|_| ERR_ADDRESS_NOT_ALLOWED)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ERR_ADDRESS_NOT_ALLOWED);
    }
    Ok(url)
}

// ── Taking the page apart ─────────────────────────────────────────────────────────────

/// Plain text on one line: no control or invisible formatting characters, white space
/// folded to single spaces, cut to `max_chars` (with an ellipsis when it was cut).
pub(crate) fn plain_line(raw: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for c in raw.chars() {
        let invisible = matches!(c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}' | '\u{FFFC}' | '\u{FFFD}');
        if c.is_whitespace() || matches!(c, '\u{0085}' | '\u{2028}' | '\u{2029}') {
            pending_space = !out.is_empty();
        } else if c.is_control() || invisible {
            continue;
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    if out.chars().count() > max_chars {
        let cut: String = out.chars().take(max_chars.saturating_sub(1)).collect();
        return format!("{}…", cut.trim_end());
    }
    out
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|end| *end <= 10).and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                "laquo" => Some('«'),
                "raquo" => Some('»'),
                _ => name.strip_prefix('#').and_then(|number| {
                    let code = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => number.parse::<u32>().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            c.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The value of an attribute in the text between `<meta` and `>`.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        from = start + name.len();
        let boundary_before = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let after = tag[from..].trim_start();
        if !boundary_before || !after.starts_with('=') {
            continue;
        }
        let value = after[1..].trim_start();
        return match value.chars().next()? {
            quote @ ('"' | '\'') => value[1..]
                .find(quote)
                .map(|end| value[1..1 + end].to_string()),
            _ => Some(
                value
                    .split(|c: char| c.is_whitespace() || c == '>')
                    .next()
                    .unwrap_or("")
                    .to_string(),
            ),
        };
    }
    None
}

/// The title and the description of a page, as plain one-line text. Only the head of the
/// document is read, and nothing inside comments, scripts or styles.
pub(crate) fn extract_page_info(html: &str) -> Option<PageInfo> {
    let lower = html.to_ascii_lowercase();
    let head_end = lower
        .find("</head>")
        .or_else(|| lower.find("<body"))
        .unwrap_or(html.len());
    let mut title: Option<String> = None;
    let mut og_title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut og_description: Option<String> = None;
    let mut index = 0;
    while let Some(found) = lower[index..head_end].find('<') {
        let start = index + found;
        let rest = &lower[start..head_end];
        if rest.starts_with("<!--") {
            index = rest.find("-->").map_or(head_end, |end| start + end + 3);
        } else if rest.starts_with("<script") || rest.starts_with("<style") {
            let close = if rest.starts_with("<script") {
                "</script"
            } else {
                "</style"
            };
            index = rest
                .find(close)
                .map_or(head_end, |end| start + end + close.len());
        } else if rest.starts_with("<title") && rest[6..].starts_with(['>', ' ', '\t', '\n', '\r'])
        {
            let Some(open_end) = rest.find('>') else {
                break;
            };
            let text_start = start + open_end + 1;
            let text_end = lower[text_start..head_end]
                .find("</title")
                .map_or(head_end, |end| text_start + end);
            if title.is_none() {
                title = Some(html[text_start..text_end].to_string());
            }
            index = text_end;
        } else if rest.starts_with("<meta") && rest[5..].starts_with([' ', '\t', '\n', '\r', '/']) {
            let tag_end = rest.find('>').map_or(head_end, |end| start + end);
            let tag = &html[start + 5..tag_end];
            let content = attribute(tag, "content");
            let key = attribute(tag, "name")
                .or_else(|| attribute(tag, "property"))
                .map(|key| key.to_ascii_lowercase());
            if let (Some(key), Some(content)) = (key, content) {
                match key.as_str() {
                    "description" if description.is_none() => description = Some(content),
                    "og:title" if og_title.is_none() => og_title = Some(content),
                    "og:description" if og_description.is_none() => og_description = Some(content),
                    _ => {}
                }
            }
            index = tag_end;
        } else {
            index = start + 1;
        }
    }
    let line = |raw: Option<String>, max: usize| {
        raw.map(|raw| plain_line(&decode_entities(&raw), max))
            .filter(|text| !text.is_empty())
    };
    let title = line(title, MAX_TITLE_CHARS).or_else(|| line(og_title, MAX_TITLE_CHARS))?;
    let description = line(description, MAX_DESCRIPTION_CHARS)
        .or_else(|| line(og_description, MAX_DESCRIPTION_CHARS));
    Some(PageInfo { title, description })
}

/// The charset the content type names, if it names one.
fn declared_charset(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|part| {
        let (name, value) = part.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_ascii_lowercase())
    })
}

/// The text of a page that is (or may be) UTF-8; `None` for another encoding. A page cut
/// off in the middle of a character is still text.
fn utf8_prefix(bytes: &[u8]) -> Option<&str> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    }
}

// ── The network ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) struct Hop {
    pub status: u16,
    pub location: Option<String>,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// One request and one name lookup: the part of a fetch that touches the network, so that
/// the rules above can be tested without one.
pub(crate) trait Transport {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, &'static str>;
    /// Asks `url` once. `pin` is the name and the address it was checked to resolve to; the
    /// connection goes to that address and to no other.
    async fn get(&self, url: &Url, pin: Option<(&str, IpAddr)>) -> Result<Hop, &'static str>;
}

pub(crate) async fn fetch_with<T: Transport>(
    transport: &T,
    address: &str,
    limits: &Limits,
) -> Result<PageInfo, &'static str> {
    let mut url = parse_http_url(address)?;
    for hop_number in 0..=MAX_REDIRECTS {
        let pin = match url.host() {
            Some(url::Host::Domain(name)) => {
                if !limits.allow_private && is_local_name(name) {
                    return Err(ERR_PRIVATE_ADDRESS);
                }
                let port = url.port_or_known_default().unwrap_or(80);
                let addresses = transport.resolve(name, port).await?;
                if addresses.is_empty()
                    || (!limits.allow_private && !addresses.iter().all(|ip| is_public_ip(*ip)))
                {
                    return Err(ERR_PRIVATE_ADDRESS);
                }
                Some((name.to_string(), addresses[0]))
            }
            Some(url::Host::Ipv4(ip)) => {
                if !limits.allow_private && !is_public_v4(ip) {
                    return Err(ERR_PRIVATE_ADDRESS);
                }
                None
            }
            Some(url::Host::Ipv6(ip)) => {
                if !limits.allow_private && !is_public_v6(ip) {
                    return Err(ERR_PRIVATE_ADDRESS);
                }
                None
            }
            None => return Err(ERR_ADDRESS_NOT_ALLOWED),
        };
        let hop = transport
            .get(&url, pin.as_ref().map(|(name, ip)| (name.as_str(), *ip)))
            .await?;
        match hop.status {
            301 | 302 | 303 | 307 | 308 => {
                if hop_number == MAX_REDIRECTS {
                    return Err(ERR_TOO_MANY_REDIRECTS);
                }
                let next = hop.location.ok_or(ERR_BAD_STATUS)?;
                let next = url.join(next.trim()).map_err(|_| ERR_ADDRESS_NOT_ALLOWED)?;
                // The next address goes through the same rules as the first one.
                url = parse_http_url(next.as_str())?;
            }
            200 => {
                let content_type = hop.content_type.unwrap_or_default();
                let essence = content_type.split(';').next().unwrap_or("").trim();
                if !essence.eq_ignore_ascii_case("text/html") {
                    return Err(ERR_NOT_HTML);
                }
                if declared_charset(&content_type).is_some_and(|charset| {
                    !matches!(charset.as_str(), "utf-8" | "utf8" | "us-ascii")
                }) {
                    return Err(ERR_ENCODING);
                }
                let text = utf8_prefix(&hop.body).ok_or(ERR_ENCODING)?;
                return extract_page_info(text).ok_or(ERR_NO_TITLE);
            }
            _ => return Err(ERR_BAD_STATUS),
        }
    }
    Err(ERR_TOO_MANY_REDIRECTS)
}

struct NetworkTransport;

impl Transport for NetworkTransport {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, &'static str> {
        tokio::net::lookup_host((host, port))
            .await
            .map(|found| found.map(|addr| addr.ip()).collect())
            .map_err(|_| ERR_NETWORK)
    }

    async fn get(&self, url: &Url, pin: Option<(&str, IpAddr)>) -> Result<Hop, &'static str> {
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // A proxy would make the request from somewhere this check cannot see.
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(TOTAL_TIMEOUT)
            .user_agent(USER_AGENT);
        if let Some((name, ip)) = pin {
            // The port of this address is ignored; the one of the URL is used.
            builder = builder.resolve(name, SocketAddr::new(ip, 0));
        }
        let client = builder.build().map_err(|_| ERR_NETWORK)?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "text/html")
            .send()
            .await
            .map_err(|_| ERR_NETWORK)?;
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let status = response.status().as_u16();
        let location = header(reqwest::header::LOCATION);
        let content_type = header(reqwest::header::CONTENT_TYPE);
        let mut body = Vec::new();
        let is_html = content_type.as_deref().is_some_and(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("text/html")
        });
        if status == 200 && is_html {
            // Only the beginning of the answer is read; the rest is never requested.
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ERR_NETWORK)?;
                let room = MAX_BODY_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                if body.len() >= MAX_BODY_BYTES {
                    break;
                }
            }
        }
        Ok(Hop {
            status,
            location,
            content_type,
            body,
        })
    }
}

/// Fetches the title and the description of the page at `address`.
pub async fn fetch_page_info(address: &str, limits: &Limits) -> Result<PageInfo, &'static str> {
    match tokio::time::timeout(
        limits.total_timeout,
        fetch_with(&NetworkTransport, address, limits),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(ERR_TIMEOUT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A network that answers from a table, and remembers what it was asked.
    type FakePage = (u16, Option<String>, Option<&'static str>, Vec<u8>);

    #[derive(Default)]
    struct Fake {
        names: HashMap<&'static str, Vec<IpAddr>>,
        pages: HashMap<String, FakePage>,
        asked: Mutex<Vec<String>>,
        pinned: Mutex<Vec<Option<(String, IpAddr)>>>,
    }

    impl Fake {
        fn name(mut self, name: &'static str, ip: &str) -> Self {
            self.names
                .entry(name)
                .or_default()
                .push(ip.parse().unwrap());
            self
        }
        fn page(
            mut self,
            url: &str,
            status: u16,
            location: Option<&str>,
            kind: Option<&'static str>,
            body: &str,
        ) -> Self {
            self.pages.insert(
                url.to_string(),
                (
                    status,
                    location.map(str::to_string),
                    kind,
                    body.as_bytes().to_vec(),
                ),
            );
            self
        }
        fn requests(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    impl Transport for Fake {
        async fn resolve(&self, host: &str, _port: u16) -> Result<Vec<IpAddr>, &'static str> {
            self.names.get(host).cloned().ok_or(ERR_NETWORK)
        }
        async fn get(&self, url: &Url, pin: Option<(&str, IpAddr)>) -> Result<Hop, &'static str> {
            self.asked.lock().unwrap().push(url.to_string());
            self.pinned
                .lock()
                .unwrap()
                .push(pin.map(|(name, ip)| (name.to_string(), ip)));
            let (status, location, kind, body) =
                self.pages.get(url.as_str()).cloned().ok_or(ERR_NETWORK)?;
            Ok(Hop {
                status,
                location,
                content_type: kind.map(str::to_string),
                body,
            })
        }
    }

    const HTML: &str = "text/html; charset=utf-8";
    const PAGE: &str =
        "<html><head><title>Hello</title><meta name=description content='About it'></head></html>";

    fn run(fake: &Fake, address: &str) -> Result<PageInfo, &'static str> {
        tauri::async_runtime::block_on(fetch_with(fake, address, &Limits::production()))
    }

    fn public_site() -> Fake {
        Fake::default().name("example.com", "93.184.216.34")
    }

    #[test]
    fn reads_a_page_and_asks_exactly_once_at_the_address_it_checked() {
        let fake = public_site().page("https://example.com/", 200, None, Some(HTML), PAGE);
        let info = run(&fake, "https://example.com/").unwrap();
        assert_eq!(info.title, "Hello");
        assert_eq!(info.description.as_deref(), Some("About it"));
        assert_eq!(fake.requests(), 1);
        assert_eq!(
            fake.pinned.lock().unwrap()[0],
            Some(("example.com".to_string(), "93.184.216.34".parse().unwrap()))
        );
    }

    #[test]
    fn never_asks_a_local_address_or_name() {
        let fake = Fake::default()
            .name("sneaky.example", "10.0.0.5")
            .name("mixed.example", "93.184.216.34")
            .name("mixed.example", "192.168.0.7")
            .name("v6.example", "fd12:3456::1");
        for address in [
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://printer.local/",
            "http://router/",
            "http://nas.lan/",
            "http://127.0.0.1/",
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://0.0.0.0/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:192.168.0.1]/",
            "http://[64:ff9b::7f00:1]/",
            "http://[2002:7f00:1::]/",
            // a name that resolves to a local address, alone or among public ones
            "http://sneaky.example/",
            "http://mixed.example/",
            "http://v6.example/",
        ] {
            assert_eq!(run(&fake, address), Err(ERR_PRIVATE_ADDRESS), "{address}");
        }
        assert_eq!(fake.requests(), 0, "a local address must not even be asked");
    }

    #[test]
    fn accepts_public_addresses_around_the_private_ranges() {
        for ip in [
            "93.184.216.34",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "169.253.1.1",
            "192.169.0.1",
            "11.0.0.1",
            "2606:2800:220:1:248:1893:25c8:1946",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn refuses_a_redirect_to_a_local_address() {
        for target in [
            "http://127.0.0.1/admin",
            "http://localhost:8080/",
            "http://internal.example/secret",
            "http://[::1]/",
            "//10.0.0.1/",
            "/relative-is-fine-but-see-below",
        ] {
            let fake = public_site()
                .name("internal.example", "10.0.0.5")
                .page("https://example.com/", 302, Some(target), None, "")
                .page(
                    "https://example.com/relative-is-fine-but-see-below",
                    200,
                    None,
                    Some(HTML),
                    PAGE,
                );
            let result = run(&fake, "https://example.com/");
            if target.starts_with('/') && !target.starts_with("//") {
                assert!(result.is_ok(), "{target}");
            } else {
                assert_eq!(result, Err(ERR_PRIVATE_ADDRESS), "{target}");
                assert_eq!(
                    fake.requests(),
                    1,
                    "{target}: only the first address is asked"
                );
            }
        }
    }

    #[test]
    fn refuses_a_redirect_to_another_kind_of_address() {
        for target in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "ftp://example.com/",
        ] {
            let fake = public_site().page("https://example.com/", 301, Some(target), None, "");
            assert_eq!(
                run(&fake, "https://example.com/"),
                Err(ERR_ADDRESS_NOT_ALLOWED),
                "{target}"
            );
        }
        let missing = public_site().page("https://example.com/", 302, None, None, "");
        assert_eq!(run(&missing, "https://example.com/"), Err(ERR_BAD_STATUS));
    }

    #[test]
    fn follows_at_most_five_redirects() {
        let chain = |count: usize| {
            let mut fake = public_site();
            for step in 0..count {
                let from = if step == 0 {
                    "https://example.com/".to_string()
                } else {
                    format!("https://example.com/{step}")
                };
                fake = fake.page(&from, 302, Some(&format!("/{}", step + 1)), None, "");
            }
            fake.page(
                &format!("https://example.com/{count}"),
                200,
                None,
                Some(HTML),
                PAGE,
            )
        };
        assert!(run(&chain(5), "https://example.com/").is_ok());
        assert_eq!(
            run(&chain(6), "https://example.com/"),
            Err(ERR_TOO_MANY_REDIRECTS)
        );
        let looping = public_site().page("https://example.com/", 302, Some("/"), None, "");
        assert_eq!(
            run(&looping, "https://example.com/"),
            Err(ERR_TOO_MANY_REDIRECTS)
        );
    }

    #[test]
    fn refuses_what_is_not_a_web_address() {
        let fake = public_site();
        for address in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "ftp://example.com/",
            "https://user:secret@example.com/",
            "example.com",
            "",
            "https://exa mple.com/",
            "https://example.com/\nsecond",
        ] {
            assert_eq!(
                run(&fake, address),
                Err(ERR_ADDRESS_NOT_ALLOWED),
                "{address:?}"
            );
        }
        assert_eq!(fake.requests(), 0);
    }

    #[test]
    fn refuses_an_answer_that_is_not_html_or_not_utf8() {
        for (kind, expected) in [
            ("application/json", ERR_NOT_HTML),
            ("image/png", ERR_NOT_HTML),
            ("application/pdf", ERR_NOT_HTML),
            ("text/plain", ERR_NOT_HTML),
            ("text/htmlx", ERR_NOT_HTML),
            ("text/html; charset=windows-1251", ERR_ENCODING),
            ("text/html; charset=iso-8859-1", ERR_ENCODING),
        ] {
            let fake = public_site().page("https://example.com/", 200, None, Some(kind), PAGE);
            assert_eq!(run(&fake, "https://example.com/"), Err(expected), "{kind}");
        }
        let none = public_site().page("https://example.com/", 200, None, None, PAGE);
        assert_eq!(run(&none, "https://example.com/"), Err(ERR_NOT_HTML));
        let mut fake = public_site();
        fake.pages.insert(
            "https://example.com/".into(),
            (
                200,
                None,
                Some("text/html"),
                b"<title>\xff\xfe</title>".to_vec(),
            ),
        );
        assert_eq!(run(&fake, "https://example.com/"), Err(ERR_ENCODING));
    }

    #[test]
    fn a_failed_status_or_a_page_without_a_title_is_a_refusal() {
        for status in [204, 400, 403, 404, 500, 503] {
            let fake = public_site().page("https://example.com/", status, None, Some(HTML), PAGE);
            assert!(run(&fake, "https://example.com/").is_err(), "{status}");
        }
        let fake = public_site().page(
            "https://example.com/",
            200,
            None,
            Some(HTML),
            "<html><head></head></html>",
        );
        assert_eq!(run(&fake, "https://example.com/"), Err(ERR_NO_TITLE));
    }

    // ── what is cut out of a page ─────────────────────────────────────────────────

    #[test]
    fn cuts_the_title_and_the_description_out_as_plain_one_line_text() {
        let html = "<!doctype html><HTML><HEAD>\n<TITLE>\n  A &amp; B &lt;b&gt;bold&lt;/b&gt;\n  &#8212; &#x41;\u{7}\u{202E}x\n</TITLE>\
            <meta property=\"og:description\" content=\"Line one\nline two   &quot;quoted&quot;\">\
            </HEAD><body><title>not this</title></body></HTML>";
        let info = extract_page_info(html).unwrap();
        assert_eq!(info.title, "A & B <b>bold</b> — Ax");
        assert_eq!(
            info.description.as_deref(),
            Some("Line one line two \"quoted\"")
        );
    }

    #[test]
    fn text_that_looks_like_markdown_or_html_stays_text() {
        let html = "<title># Heading [x](http://evil) ![i](a.png) `code` &lt;script&gt;alert(1)&lt;/script&gt;</title>";
        let info = extract_page_info(html).unwrap();
        assert_eq!(
            info.title,
            "# Heading [x](http://evil) ![i](a.png) `code` <script>alert(1)</script>"
        );
        assert!(!info.title.contains('\n'));
    }

    #[test]
    fn prefers_the_title_tag_then_falls_back_to_the_open_graph_title() {
        let both = "<head><meta property=og:title content='OG'><title>Tag</title></head>";
        assert_eq!(extract_page_info(both).unwrap().title, "Tag");
        let only_og = "<head><meta content='OG only' property='og:title'></head>";
        assert_eq!(extract_page_info(only_og).unwrap().title, "OG only");
        let empty_tag = "<head><title>  </title><meta property=og:title content='OG'></head>";
        assert_eq!(extract_page_info(empty_tag).unwrap().title, "OG");
    }

    #[test]
    fn ignores_titles_in_comments_scripts_and_the_body() {
        let html = "<head><!-- <title>comment</title> --><script>var t='<title>script</title>'</script>\
            <style>/* <title>style</title> */</style><title>Real</title></head><body><title>body</title></body>";
        assert_eq!(extract_page_info(html).unwrap().title, "Real");
        assert_eq!(extract_page_info("<body><title>late</title></body>"), None);
    }

    #[test]
    fn cuts_a_long_title_and_a_long_description_short() {
        let long = "word ".repeat(500);
        let html = format!("<title>{long}</title><meta name=description content=\"{long}\">");
        let info = extract_page_info(&html).unwrap();
        assert_eq!(info.title.chars().count(), MAX_TITLE_CHARS);
        assert!(info.title.ends_with('…'));
        assert!(info.description.unwrap().chars().count() <= MAX_DESCRIPTION_CHARS);
    }

    #[test]
    fn plain_line_drops_controls_and_invisible_marks_and_folds_white_space() {
        assert_eq!(
            plain_line("a\tb\r\nc\u{0085}d\u{2028}e\u{200B}f\u{FEFF}\u{0000}g", 100),
            "a b c d ef g".replace("ef g", "efg")
        );
        assert_eq!(plain_line("  \n\t ", 10), "");
        assert_eq!(plain_line("Привет, мир — тест", 100), "Привет, мир — тест");
        assert_eq!(plain_line("абвгд", 3), "аб…");
    }

    #[test]
    fn a_page_cut_in_the_middle_of_a_character_is_still_text() {
        let mut bytes = "<title>Привет</title>".as_bytes().to_vec();
        bytes.extend_from_slice(&"é".as_bytes()[..1]);
        assert!(utf8_prefix(&bytes).is_some());
        assert!(utf8_prefix(b"\xff").is_none());
    }

    // ── the real network code, against a server of the test's own ──────────────────

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn test_limits(timeout_ms: u64) -> Limits {
        Limits {
            allow_private: true,
            total_timeout: Duration::from_millis(timeout_ms),
        }
    }

    /// Serves one canned answer per connection; counts the connections.
    async fn serve(
        answer: Vec<u8>,
        hang: bool,
    ) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let answer = answer.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = socket.read(&mut buffer).await;
                    if hang {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let _ = socket.write_all(&answer).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (port, count)
    }

    fn http(kind: &str, body: &[u8]) -> Vec<u8> {
        let mut answer = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        answer.extend_from_slice(body);
        answer
    }

    #[test]
    fn reads_a_page_from_a_real_connection() {
        tauri::async_runtime::block_on(async {
            let (port, _) = serve(http(HTML, PAGE.as_bytes()), false).await;
            let info = fetch_page_info(&format!("http://127.0.0.1:{port}/"), &test_limits(5_000))
                .await
                .unwrap();
            assert_eq!(info.title, "Hello");
        });
    }

    #[test]
    fn reads_only_the_beginning_of_a_huge_page() {
        tauri::async_runtime::block_on(async {
            let mut body = b"<html><head><title>Early</title></head><body>".to_vec();
            body.extend(std::iter::repeat_n(b'x', 8 * 1024 * 1024));
            let (port, _) = serve(http(HTML, &body), false).await;
            let info = fetch_page_info(&format!("http://127.0.0.1:{port}/"), &test_limits(5_000))
                .await
                .unwrap();
            assert_eq!(info.title, "Early");
            // A title that begins after the first part of the page is not looked for.
            let mut late = vec![b' '; MAX_BODY_BYTES + 1024];
            late.extend_from_slice(b"<title>Late</title>");
            let (port, _) = serve(http(HTML, &late), false).await;
            assert_eq!(
                fetch_page_info(&format!("http://127.0.0.1:{port}/"), &test_limits(5_000)).await,
                Err(ERR_NO_TITLE)
            );
        });
    }

    #[test]
    fn refuses_a_real_answer_that_is_not_html() {
        tauri::async_runtime::block_on(async {
            let (port, _) = serve(http("application/json", br#"{"title":"x"}"#), false).await;
            assert_eq!(
                fetch_page_info(&format!("http://127.0.0.1:{port}/"), &test_limits(5_000)).await,
                Err(ERR_NOT_HTML)
            );
        });
    }

    #[test]
    fn gives_up_on_a_server_that_never_answers() {
        tauri::async_runtime::block_on(async {
            let (port, _) = serve(Vec::new(), true).await;
            let started = std::time::Instant::now();
            assert_eq!(
                fetch_page_info(&format!("http://127.0.0.1:{port}/"), &test_limits(300)).await,
                Err(ERR_TIMEOUT)
            );
            assert!(started.elapsed() < Duration::from_secs(5));
        });
    }

    #[test]
    fn the_real_code_does_not_connect_to_this_computer() {
        tauri::async_runtime::block_on(async {
            let (port, connections) = serve(http(HTML, PAGE.as_bytes()), false).await;
            for address in [
                format!("http://127.0.0.1:{port}/"),
                format!("http://localhost:{port}/"),
                format!("http://[::1]:{port}/"),
            ] {
                assert_eq!(
                    fetch_page_info(&address, &Limits::production()).await,
                    Err(ERR_PRIVATE_ADDRESS),
                    "{address}"
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn the_real_code_does_not_follow_a_redirect_to_this_computer() {
        tauri::async_runtime::block_on(async {
            let (target_port, connections) = serve(http(HTML, PAGE.as_bytes()), false).await;
            let redirect = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let (port, _) = serve(redirect.into_bytes(), false).await;
            // The first server is allowed (as a stand-in for a public one); the second is
            // this computer and is judged by the production rules on the way.
            let transport = NetworkTransport;
            let hop = transport
                .get(
                    &Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
                    None,
                )
                .await
                .unwrap();
            assert_eq!(hop.status, 302);
            let next = parse_http_url(hop.location.as_deref().unwrap()).unwrap();
            assert_eq!(
                fetch_with(&transport, next.as_str(), &Limits::production()).await,
                Err(ERR_PRIVATE_ADDRESS)
            );
            assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 0);
        });
    }
}
