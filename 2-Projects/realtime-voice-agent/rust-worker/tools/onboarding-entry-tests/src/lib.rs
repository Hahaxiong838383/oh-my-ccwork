#[path = "../../../src/control.rs"]
pub mod control;
#[path = "../../../src/voice_onboarding.rs"]
pub mod voice_onboarding;

// Only the unrelated canary metrics carrier is stubbed to avoid linking RTC in this entry harness.
// No onboarding, control parsing, transport, or database behavior is mocked.
pub mod playout {
    #[derive(Default)]
    pub struct FinalStats {
        pub played_frames: u64,
        pub underrun_count: u64,
        pub underrun_ms: u64,
        pub buffered_audio_ms: i64,
        pub first_underrun_ms: i64,
        pub completed: bool,
    }
}
