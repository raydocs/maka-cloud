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

use crate::{Error, client::Client};
use futures_util::future::{BoxFuture, FutureExt, Shared, WeakShared};
use maka_settings_native::contract::{DefaultModel, ModelChoice, ModelsPage};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    future::Future,
    sync::{Arc, Mutex},
};

const MAX_ATTEMPTS: usize = 4;

pub(crate) struct Catalog {
    pub choices: Vec<ModelChoice>,
    pub default: DefaultModel,
}

type Read = BoxFuture<'static, Result<Arc<Catalog>, Arc<dyn std::error::Error + Send + Sync>>>;

#[derive(Default)]
pub(crate) struct Reader {
    pending: Mutex<Option<WeakShared<Read>>>,
    active: tokio::sync::Mutex<()>,
}

impl Reader {
    pub async fn read(&self, client: &Client) -> Result<Arc<Catalog>, Error> {
        let flight = {
            let mut pending = self.pending.lock().unwrap();
            if let Some(flight) = pending.as_ref().and_then(WeakShared::upgrade) {
                flight
            } else {
                let client = client.clone();
                let flight: Shared<Read> = async move {
                    let reader = client.model_reader();
                    let _active = reader.active.lock().await;
                    // Readers arriving after this point need a new read, even
                    // if this snapshot has yet to reach its current callers.
                    *reader.pending.lock().unwrap() = None;
                    read(|input| client.query("settings", "models", input))
                        .await
                        .map(Arc::new)
                        .map_err(Arc::from)
                }
                .boxed()
                .shared();
                *pending = flight.downgrade();
                flight
            }
        };
        flight.await.map_err(|error| Box::new(error) as Error)
    }
}

pub(super) fn identity(choice: &ModelChoice) -> String {
    serde_json::to_string(&(&choice.selection.connection_id, &choice.selection.model_id))
        .expect("model identity")
}
async fn read<F>(mut page: impl FnMut(Value) -> F) -> Result<Catalog, Error>
where
    F: Future<Output = Result<ModelsPage, Error>>,
{
    for _ in 0..MAX_ATTEMPTS {
        let mut input = json!({"kind":"start"});
        let mut choices = Vec::new();
        let mut seen = HashSet::new();
        while let ModelsPage::Ready {
            revision,
            choices: current,
            default_model,
            next,
        } = page(input).await?
        {
            choices.extend(current);
            let Some(cursor) = next else {
                return Ok(Catalog {
                    choices,
                    default: *default_model,
                });
            };
            if !seen.insert(serde_json::to_string(&cursor)?) {
                return Err("Model catalog cursor repeated".into());
            }
            input = json!({"kind":"continue", "revision":revision, "cursor":cursor});
        }
    }
    Err("Model catalog changed; retry the configuration request".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::configuration::ModelSelection;
    use maka_settings_native::contract::ModelCursor;
    use std::future;

    fn ready(revision: u64, label: &str, next: Option<ModelCursor>) -> ModelsPage {
        ModelsPage::Ready {
            revision,
            choices: vec![ModelChoice {
                tools: None,
                limits: None,
                selection: ModelSelection {
                    connection_id: "provider".into(),
                    model_id: label.into(),
                    service_tier: None,
                },
                connection_name: "Provider".into(),
                label: label.into(),
                thinking_levels: vec![],
                default_thinking_level: None,
            }],
            default_model: Box::new(DefaultModel::None),
            next,
        }
    }

    fn next() -> ModelCursor {
        ModelCursor {
            connection_id: None,
            query: String::new(),
            connection: 0,
            model: 1,
        }
    }

    #[tokio::test]
    async fn changed_catalog_restarts_without_leaking_choices_from_the_old_revision() {
        let mut exchange = [
            (json!({"kind":"start"}), ready(1, "withdrawn", Some(next()))),
            (
                json!({"kind":"continue", "revision":1, "cursor":next()}),
                ModelsPage::Changed { revision: 2 },
            ),
            (json!({"kind":"start"}), ready(2, "alpha", Some(next()))),
            (
                json!({"kind":"continue", "revision":2, "cursor":next()}),
                ready(2, "beta", None),
            ),
        ]
        .into_iter();
        let catalog = read(|input| {
            let (request, response) = exchange.next().expect("unexpected model page request");
            assert_eq!(input, request);
            future::ready(Ok(response))
        })
        .await
        .unwrap();
        let labels: Vec<_> = catalog.choices.iter().map(|choice| &choice.label).collect();
        assert_eq!(labels, ["alpha", "beta"]);
    }

    #[tokio::test]
    async fn catalog_that_keeps_changing_fails_after_four_attempts() {
        let mut revision = 1;
        let error = read(|input| {
            assert!(revision <= 4, "catalog retry limit exceeded");
            if input == json!({"kind":"start"}) {
                return future::ready(Ok(ready(revision, "moving", Some(next()))));
            }
            assert_eq!(
                input,
                json!({"kind":"continue", "revision":revision, "cursor":next()})
            );
            revision += 1;
            future::ready(Ok(ModelsPage::Changed { revision }))
        })
        .await
        .err()
        .expect("four changing snapshots must fail");
        assert_eq!(revision, 5);
        assert_eq!(
            error.to_string(),
            "Model catalog changed; retry the configuration request"
        );
    }
}
