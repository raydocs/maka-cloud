/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::{DriverModel, FrozenCellKnowledge, FrozenNotification, HistorySource, RunError};
use maka_agent_facts::{
    context::ModelPurpose,
    durable::{ContentRef, FactId, RecordedFact, RunId, StepId},
    model::prompt::{ContentPart, Message, ToolOutput},
};
use maka_agent_state::fold::RunView;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex},
};

const PAGE: u32 = 256;
const MAX_ENTRIES: usize = 2_048;
const MAX_BYTES: usize = 2 * 1024 * 1024;

// Each driver owns a single live Run. The durable history can reconstruct all of
// these entries after a restart. Historical cuts and snapshots use their own reads.
#[derive(Default)]
pub(in crate::owner) struct ReplayCache {
    history: Mutex<HistoryPrefix>,
    steps: Mutex<BTreeMap<StepId, ModelPurpose>>,
    outputs: Mutex<ToolOutputs>,
}

#[derive(Default)]
struct HistoryPrefix {
    facts: Vec<Arc<RecordedFact>>,
    bytes: usize,
    full: bool,
}

#[derive(Default)]
struct ToolOutputs {
    entries: BTreeMap<(FactId, bool), Arc<ReplayedTool>>,
    bytes: usize,
}

pub(super) struct ReplayStep {
    pub purpose: ModelPurpose,
    pub steering: Vec<ContentRef>,
    pub notifications: Vec<FrozenNotification>,
    pub recovered_cells: Vec<FrozenCellKnowledge>,
}

pub(super) struct ReplayedTool {
    pub message: Message,
    pub requests_compaction: bool,
}

impl ReplayedTool {
    fn cache_bytes(&self) -> Option<usize> {
        use maka_agent_facts::model::prompt::ToolResult;
        let Message::Tool {
            content,
            provider_options,
        } = &self.message
        else {
            unreachable!("accepted tool replay produces a tool message");
        };
        let mut size = size_of::<Self>()
            + 2 * size_of::<usize>()
            + size_of::<((FactId, bool), Arc<Self>)>()
            + content.capacity() * size_of::<ToolResult>()
            + provider_options.as_ref().map_or(0, json_heap_bytes);
        for result in content {
            size += result.tool_call_id.capacity()
                + result.tool_name.capacity()
                + result.provider_options.as_ref().map_or(0, json_heap_bytes);
            size += match &result.output {
                ToolOutput::Text(text) | ToolOutput::ErrorText(text) => text.capacity(),
                ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => json_heap_bytes(value),
                ToolOutput::Content(parts) => {
                    let mut bytes = parts.capacity() * size_of::<ContentPart>();
                    for part in parts {
                        match part {
                            ContentPart::Text {
                                text,
                                provider_options,
                            } => {
                                bytes += text.capacity()
                                    + provider_options.as_ref().map_or(0, json_heap_bytes);
                            }
                            // Media remains bound to the live artifact read.
                            ContentPart::File { .. } => return None,
                        }
                    }
                    bytes
                }
            };
        }
        Some(size)
    }
}

fn json_heap_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.capacity(),
        Value::Array(items) => {
            items.capacity() * size_of::<Value>() + items.iter().map(json_heap_bytes).sum::<usize>()
        }
        Value::Object(fields) => {
            // The map hides its node capacity. Charge a full node per entry,
            // including room for links, even for partially filled nodes.
            const MAP_ENTRY: usize = 12 * size_of::<(String, Value)>() + 16 * size_of::<usize>();
            fields.len() * MAP_ENTRY
                + fields
                    .iter()
                    .map(|(key, value)| key.capacity() + json_heap_bytes(value))
                    .sum::<usize>()
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => 0,
    }
}

