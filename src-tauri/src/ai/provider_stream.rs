//! Incremental provider stream decoding. The normalized calls are consumed by
//! the turn loop, never executed by the webview.
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
    structured_arguments: Option<Value>,
}

pub(super) struct StreamDecoder {
    family: String,
    buffer: Vec<u8>,
    content: String,
    thinking: String,
    calls: BTreeMap<usize, PendingCall>,
    received: usize,
}

impl StreamDecoder {
    pub fn new(family: &str) -> Self {
        Self {
            family: family.into(),
            buffer: Vec::new(),
            content: String::new(),
            thinking: String::new(),
            calls: BTreeMap::new(),
            received: 0,
        }
    }

    /// Return only text newly received in this chunk. JSON is buffered as bytes
    /// so a network split inside a UTF-8 character cannot corrupt the response.
    pub fn push(&mut self, bytes: &[u8]) -> Result<String, &'static str> {
        self.received = self.received.saturating_add(bytes.len());
        if self.received > super::MAX_RESPONSE_BYTES {
            return Err("invalidResponse");
        }
        self.buffer.extend_from_slice(bytes);
        let mut emitted = String::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "invalidResponse")?
                .trim();
            let data = if self.family == "ollama" {
                line
            } else {
                match line.strip_prefix("data:") {
                    Some(data) => data.trim(),
                    None => continue,
                }
            };
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let frame: Value = serde_json::from_str(data).map_err(|_| "invalidResponse")?;
            self.frame(&frame, &mut emitted)?;
        }
        Ok(emitted)
    }

    fn frame(&mut self, frame: &Value, emitted: &mut String) -> Result<(), &'static str> {
        if frame.get("error").is_some()
            || frame.get("type").and_then(Value::as_str) == Some("error")
        {
            return Err("invalidResponse");
        }
        if self.family == "anthropic" {
            let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
            let index = frame.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if kind == "content_block_start" {
                let block = &frame["content_block"];
                if block["type"] == "text" {
                    if let Some(text) = block["text"].as_str() {
                        self.append_text(text, emitted);
                    }
                }
                if block["type"] == "tool_use" {
                    let call = self.calls.entry(index).or_default();
                    call.id = block["id"].as_str().unwrap_or("").into();
                    call.name = block["name"].as_str().unwrap_or("").into();
                    if block["input"].is_object()
                        && block["input"]
                            .as_object()
                            .is_some_and(|value| !value.is_empty())
                    {
                        call.structured_arguments = Some(block["input"].clone());
                    }
                }
            } else if kind == "content_block_delta" {
                let delta = &frame["delta"];
                if let Some(text) = delta["text"].as_str() {
                    self.append_text(text, emitted);
                }
                if let Some(part) = delta["partial_json"].as_str() {
                    self.calls
                        .entry(index)
                        .or_default()
                        .arguments
                        .push_str(part);
                }
            }
        } else if self.family == "ollama" {
            let message = &frame["message"];
            if let Some(text) = message["content"].as_str() {
                self.append_text(text, emitted);
            }
            if let Some(thinking) = message["thinking"].as_str() {
                self.thinking.push_str(thinking);
            }
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    let index = self.calls.len();
                    self.add_call(index, call);
                }
            }
        } else {
            let delta = &frame["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                self.append_text(text, emitted);
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    let index = call["index"].as_u64().ok_or("invalidResponse")? as usize;
                    self.add_call(index, call);
                }
            }
        }
        if self.calls.len() > 32 {
            return Err("invalidResponse");
        }
        Ok(())
    }

    fn add_call(&mut self, index: usize, delta: &Value) {
        let call = self.calls.entry(index).or_default();
        if let Some(id) = delta["id"].as_str() {
            call.id.push_str(id);
        }
        let function = &delta["function"];
        if let Some(name) = function["name"].as_str() {
            call.name.push_str(name);
        }
        if let Some(arguments) = function.get("arguments") {
            if let Some(part) = arguments.as_str() {
                call.arguments.push_str(part);
            } else if arguments.is_object() {
                call.structured_arguments = Some(arguments.clone());
            }
        }
    }

    fn append_text(&mut self, text: &str, emitted: &mut String) {
        self.content.push_str(text);
        emitted.push_str(text);
    }

    pub fn finish(mut self) -> Result<(String, Vec<ToolCall>, String), &'static str> {
        if !self.buffer.is_empty() {
            self.push(b"\n")?;
        }
        let calls = self
            .calls
            .into_iter()
            .map(|(index, call)| {
                if call.name.is_empty() {
                    return Err("invalidResponse");
                }
                let arguments = if !call.arguments.is_empty() {
                    serde_json::from_str(&call.arguments).map_err(|_| "invalidResponse")?
                } else {
                    call.structured_arguments.unwrap_or_else(|| json!({}))
                };
                if !arguments.is_object() {
                    return Err("invalidResponse");
                }
                Ok(ToolCall {
                    id: if call.id.is_empty() {
                        format!("call_{index}")
                    } else {
                        call.id
                    },
                    name: call.name,
                    arguments,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((self.content, calls, self.thinking))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ai1_p1_openai_stream_assembles_utf8_and_fragmented_calls() {
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"ёж\",\"tool_calls\":[{\"index\":0,\"id\":\"id\",\"function\":{\"name\":\"read_\",\"arguments\":\"{\\\"id\\\":\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"note\",\"arguments\":\"\\\"a\\\"}\"}}]}}]}\n\n";
        let mut decoder = StreamDecoder::new("openai");
        for byte in stream.as_bytes() {
            decoder.push(&[*byte]).unwrap();
        }
        let (content, calls, _) = decoder.finish().unwrap();
        assert_eq!(content, "ёж");
        assert_eq!(
            calls,
            vec![ToolCall {
                id: "id".into(),
                name: "read_note".into(),
                arguments: json!({"id":"a"})
            }]
        );
    }
    #[test]
    fn ai1_p1_anthropic_and_ollama_tool_calls() {
        let mut anthropic = StreamDecoder::new("anthropic");
        anthropic.push(b"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"read_note\",\"input\":{}}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"id\\\":\\\"a\\\"}\"}}\n\n").unwrap();
        assert_eq!(
            anthropic.finish().unwrap().1[0].arguments,
            json!({"id":"a"})
        );
        let mut ollama = StreamDecoder::new("ollama");
        ollama.push(b"{\"message\":{\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"read_note\",\"arguments\":{\"id\":\"a\"}}}]}}\n").unwrap();
        assert_eq!(ollama.finish().unwrap().1[0].arguments, json!({"id":"a"}));
    }

    #[test]
    fn ai1_p1_ollama_accumulates_parallel_calls_across_chunks() {
        let mut decoder = StreamDecoder::new("ollama");
        decoder.push(b"{\"message\":{\"thinking\":\"step\",\"tool_calls\":[{\"function\":{\"name\":\"read_note\",\"arguments\":{\"id\":\"a\"}}}]}}\n").unwrap();
        decoder.push(b"{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"read_note\",\"arguments\":{\"id\":\"b\"}}}]}}\n").unwrap();
        let (_, calls, thinking) = decoder.finish().unwrap();
        assert_eq!(thinking, "step");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].arguments, json!({"id":"a"}));
        assert_eq!(calls[1].arguments, json!({"id":"b"}));
    }
}
