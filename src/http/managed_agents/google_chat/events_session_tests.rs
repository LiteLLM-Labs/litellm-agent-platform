use super::space_session_fallback_key;
use crate::http::managed_agents::google_chat::types::{
    GoogleChatIncomingMessage, GoogleChatMessageMode,
};

#[test]
fn threaded_channel_messages_can_fallback_to_space_session() {
    let message = incoming(GoogleChatMessageMode::ChannelMessage);

    assert_eq!(space_session_fallback_key(&message), Some("spaces/AAA"));
}

#[test]
fn fallback_skips_direct_messages_mentions_and_unthreaded_messages() {
    assert_eq!(
        space_session_fallback_key(&incoming(GoogleChatMessageMode::DirectMessage)),
        None
    );
    assert_eq!(
        space_session_fallback_key(&incoming(GoogleChatMessageMode::ChannelMention)),
        None
    );

    let mut message = incoming(GoogleChatMessageMode::ChannelMessage);
    message.thread_name = None;
    message.conversation_key = message.space_name.clone();

    assert_eq!(space_session_fallback_key(&message), None);
}

fn incoming(mode: GoogleChatMessageMode) -> GoogleChatIncomingMessage {
    GoogleChatIncomingMessage {
        message_name: "spaces/AAA/messages/msg-xyz".to_owned(),
        space_name: "spaces/AAA".to_owned(),
        thread_name: Some("spaces/AAA/threads/thread-1".to_owned()),
        conversation_key: "spaces/AAA/threads/thread-1".to_owned(),
        user_name: Some("users/human-1".to_owned()),
        prompt: "hello".to_owned(),
        mode,
    }
}
