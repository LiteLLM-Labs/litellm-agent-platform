pub mod import_agents;
pub mod runtime;

use crate::sdk::{agents::AgentRuntime, providers::base::runtime::RuntimeAdapterRegistry};

pub(crate) fn register_runtime_adapters(registry: &mut RuntimeAdapterRegistry) {
    registry.register(
        AgentRuntime::ElasticAgentBuilder,
        runtime::RUNTIME_ID,
        runtime::ElasticAgentBuilderRuntime,
    );
}
