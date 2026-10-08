//! The smallest WebSocket client the DevTools protocol needs.
//!
//! The browser listens on loopback only, and the app is the one that started
//! it, so this speaks just enough of RFC 6455 to carry JSON both ways: the
//! upgrade request, masked text frames out, unmasked frames in (masked ones
//! are tolerated), continuation frames reassembled, ping answered, close
//! honoured. No TLS, no extensions, no compression. A crate would bring all
//! of that, and a second HTTP stack beside `http_client`, for a socket that
//! never leaves the machine.

use std::io;

use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;

/// A whole message is held in memory. A full-page screenshot is a few
/// megabytes of base64; anything past this is a misbehaving peer.
pub const MAX_MESSAGE_BYTES: usize = 48 * 1024 * 1024;

const OPCODE_CONTINUATION: u8 = 0x0;
const OPCODE_TEXT: u8 = 0x1;
const OPCODE_BINARY: u8 = 0x2;
const OPCODE_CLOSE: u8 = 0x8;
const OPCODE_PING: u8 = 0x9;
const OPCODE_PONG: u8 = 0xA;

/// Opens `ws://127.0.0.1:{port}{path}` and completes the upgrade.
///
/// Loopback is not a parameter: the only peer this client exists for is a
/// browser the app launched on this machine.
pub async fn connect(port: u16, path: &str) -> io::Result<(OwnedReadHalf, OwnedWriteHalf)> {
    if !path.starts_with('/') || path.contains(['\r', '\n', ' ']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the DevTools path is not a plain path",
        ));
    }
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream.set_nodelay(true)?;
    let key = base64::engine::general_purpose::STANDARD.encode(rand::random::<[u8; 16]>());
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    read_upgrade_response(&mut stream).await?;
    Ok(stream.into_split())
}

async fn read_upgrade_response(stream: &mut TcpStream) -> io::Result<()> {
    // Byte by byte up to the blank line, so not one byte of the first frame
    // is swallowed into the header buffer.
    let mut head = Vec::with_capacity(256);
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the upgrade response never ended",
            ));
        }
        let byte = stream.read_u8().await?;
        head.push(byte);
    }
    let text = String::from_utf8_lossy(&head);
    let status_line = text.lines().next().unwrap_or_default();
    if !status_line.contains(" 101") {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("the browser refused the DevTools connection: {status_line}"),
        ));
    }
    Ok(())
}

/// One client frame: FIN set, masked as RFC 6455 requires of a client.
pub fn encode_client_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x80 | (opcode & 0x0F));
    let len = payload.len();
    if len < 126 {
        frame.push(0x80 | len as u8);
    } else if len <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

/// Sends one text message.
pub async fn send_text<W: AsyncWrite + Unpin>(writer: &mut W, text: &str) -> io::Result<()> {
    let frame = encode_client_frame(OPCODE_TEXT, text.as_bytes(), rand::random());
    writer.write_all(&frame).await?;
    writer.flush().await
}

/// Sends a close frame; the peer's own close ends the reader.
pub async fn send_close<W: AsyncWrite + Unpin>(writer: &mut W) -> io::Result<()> {
    let frame = encode_client_frame(OPCODE_CLOSE, &[], rand::random());
    writer.write_all(&frame).await?;
    writer.flush().await
}

/// What the reader hands up.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Text(String),
    /// A ping arrived; the caller answers it with [`pong_frame`].
    Ping(Vec<u8>),
    Closed,
}

/// The pong a ping deserves.
pub fn pong_frame(payload: &[u8]) -> Vec<u8> {
    encode_client_frame(OPCODE_PONG, payload, rand::random())
}

/// Reads frames until one whole message (or a ping, or the close) is there.
pub async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Incoming> {
    let mut message: Vec<u8> = Vec::new();
    let mut in_message = false;
    loop {
        let first = match reader.read_u8().await {
            Ok(byte) => byte,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(Incoming::Closed)
            }
            Err(error) => return Err(error),
        };
        let second = reader.read_u8().await?;
        let fin = first & 0x80 != 0;
        let opcode = first & 0x0F;
        let masked = second & 0x80 != 0;
        let len = match second & 0x7F {
            126 => u64::from(reader.read_u16().await?),
            127 => reader.read_u64().await?,
            short => u64::from(short),
        };
        if len as usize > MAX_MESSAGE_BYTES || message.len() + len as usize > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a DevTools message was larger than the client accepts",
            ));
        }
        let mask = if masked {
            let mut mask = [0_u8; 4];
            reader.read_exact(&mut mask).await?;
            Some(mask)
        } else {
            None
        };
        let mut payload = vec![0_u8; len as usize];
        reader.read_exact(&mut payload).await?;
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        match opcode {
            OPCODE_CLOSE => return Ok(Incoming::Closed),
            OPCODE_PING => return Ok(Incoming::Ping(payload)),
            OPCODE_PONG => continue,
            OPCODE_TEXT | OPCODE_BINARY => {
                message = payload;
                in_message = true;
            }
            OPCODE_CONTINUATION if in_message => message.extend_from_slice(&payload),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "an unexpected WebSocket frame",
                ))
            }
        }
        if fin && in_message {
            return String::from_utf8(message).map(Incoming::Text).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "a message was not UTF-8")
            });
        }
    }
}
