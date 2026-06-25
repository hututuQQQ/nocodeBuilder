use std::{
    fs::OpenOptions,
    io::{self, BufRead, BufReader, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::Serialize;

use super::types::SandboxError;

const MAX_CONNECT_LINE_BYTES: usize = 4096;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub struct ManagedProxy {
    port: u16,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    #[allow(dead_code)]
    audit_log: Arc<Mutex<Vec<ProxyAuditRecord>>>,
    #[allow(dead_code)]
    audit_log_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProxyAuditRecord {
    pub run_id: String,
    pub host: String,
    pub port: u16,
    pub started_at: String,
    pub finished_at: String,
    pub allowed: bool,
    pub reason: String,
    pub bytes_from_client: u64,
    pub bytes_from_remote: u64,
}

impl ManagedProxy {
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ManagedProxy {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn start_managed_proxy(
    run_id: String,
    allowed_hosts: Vec<String>,
    audit_log_path: Option<PathBuf>,
) -> Result<ManagedProxy, SandboxError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        SandboxError::unavailable(format!("failed to start managed install proxy: {error}"))
    })?;
    listener.set_nonblocking(true).map_err(|error| {
        SandboxError::unavailable(format!(
            "failed to configure managed install proxy: {error}"
        ))
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to read managed install proxy port: {error}"
            ))
        })?
        .port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let audit_log = Arc::new(Mutex::new(Vec::new()));
    let shutdown_for_thread = shutdown.clone();
    let audit_for_thread = audit_log.clone();
    let audit_path_for_thread = audit_log_path.clone();

    let handle = thread::Builder::new()
        .name("ncb-managed-install-proxy".to_string())
        .spawn(move || {
            while !shutdown_for_thread.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let run_id = run_id.clone();
                        let allowed_hosts = allowed_hosts.clone();
                        let audit_log = audit_for_thread.clone();
                        let audit_log_path = audit_path_for_thread.clone();

                        let _ = thread::Builder::new()
                            .name("ncb-managed-install-proxy-conn".to_string())
                            .spawn(move || {
                                handle_proxy_client(
                                    stream,
                                    run_id,
                                    allowed_hosts,
                                    audit_log,
                                    audit_log_path,
                                )
                            });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to start managed install proxy thread: {error}"
            ))
        })?;

    Ok(ManagedProxy {
        port,
        shutdown,
        handle: Some(handle),
        audit_log,
        audit_log_path,
    })
}

fn handle_proxy_client(
    stream: TcpStream,
    run_id: String,
    allowed_hosts: Vec<String>,
    audit_log: Arc<Mutex<Vec<ProxyAuditRecord>>>,
    audit_log_path: Option<PathBuf>,
) {
    let started_at = current_timestamp();
    let mut host = String::new();
    let mut port = 0;

    let result = handle_proxy_client_inner(stream, &allowed_hosts, &mut host, &mut port);
    let (allowed, reason, bytes_from_client, bytes_from_remote) = match result {
        Ok((client_bytes, remote_bytes)) => {
            (true, "connected".to_string(), client_bytes, remote_bytes)
        }
        Err(error) => (false, error, 0, 0),
    };

    let record = ProxyAuditRecord {
        run_id,
        host,
        port,
        started_at,
        finished_at: current_timestamp(),
        allowed,
        reason,
        bytes_from_client,
        bytes_from_remote,
    };

    if let Ok(mut audit_log) = audit_log.lock() {
        audit_log.push(record.clone());
    }

    if let Some(path) = audit_log_path {
        let _ = append_proxy_audit_record(&path, &record);
    }
}

