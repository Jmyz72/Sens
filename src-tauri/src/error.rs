//! Structured application errors returned from Tauri commands.
//!
//! Every command returns `Result<T, AppError>`. `AppError` serializes to
//! `{ "code": "...", "message": "..." }` so the React layer can map errors to
//! form-level, field-level, or page-level states (see the design spec's Error
//! Handling section).

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Invalid input: empty name, non-positive amount, same-account transfer,
    /// category/kind mismatch, etc.
    #[error("{0}")]
    Validation(String),
    /// A referenced account, category, template, or transaction does not exist.
    #[error("{0}")]
    NotFound(String),
    /// Operation conflicts with current state, e.g. using an archived account.
    #[error("{0}")]
    Conflict(String),
    /// Unexpected persistence failure.
    #[error("{0}")]
    Database(String),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "ValidationError",
            AppError::NotFound(_) => "NotFound",
            AppError::Conflict(_) => "Conflict",
            AppError::Database(_) => "DatabaseError",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
