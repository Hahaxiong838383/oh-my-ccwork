//! agent worker 注册用 JWT。
//!
//! livekit-api 0.6.3 的 `VideoGrants` 缺 `agent` 字段(Python SDK 有),故自签:
//! claims 形状对照 Python `api.AccessToken(...).with_grants(VideoGrants(agent=True))`
//! —— HS256,iss=api_key,video.agent=true。server 只校验 iss/exp/nbf/video.agent。

use anyhow::Result;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;

#[derive(Serialize, Default)]
struct VideoGrants {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    agent: bool,
    #[serde(rename = "roomCreate", skip_serializing_if = "std::ops::Not::not")]
    room_create: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    room: String,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    sub: &'a str,
    iat: u64,
    nbf: u64,
    exp: u64,
    video: VideoGrants,
}

pub fn agent_join_jwt(api_key: &str, api_secret: &str) -> Result<String> {
    sign(api_key, api_secret, VideoGrants { agent: true, ..Default::default() })
}

/// 服务端 API 令牌(DeleteRoom 等 RoomService 调用需 roomCreate 授权)。
pub fn server_api_jwt(api_key: &str, api_secret: &str, room: &str) -> Result<String> {
    sign(
        api_key,
        api_secret,
        VideoGrants { room_create: true, room: room.to_string(), ..Default::default() },
    )
}

fn sign(api_key: &str, api_secret: &str, video: VideoGrants) -> Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let claims = Claims { iss: api_key, sub: "", iat: now, nbf: now, exp: now + 3600, video };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    #[derive(serde::Deserialize)]
    struct RoundTrip {
        iss: String,
        video: serde_json::Value,
    }

    #[test]
    fn jwt_carries_agent_grant() {
        let jwt = agent_join_jwt("key1", "secret1").unwrap();
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = true;
        v.required_spec_claims.clear();
        let data =
            decode::<RoundTrip>(&jwt, &DecodingKey::from_secret(b"secret1"), &v).unwrap();
        assert_eq!(data.claims.iss, "key1");
        assert_eq!(data.claims.video["agent"], serde_json::Value::Bool(true));
    }
}
