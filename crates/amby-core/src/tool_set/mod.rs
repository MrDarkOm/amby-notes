//! One tool set for every Amby surface (docs/road/ai-panel-tools.md). Schemas live in
//! [`definitions`], read dispatch in [`reads`]; the `amby mcp` server, the desktop AI bridge and
//! the API providers all build their tool lists from here.

mod definitions;
mod reads;
#[cfg(test)]
mod tests;

pub use definitions::*;
pub use reads::*;

use serde_json::Value;

/// Every read-only tool the vault offers, in the `amby mcp` server's order and without
/// module filtering. The panel offers a subset (`ai_tools::panel_definitions`).
pub fn read_definitions() -> Vec<Value> {
    let mut tools = crate::ai_tools::mcp_definitions(true);
    tools.push(crate::ai_tools::list_tags_definition());
    tools.push(get_properties_definition());
    tools.extend(notes_read_definitions());
    tools.extend(extra_read_definitions());
    tools.extend(
        DOMAIN_READS.iter().map(|(name, description, fields, _)| {
            domain_definition(name, description, fields, true)
        }),
    );
    tools
}

/// The shared definition of a read-only tool.
pub fn definition_of(name: &str) -> Option<Value> {
    read_definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
}
