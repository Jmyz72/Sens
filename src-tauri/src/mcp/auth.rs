//! Bearer-token authentication for the embedded MCP server.
//!
//! Fails closed everywhere: a missing/empty configured hash, a poisoned lock,
//! a non-loopback peer, or any malformed header yields an empty-body 401.
//! The token and request headers are never logged.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Shared, swappable hex SHA-256 of the current token (empty = none set).
#[derive(Clone)]
pub struct AuthState {
    pub token_hash: Arc<RwLock<String>>,
}

/// Who called, from `Tailscale-User-Login`; `None` for tagged devices.
#[derive(Clone, Debug, PartialEq)]
pub struct CallerIdentity(pub Option<String>);

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 random bytes as 64 lowercase hex chars.
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    to_hex(&buf)
}

/// Hex SHA-256 of the token.
pub fn hash_token(t: &str) -> String {
    to_hex(&Sha256::digest(t.as_bytes()))
}

/// Constant-time comparison of the token's hash with the stored hash.
/// An empty stored hash never verifies.
pub fn verify(token: &str, stored_hash: &str) -> bool {
    if stored_hash.is_empty() {
        return false;
    }
    let computed = hash_token(token);
    let (a, b) = (computed.as_bytes(), stored_hash.as_bytes());
    // Length is not secret (both are fixed-size hex digests in practice).
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

fn unauthorized() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

/// Extracts the token from `Authorization: Bearer <token>` (scheme is
/// case-insensitive, the token is taken verbatim).
fn bearer_token(req: &Request) -> Option<&str> {
    let value = req.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

pub async fn require_token(
    State(state): State<AuthState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    if !peer.ip().to_canonical().is_loopback() {
        return unauthorized();
    }
    let Some(token) = bearer_token(&req) else {
        return unauthorized();
    };
    let ok = match state.token_hash.read() {
        Ok(stored) => verify(token, &stored),
        Err(_) => false,
    };
    if !ok {
        return unauthorized();
    }
    let identity = req
        .headers()
        .get("tailscale-user-login")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    req.extensions_mut().insert(CallerIdentity(identity));
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Extension;
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    const TOKEN: &str = "secret-token";

    fn state_with(token: &str) -> AuthState {
        let h = if token.is_empty() { String::new() } else { hash_token(token) };
        AuthState { token_hash: Arc::new(RwLock::new(h)) }
    }

    fn app(state: AuthState) -> Router {
        Router::new()
            .route(
                "/",
                get(|Extension(id): Extension<CallerIdentity>| async move {
                    id.0.unwrap_or_else(|| "none".into())
                }),
            )
            .layer(from_fn_with_state(state, require_token))
    }

    async fn call(
        state: AuthState,
        peer: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, String) {
        let mut b = Request::builder().uri("/");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let mut req = b.body(Body::empty()).unwrap();
        let addr: SocketAddr = peer.parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app(state).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    const LO: &str = "127.0.0.1:5555";

    #[tokio::test]
    async fn missing_header() {
        let (s, body) = call(state_with(TOKEN), LO, &[]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn wrong_scheme() {
        let h = format!("Basic {TOKEN}");
        let (s, _) = call(state_with(TOKEN), LO, &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (s, _) = call(state_with(TOKEN), LO, &[("authorization", TOKEN)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn lowercase_bearer_is_accepted_but_wrong_token_is_not() {
        for scheme in ["bearer", "BEARER", "Bearer"] {
            let h = format!("{scheme} {TOKEN}");
            let (s, _) = call(state_with(TOKEN), LO, &[("authorization", &h)]).await;
            assert_eq!(s, StatusCode::OK, "{scheme}");
        }
        let (s, _) = call(state_with(TOKEN), LO, &[("authorization", "bearer Secret-Token")]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (s, _) = call(state_with(TOKEN), LO, &[("authorization", "bearer nope")]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn trailing_space_token_rejected() {
        for h in [format!("Bearer {TOKEN} "), format!("Bearer  {TOKEN}")] {
            let (s, _) = call(state_with(TOKEN), LO, &[("authorization", &h)]).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{h:?}");
        }
    }

    #[tokio::test]
    async fn empty_token() {
        for h in ["Bearer ", "Bearer"] {
            let (s, _) = call(state_with(TOKEN), LO, &[("authorization", h)]).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{h:?}");
        }
    }

    #[tokio::test]
    async fn no_token_configured_rejects_everything() {
        for h in ["Bearer ", "Bearer x", "Bearer secret-token"] {
            let (s, _) = call(state_with(""), LO, &[("authorization", h)]).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{h:?}");
        }
        let (s, _) = call(state_with(""), LO, &[]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn valid_token_passes_and_exposes_identity() {
        let h = format!("Bearer {TOKEN}");
        let (s, body) = call(state_with(TOKEN), LO, &[("authorization", &h)]).await;
        assert_eq!((s, body.as_str()), (StatusCode::OK, "none"));
        let (s, body) = call(
            state_with(TOKEN),
            LO,
            &[("authorization", &h), ("tailscale-user-login", "me@example.com")],
        )
        .await;
        assert_eq!((s, body.as_str()), (StatusCode::OK, "me@example.com"));
    }

    #[tokio::test]
    async fn non_loopback_peer_rejected() {
        let h = format!("Bearer {TOKEN}");
        let (s, _) = call(state_with(TOKEN), "192.168.1.5:4000", &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        for ok in ["[::1]:4000", "[::ffff:127.0.0.1]:4000"] {
            let (s, _) = call(state_with(TOKEN), ok, &[("authorization", &h)]).await;
            assert_eq!(s, StatusCode::OK, "{ok}");
        }
        let (s, _) = call(state_with(TOKEN), "[::ffff:192.168.1.5]:4000", &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rotated_old_token_rejected() {
        let state = state_with(TOKEN);
        let h = format!("Bearer {TOKEN}");
        let (s, _) = call(state.clone(), LO, &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::OK);
        *state.token_hash.write().unwrap() = hash_token("new-token");
        let (s, _) = call(state.clone(), LO, &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (s, _) = call(state, LO, &[("authorization", "Bearer new-token")]).await;
        assert_eq!(s, StatusCode::OK);
    }

    #[tokio::test]
    async fn poisoned_lock_fails_closed() {
        let state = state_with(TOKEN);
        let lock = state.token_hash.clone();
        let _ = std::thread::spawn(move || {
            let _g = lock.write().unwrap();
            panic!("poison");
        })
        .join();
        let h = format!("Bearer {TOKEN}");
        let (s, _) = call(state, LO, &[("authorization", &h)]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn generate_token_is_64_hex_and_unique() {
        let (a, b) = (generate_token(), generate_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        assert_ne!(a, b);
    }

    #[test]
    fn hash_token_known_vector() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_behaviour() {
        let h = hash_token("abc");
        assert!(verify("abc", &h));
        assert!(!verify("abd", &h));
        assert!(!verify("abc", ""));
        assert!(!verify("", ""));
        assert!(!verify("abc", "short"));
    }
}
