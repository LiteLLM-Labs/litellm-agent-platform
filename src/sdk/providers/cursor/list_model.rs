use crate::sdk::{
    agents::{AgentRuntime, Lap, ListModelsParams},
    providers::base::models::{
        list_openai_shape, ModelEndpoint, ModelListFuture,
    },
};

pub(crate) struct CursorModels;

impl ModelEndpoint for CursorModels {
    fn list_models<'a>(
        &'a self,
        client: &'a Lap,
        _params: ListModelsParams,
    ) -> ModelListFuture<'a> {
        Box::pin(async move {
            list_openai_shape(client, AgentRuntime::Cursor, AgentRuntime::Cursor.as_str()).await
        })
    }
}
