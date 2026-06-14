use tokio::sync::OwnedMutexGuard;

use crate::agents::locks::KeyedLockStore;

pub(super) struct GoogleChatPromptLock {
    _guard: OwnedMutexGuard<()>,
}

impl GoogleChatPromptLock {
    pub(super) async fn acquire(locks: &KeyedLockStore, session_id: &str) -> Self {
        Self {
            _guard: locks
                .lock(&format!("google_chat_prompt:{session_id}"))
                .await,
        }
    }
}
