//! 火山语音二进制帧协议(规格 = doubao_speech._ws_client,字段级对齐)。
//!
//! 帧 = 4 字节头 `[ver<<4|hdr_size, type<<4|flag, ser<<4|comp, 0x00]`
//!   + 可选字段(顺序敏感): WithEvent→event(i32be)+session_id(u32be len+bytes,连接级事件不带);
//!     Error→error_code(u32be); Pos/NegSeq→sequence(i32be)
//!   + payload(u32be len + bytes)。

use anyhow::{bail, Result};

pub const ASR_URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
pub const TTS_URL: &str = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MsgType {
    Invalid = 0,
    FullClientRequest = 0b0001,
    AudioOnlyClient = 0b0010,
    FullServerResponse = 0b1001,
    AudioOnlyServer = 0b1011,
    FrontEndResultServer = 0b1100,
    Error = 0b1111,
}

impl MsgType {
    fn from_u8(v: u8) -> Self {
        match v {
            0b0001 => Self::FullClientRequest,
            0b0010 => Self::AudioOnlyClient,
            0b1001 => Self::FullServerResponse,
            0b1011 => Self::AudioOnlyServer,
            0b1100 => Self::FrontEndResultServer,
            0b1111 => Self::Error,
            _ => Self::Invalid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Flags {
    NoSeq = 0b0000,
    PositiveSeq = 0b0001,
    LastNoSeq = 0b0010,
    NegativeSeq = 0b0011,
    WithEvent = 0b0100,
}

impl Flags {
    fn from_u8(v: u8) -> Self {
        match v {
            0b0001 => Self::PositiveSeq,
            0b0010 => Self::LastNoSeq,
            0b0011 => Self::NegativeSeq,
            0b0100 => Self::WithEvent,
            _ => Self::NoSeq,
        }
    }
}

/// 事件码(TTS 双向流用;ASR 不走 WithEvent)。协议常量保持全集,允许未引用。
#[allow(dead_code)]
pub mod event {
    pub const NONE: i32 = 0;
    pub const START_CONNECTION: i32 = 1;
    pub const FINISH_CONNECTION: i32 = 2;
    pub const CONNECTION_STARTED: i32 = 50;
    pub const CONNECTION_FAILED: i32 = 51;
    pub const CONNECTION_FINISHED: i32 = 52;
    pub const START_SESSION: i32 = 100;
    pub const FINISH_SESSION: i32 = 102;
    pub const SESSION_STARTED: i32 = 150;
    pub const SESSION_FINISHED: i32 = 152;
    pub const SESSION_FAILED: i32 = 153;
    pub const TASK_REQUEST: i32 = 200;
    pub const TTS_SENTENCE_START: i32 = 350;
    pub const TTS_SENTENCE_END: i32 = 351;
    pub const TTS_RESPONSE: i32 = 352;
    pub const TTS_ENDED: i32 = 359;
}

fn is_connection_event(ev: i32) -> bool {
    matches!(ev, 1 | 2 | 50 | 51 | 52)
}

pub const SER_JSON: u8 = 0b0001;
pub const COMP_NONE: u8 = 0;
pub const COMP_GZIP: u8 = 0b0001;

#[derive(Debug, Clone)]
pub struct Frame {
    pub msg_type: MsgType,
    pub flag: Flags,
    pub serialization: u8,
    pub compression: u8,
    pub event: i32,
    pub session_id: String,
    pub sequence: i32,
    pub error_code: u32,
    pub payload: Vec<u8>,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            msg_type: MsgType::Invalid,
            flag: Flags::NoSeq,
            serialization: SER_JSON,
            compression: COMP_NONE,
            event: 0,
            session_id: String::new(),
            sequence: 0,
            error_code: 0,
            payload: Vec::new(),
        }
    }
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.pos + n > self.data.len() {
            bail!("frame truncated at offset {}+{n}", self.pos);
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }
}

fn has_sequence_field(t: MsgType, f: Flags) -> bool {
    matches!(f, Flags::PositiveSeq | Flags::NegativeSeq)
        && matches!(
            t,
            MsgType::FullClientRequest
                | MsgType::FullServerResponse
                | MsgType::FrontEndResultServer
                | MsgType::AudioOnlyClient
                | MsgType::AudioOnlyServer
        )
}

impl Frame {
    pub fn marshal(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(16 + self.payload.len());
        buf.push((1 << 4) | 1); // version=1, header_size=1(*4=4B)
        buf.push(((self.msg_type as u8) << 4) | (self.flag as u8));
        buf.push((self.serialization << 4) | self.compression);
        buf.push(0x00);

        if self.flag == Flags::WithEvent {
            buf.extend_from_slice(&self.event.to_be_bytes());
            if !is_connection_event(self.event) {
                let sid = self.session_id.as_bytes();
                buf.extend_from_slice(&(sid.len() as u32).to_be_bytes());
                buf.extend_from_slice(sid);
            }
        }
        if self.msg_type == MsgType::Error {
            buf.extend_from_slice(&self.error_code.to_be_bytes());
        } else if has_sequence_field(self.msg_type, self.flag) {
            buf.extend_from_slice(&self.sequence.to_be_bytes());
        }
        buf.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }

    pub fn unmarshal(data: &[u8]) -> Result<Self> {
        if data.len() < 4 {
            bail!("frame too short: {}", data.len());
        }
        let header_size = ((data[0] & 0x0F) as usize) * 4;
        if header_size < 4 || data.len() < header_size {
            bail!("invalid header_size {header_size}");
        }
        let mut f = Frame {
            msg_type: MsgType::from_u8(data[1] >> 4),
            flag: Flags::from_u8(data[1] & 0x0F),
            serialization: data[2] >> 4,
            compression: data[2] & 0x0F,
            ..Default::default()
        };
        let mut cur = Cursor { data, pos: header_size };

        if f.flag == Flags::WithEvent {
            f.event = i32::from_be_bytes(cur.take(4)?.try_into()?);
            if !is_connection_event(f.event) {
                let n = u32::from_be_bytes(cur.take(4)?.try_into()?) as usize;
                if n > 0 {
                    f.session_id = String::from_utf8_lossy(cur.take(n)?).into_owned();
                }
            } else if f.msg_type == MsgType::FullServerResponse {
                // 服务端连接级事件带 connect_id(len+bytes),读掉不存
                if cur.remaining() >= 4 {
                    let n = u32::from_be_bytes(cur.take(4)?.try_into()?) as usize;
                    if n > 0 {
                        let _ = cur.take(n)?;
                    }
                }
            }
        }
        if f.msg_type == MsgType::Error {
            f.error_code = u32::from_be_bytes(cur.take(4)?.try_into()?);
        } else if has_sequence_field(f.msg_type, f.flag) {
            f.sequence = i32::from_be_bytes(cur.take(4)?.try_into()?);
        }
        if cur.remaining() >= 4 {
            let n = u32::from_be_bytes(cur.take(4)?.try_into()?) as usize;
            if n > 0 {
                f.payload = cur.take(n)?.to_vec();
            }
        }
        Ok(f)
    }

    /// payload 解 JSON(处理 gzip);空/解析失败 → None。
    pub fn json_payload(&self) -> Option<serde_json::Value> {
        if self.payload.is_empty() {
            return None;
        }
        let raw: Vec<u8> = if self.compression == COMP_GZIP {
            use std::io::Read;
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(&self.payload[..]).read_to_end(&mut out).ok()?;
            out
        } else {
            self.payload.clone()
        };
        serde_json::from_slice(&raw).ok()
    }
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data).ok();
    enc.finish().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 Python Message.marshal 的字节级对拍:
    /// Message(FullClientRequest, PositiveSeq, JSON, Gzip, sequence=1, payload=b"ab")
    /// 头 [0x11, 0x11, 0x11, 0x00] + seq 00000001 + len 00000002 + b"ab"
    #[test]
    fn marshal_matches_python_bytes() {
        let f = Frame {
            msg_type: MsgType::FullClientRequest,
            flag: Flags::PositiveSeq,
            serialization: SER_JSON,
            compression: COMP_GZIP,
            sequence: 1,
            payload: b"ab".to_vec(),
            ..Default::default()
        };
        let b = f.marshal();
        assert_eq!(
            b,
            vec![0x11, 0x11, 0x11, 0x00, 0, 0, 0, 1, 0, 0, 0, 2, b'a', b'b']
        );
    }

    #[test]
    fn with_event_session_roundtrip() {
        let f = Frame {
            msg_type: MsgType::FullClientRequest,
            flag: Flags::WithEvent,
            event: event::START_SESSION,
            session_id: "s1".into(),
            payload: b"{}".to_vec(),
            ..Default::default()
        };
        let parsed = Frame::unmarshal(&f.marshal()).unwrap();
        assert_eq!(parsed.event, event::START_SESSION);
        assert_eq!(parsed.session_id, "s1");
        assert_eq!(parsed.payload, b"{}");
    }

    #[test]
    fn connection_event_omits_session() {
        let f = Frame {
            msg_type: MsgType::FullClientRequest,
            flag: Flags::WithEvent,
            event: event::START_CONNECTION,
            session_id: "ignored".into(),
            payload: b"{}".to_vec(),
            ..Default::default()
        };
        let b = f.marshal();
        // 头4 + event4 + len4 + 2 = 14(无 session_id 段)
        assert_eq!(b.len(), 14);
    }

    #[test]
    fn negative_seq_roundtrip() {
        let f = Frame {
            msg_type: MsgType::AudioOnlyClient,
            flag: Flags::NegativeSeq,
            sequence: -5,
            compression: COMP_GZIP,
            payload: vec![1, 2, 3],
            ..Default::default()
        };
        let parsed = Frame::unmarshal(&f.marshal()).unwrap();
        assert_eq!(parsed.sequence, -5);
        assert_eq!(parsed.payload, vec![1, 2, 3]);
    }

    #[test]
    fn gzip_json_payload_roundtrip() {
        let f = Frame {
            msg_type: MsgType::FullServerResponse,
            flag: Flags::PositiveSeq,
            compression: COMP_GZIP,
            sequence: 2,
            payload: gzip(br#"{"k":1}"#),
            ..Default::default()
        };
        let v = f.json_payload().unwrap();
        assert_eq!(v["k"], 1);
    }
}
