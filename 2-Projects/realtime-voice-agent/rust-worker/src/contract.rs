//! 契约日志(逐字段对齐 Python pipeline/session.py):
//! `契约 {事件类名} turn={turn_id}`,journalctl grep '契约' 是运维排障的既定入口。
//!
//! turn_id 单槽语义(对齐 livekit_bridge.LiveKitEventBridge):
//! 只有一个 active_turn_id;ensure(prefix) 仅在空槽时生成 `{prefix}-{uuid_hex}`,
//! UserTurnCommitted 发出后清槽。用户/agent 事件在一个轮回内共享同一 id
//! (Python 的实际行为,quirk 也照抄——运维 grep 认这个形状)。

use tracing::info;
use uuid::Uuid;

#[derive(Default)]
pub struct Contract {
    active_turn_id: Option<String>,
}

impl Contract {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure(&mut self, prefix: &str) -> String {
        self.active_turn_id
            .get_or_insert_with(|| format!("{prefix}-{}", Uuid::new_v4().simple()))
            .clone()
    }

    fn emit(&mut self, event: &str, prefix: &str) {
        let id = self.ensure(prefix);
        info!("契约 {event} turn={id}");
    }

    pub fn user_speech_started(&mut self) {
        self.emit("UserSpeechStarted", "turn");
    }

    pub fn user_transcript_interim(&mut self) {
        self.emit("UserTranscriptInterim", "turn");
    }

    pub fn user_transcript_final(&mut self) {
        self.emit("UserTranscriptFinal", "turn");
    }

    /// 提交即清槽(bridge 同款)。
    pub fn user_turn_committed(&mut self) {
        self.emit("UserTurnCommitted", "turn");
        self.active_turn_id = None;
    }

    pub fn false_interruption(&mut self) {
        self.emit("FalseInterruption", "turn");
    }

    pub fn agent_speech_started(&mut self) {
        self.emit("AgentSpeechStarted", "agent");
    }

    pub fn agent_speech_stopped(&mut self) {
        self.emit("AgentSpeechStopped", "agent");
    }

    pub fn agent_transcript_final(&mut self) {
        self.emit("AgentTranscriptFinal", "agent");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_id_single_slot_cleared_on_commit() {
        let mut c = Contract::new();
        let a = c.ensure("turn");
        let b = c.ensure("agent"); // 槽已占,复用(bridge quirk 对齐)
        assert_eq!(a, b);
        c.user_turn_committed();
        let d = c.ensure("agent");
        assert_ne!(a, d);
        assert!(d.starts_with("agent-"));
    }
}