impl ReplayCache {
    pub(super) async fn tool_result(
        &self,
        key: Option<(FactId, bool)>,
        project: impl Future<Output = Result<Option<ReplayedTool>, RunError>>,
    ) -> Result<Option<Arc<ReplayedTool>>, RunError> {
        let cached = key.and_then(|key| self.outputs.lock().unwrap().entries.get(&key).cloned());
        if cached.is_some() {
            return Ok(cached);
        }

        let Some(projected) = project.await? else {
            return Ok(None);
        };
        let output = Arc::new(projected);
        if let Some(key) = key
            && let Some(bytes) = output.cache_bytes()
        {
            let mut cache = self.outputs.lock().unwrap();
            if cache.entries.len() < MAX_ENTRIES
                && bytes <= MAX_BYTES - cache.bytes
                && let std::collections::btree_map::Entry::Vacant(entry) = cache.entries.entry(key)
            {
                entry.insert(output.clone());
                cache.bytes += bytes;
            }
        }
        Ok(Some(output))
    }
}

impl DriverModel {
    pub(super) fn live_replay(&self, reader: &HistorySource<'_>, run: RunId) -> bool {
        run == self.execution.run_id && reader.as_snapshot().is_none()
    }

    pub(super) async fn replay_history(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        after: u64,
    ) -> Result<Vec<Arc<RecordedFact>>, RunError> {
        let remaining = view.revision.saturating_sub(after);
        if remaining == 0 {
            return Ok(Vec::new());
        }
        let limit = remaining.min(u64::from(PAGE)) as u32;
        let live = self.live_replay(reader, view.run);
        let remaining_budget = if live {
            let prefix = self.replay_cache.history.lock().unwrap();
            if after < prefix.facts.len() as u64 {
                let start = after as usize;
                let end = (start + limit as usize).min(prefix.facts.len());
                return Ok(prefix.facts[start..end].to_vec());
            }
            (!prefix.full && after == prefix.facts.len() as u64).then_some(MAX_BYTES - prefix.bytes)
        } else {
            None
        };

        let facts: Vec<_> = reader
            .history(view.run, after, limit)
            .await?
            .into_iter()
            .take_while(|fact| fact.revision <= view.revision)
            .map(Arc::new)
            .collect();
        if let Some(mut remaining) = remaining_budget {
            let mut retained = 0;
            for fact in facts.iter().take(MAX_ENTRIES - after as usize) {
                let bytes = serde_json::to_vec(&**fact).map_err(RunError::Json)?.len();
                let Some(rest) = remaining.checked_sub(bytes) else {
                    break;
                };
                remaining = rest;
                retained += 1;
            }
            let mut prefix = self.replay_cache.history.lock().unwrap();
            if !prefix.full && after == prefix.facts.len() as u64 {
                prefix.facts.extend(facts[..retained].iter().cloned());
                prefix.bytes = MAX_BYTES - remaining;
                prefix.full = retained < facts.len();
            }
        }
        Ok(facts)
    }

    pub(super) async fn replay_step(
        &self,
        reader: &HistorySource<'_>,
        run: RunId,
        step: StepId,
    ) -> Result<ReplayStep, RunError> {
        let live = self.live_replay(reader, run);
        if live && let Some(&purpose) = self.replay_cache.steps.lock().unwrap().get(&step) {
            return Ok(ReplayStep {
                purpose,
                steering: Vec::new(),
                notifications: Vec::new(),
                recovered_cells: Vec::new(),
            });
        }
        let request = reader.request(run, step).await?;
        let (notifications, recovered_cells) = if request.accounting.purpose == ModelPurpose::Main {
            let frozen = self.frozen_input(reader, run, &request).await?;
            (frozen.notifications, frozen.recovered_cells)
        } else {
            (Vec::new(), Vec::new())
        };
        let replay = ReplayStep {
            purpose: request.accounting.purpose,
            steering: request.steering,
            notifications,
            recovered_cells,
        };
        if live
            && replay.steering.is_empty()
            && replay.notifications.is_empty()
            && replay.recovered_cells.is_empty()
        {
            let mut steps = self.replay_cache.steps.lock().unwrap();
            if steps.len() < MAX_ENTRIES {
                steps.insert(step, replay.purpose);
            }
        }
        Ok(replay)
    }
}
