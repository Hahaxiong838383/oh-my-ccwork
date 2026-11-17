//! Local admission only. The Brain still authenticates the Worker and checks
//! the live device registry/exclusion on every task; a room name is not authority.
pub fn enabled(enabled: &str, scope: &str, allowlist: &str, room: &str, agent: &str) -> bool {
    let Some((sn, suffix)) = room.strip_prefix("sn-").and_then(|s| s.split_once('-')) else { return false; };
    if enabled != "1" || sn.len() != 20 || !sn.starts_with("BJP003")
        || !sn.as_bytes()[6..].iter().all(u8::is_ascii_digit)
        || suffix.is_empty() || suffix.len() > 20 || !suffix.bytes().all(|b| b.is_ascii_digit()) { return false; }
    match scope {
        "allowlist" => allowlist.split(',').any(|s| s.trim() == sn),
        "all_registered" => agent == "rust-worker",
        _ => false,
    }
}
pub fn for_room(room: &str) -> bool {
    enabled(&std::env::var("P003_SEARCH_ENABLED").unwrap_or_default(),
        &std::env::var("P003_SEARCH_SCOPE").unwrap_or_else(|_| "allowlist".into()),
        &std::env::var("P003_SEARCH_DEVICE_ALLOWLIST").unwrap_or_default(), room,
        &std::env::var("AGENT_NAME").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::enabled;
    const ROOM: &str = "sn-BJP00326070803800006-123";
    #[test]
    fn existing_allowlist_is_closed_when_empty_or_not_targeted() {
        assert!(enabled("1", "allowlist", "BJP00326070803800006", ROOM, "p003-search-canary-20261021"));
        assert!(!enabled("1", "allowlist", "", ROOM, "rust-worker"));
        assert!(!enabled("1", "allowlist", "BJP00326060100100004", ROOM, "rust-worker"));
    }
    #[test]
    fn explicit_p1_mode_includes_existing_and_future_device_rooms() {
        for room in [ROOM, "sn-BJP00326102700100005-123"] {
            assert!(enabled("1", "all_registered", "", room, "rust-worker"));
        }
        for room in ["probe", "sn-03800006-123", "sn-BJP00326070803800006-x", "sn-BJP00326070803800006-", "sn-BJP00326070803800006-123456789012345678901"] {
            assert!(!enabled("1", "all_registered", "", room, "rust-worker"));
        }
    }
    #[test]
    fn p2_and_verification_cannot_inherit_all_registered() {
        for agent in ["p003-search-canary-20261021", "p003-search-verification-20261026", "other-worker"] {
            assert!(!enabled("1", "all_registered", "", ROOM, agent));
        }
        assert!(!enabled("0", "all_registered", "", ROOM, "rust-worker"));
        assert!(!enabled("1", "typo", "BJP00326070803800006", ROOM, "rust-worker"));
    }
}
