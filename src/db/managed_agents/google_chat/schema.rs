use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct GoogleChatSpaceSessionRow {
    pub agent_id: String,
    pub conversation_key: String,
    pub session_id: String,
    pub space_name: String,
    pub thread_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