fn append_proxy_audit_record(path: &PathBuf, record: &ProxyAuditRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create proxy audit directory: {error}"))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open proxy audit log: {error}"))?;
    serde_json::to_writer(&mut file, record)
        .map_err(|error| format!("failed to serialize proxy audit record: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("failed to write proxy audit record: {error}"))?;

    Ok(())
}

fn current_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn handle_proxy_client_inner(
    stream: TcpStream,
    allowed_hosts: &[String],
    host_out: &mut String,
    port_out: &mut u16,
) -> Result<(u64, u64), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();

    reader
        .read_line(&mut first_line)
        .map_err(|error| format!("failed to read proxy request: {error}"))?;

    if first_line.len() > MAX_CONNECT_LINE_BYTES {
        let mut stream = reader.into_inner();
        let _ = write_proxy_response(&mut stream, 400, "Bad Request");
        return Err("request line too long".to_string());
    }

    let (host, port) = match parse_connect_request_line(&first_line) {
        Ok(value) => value,
        Err(error) => {
            let mut stream = reader.into_inner();
            let _ = write_proxy_response(&mut stream, 400, "Bad Request");
            return Err(error);
        }
    };

    *host_out = host.clone();
    *port_out = port;

    let mut total_header_bytes = first_line.len();
    let mut header = String::new();

    loop {
        header.clear();
        let bytes = reader
            .read_line(&mut header)
            .map_err(|error| format!("failed to read proxy headers: {error}"))?;

        if bytes == 0 {
            let mut stream = reader.into_inner();
            let _ = write_proxy_response(&mut stream, 400, "Bad Request");
            return Err("proxy request ended before headers completed".to_string());
        }

        total_header_bytes += bytes;

        if total_header_bytes > MAX_HEADER_BYTES {
            let mut stream = reader.into_inner();
            let _ = write_proxy_response(&mut stream, 400, "Bad Request");
            return Err("request headers too large".to_string());
        }

        if header == "\r\n" || header == "\n" {
            break;
        }
    }

    if port != 443 {
        let mut stream = reader.into_inner();
        let _ = write_proxy_response(&mut stream, 403, "Forbidden");
        return Err(format!("port {port} is not allowed"));
    }

    if !host_matches_allowlist(&host, allowed_hosts) {
        let mut stream = reader.into_inner();
        let _ = write_proxy_response(&mut stream, 403, "Forbidden");
        return Err(format!("host '{host}' is not allowlisted"));
    }

    let addresses = resolve_public_addresses(&host, port).map_err(|error| {
        let mut stream = reader.get_mut();
        let _ = write_proxy_response(&mut stream, 403, "Forbidden");
        error
    })?;
    let remote = connect_to_any(&addresses).map_err(|error| {
        let mut stream = reader.get_mut();
        let _ = write_proxy_response(&mut stream, 502, "Bad Gateway");
        error
    })?;
    let mut stream = reader.into_inner();

    write_proxy_response(&mut stream, 200, "Connection Established")
        .map_err(|error| format!("failed to write proxy response: {error}"))?;
    tunnel(stream, remote)
}

fn parse_connect_request_line(line: &str) -> Result<(String, u16), String> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let authority = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();

    if method != "CONNECT" || !version.starts_with("HTTP/") || parts.next().is_some() {
        return Err("managed proxy only accepts HTTPS CONNECT requests".to_string());
    }

    parse_authority(authority)
}

fn parse_authority(authority: &str) -> Result<(String, u16), String> {
    if authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
    {
        return Err("invalid CONNECT authority".to_string());
    }

    if let Some(rest) = authority.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err("invalid IPv6 CONNECT authority".to_string());
        };
        let host = &rest[..end];
        let port_part = rest[end + 1..]
            .strip_prefix(':')
            .ok_or_else(|| "CONNECT authority must include an explicit port".to_string())?;
        let port = parse_port(port_part)?;
        return Ok((normalize_host(host)?, port));
    }

    let Some((host, port_part)) = authority.rsplit_once(':') else {
        return Err("CONNECT authority must include an explicit port".to_string());
    };

    if host.contains(':') {
        return Err("IPv6 CONNECT authority must use brackets".to_string());
    }

    Ok((normalize_host(host)?, parse_port(port_part)?))
}

fn normalize_host(host: &str) -> Result<String, String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();

    if host.is_empty()
        || host.len() > 253
        || host.contains('*')
        || host.contains('@')
        || host.contains('\\')
    {
        return Err("invalid CONNECT host".to_string());
    }

    Ok(host)
}

fn parse_port(port: &str) -> Result<u16, String> {
    port.parse::<u16>()
        .map_err(|_| "invalid CONNECT port".to_string())
}

fn host_matches_allowlist(host: &str, allowed_hosts: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();

    allowed_hosts.iter().any(|pattern| {
        let pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();

        if let Some(suffix) = pattern.strip_prefix("*.") {
            return host != suffix && host.ends_with(&format!(".{suffix}"));
        }

        host == pattern
    })
}

fn resolve_public_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve '{host}': {error}"))?
        .collect::<Vec<_>>();

    if addresses.is_empty() {
        return Err(format!("host '{host}' did not resolve"));
    }

    if let Some(address) = addresses
        .iter()
        .find(|address| is_disallowed_proxy_target_ip(address.ip()))
    {
        return Err(format!(
            "resolved address '{}' is not allowed for managed proxy",
            address.ip()
        ));
    }

    Ok(addresses)
}

fn is_disallowed_proxy_target_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_disallowed_ipv4(ip),
        IpAddr::V6(ip) => is_disallowed_ipv6(ip),
    }
}

fn is_disallowed_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
}

fn is_disallowed_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || is_ipv6_unique_local(ip)
        || is_ipv6_unicast_link_local(ip)
}

fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_ipv6_unicast_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn connect_to_any(addresses: &[SocketAddr]) -> Result<TcpStream, String> {
    let started = Instant::now();
    let mut last_error = None;

    for address in addresses {
        let elapsed = started.elapsed();
        let remaining = CONNECT_TIMEOUT
            .checked_sub(elapsed)
            .unwrap_or_else(|| Duration::from_secs(1));

        match TcpStream::connect_timeout(address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    Err(format!(
        "failed to connect to allowlisted host: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no address attempted".to_string())
    ))
}

fn write_proxy_response(stream: &mut TcpStream, code: u16, reason: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\nConnection: close\r\n\r\n"
    )
}

fn tunnel(client: TcpStream, remote: TcpStream) -> Result<(u64, u64), String> {
    let mut client_read = client.try_clone().map_err(|error| error.to_string())?;
    let mut remote_write = remote.try_clone().map_err(|error| error.to_string())?;
    let mut remote_read = remote;
    let mut client_write = client;

    let upload = thread::spawn(move || io::copy(&mut client_read, &mut remote_write).unwrap_or(0));
    let download =
        thread::spawn(move || io::copy(&mut remote_read, &mut client_write).unwrap_or(0));
    let bytes_from_client = upload.join().unwrap_or(0);
    let bytes_from_remote = download.join().unwrap_or(0);

    Ok((bytes_from_client, bytes_from_remote))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_exact_and_wildcard_hosts() {
        let allowed = vec![
            "registry.npmjs.org".to_string(),
            "*.npmjs.org".to_string(),
            "github.com".to_string(),
        ];

        assert!(host_matches_allowlist("registry.npmjs.org", &allowed));
        assert!(host_matches_allowlist("foo.npmjs.org", &allowed));
        assert!(host_matches_allowlist("github.com.", &allowed));
        assert!(!host_matches_allowlist("npmjs.org", &allowed));
        assert!(!host_matches_allowlist("evilnpmjs.org", &allowed));
    }

    #[test]
    fn parses_connect_authority_without_query_material() {
        assert_eq!(
            parse_connect_request_line("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n").unwrap(),
            ("registry.npmjs.org".to_string(), 443)
        );
        assert!(
            parse_connect_request_line("GET https://registry.npmjs.org/ HTTP/1.1\r\n").is_err()
        );
        assert!(parse_authority("registry.npmjs.org:443?token=secret").is_err());
    }

    #[test]
    fn rejects_private_loopback_and_link_local_addresses() {
        assert!(is_disallowed_proxy_target_ip(IpAddr::V4(Ipv4Addr::new(
            127, 0, 0, 1
        ))));
        assert!(is_disallowed_proxy_target_ip(IpAddr::V4(Ipv4Addr::new(
            10, 0, 0, 1
        ))));
        assert!(is_disallowed_proxy_target_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 1, 1
        ))));
        assert!(is_disallowed_proxy_target_ip(IpAddr::V6(
            Ipv6Addr::LOCALHOST
        )));
        assert!(is_disallowed_proxy_target_ip("fe80::1".parse().unwrap()));
        assert!(!is_disallowed_proxy_target_ip(IpAddr::V4(Ipv4Addr::new(
            104, 16, 0, 1
        ))));
    }

    #[test]
    fn live_proxy_rejects_loopback_targets_even_when_allowlisted() {
        let proxy =
            start_managed_proxy("test-run".to_string(), vec!["localhost".to_string()], None)
                .expect("proxy starts");
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.port())).expect("connect proxy");

        stream
            .write_all(b"CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n")
            .expect("write request");

        let mut response = String::new();
        match BufReader::new(stream).read_line(&mut response) {
            Ok(_) => assert!(response.contains("403")),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::UnexpectedEof
                ) => {}
            Err(error) => panic!("read response: {error}"),
        }
    }

    #[test]
    fn writes_proxy_audit_records_as_json_lines() {
        let root = std::env::temp_dir().join(format!(
            "ncb-proxy-audit-test-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let path = root.join("audit.jsonl");
        let record = ProxyAuditRecord {
            run_id: "run-1".to_string(),
            host: "registry.npmjs.org".to_string(),
            port: 443,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            finished_at: "2026-01-01T00:00:01Z".to_string(),
            allowed: true,
            reason: "connected".to_string(),
            bytes_from_client: 12,
            bytes_from_remote: 34,
        };

        append_proxy_audit_record(&path, &record).expect("write audit record");
        let content = std::fs::read_to_string(&path).expect("read audit record");

        assert!(content.contains("\"host\":\"registry.npmjs.org\""));
        assert!(content.contains("\"bytes_from_client\":12"));

        let _ = std::fs::remove_dir_all(root);
    }
}
