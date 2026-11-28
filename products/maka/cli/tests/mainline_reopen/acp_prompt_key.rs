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

use super::*;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream};

type Wire<T = DuplexStream> = BufReader<T>;

async fn frame(wire: &mut Wire<impl AsyncRead + Unpin>) -> Value {
    let mut line = String::new();
    assert_ne!(wire.read_line(&mut line).await.unwrap(), 0, "ACP EOF");
    serde_json::from_str(&line).unwrap()
}

async fn rpc(
    wire: &mut Wire<impl AsyncRead + AsyncWrite + Unpin>,
    id: u64,
    method: &str,
    params: Value,
) -> (Value, Vec<Value>) {
    write_frame(
        wire,
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    )
    .await;
    let (reply, notes) = response(wire).await;
    assert_eq!(reply["id"], id, "{reply}");
    (reply, notes)
}

async fn write_frame(wire: &mut (impl AsyncWrite + Unpin), request: Value) {
    wire.write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
}

async fn response(wire: &mut Wire<impl AsyncRead + Unpin>) -> (Value, Vec<Value>) {
    let mut notifications = vec![];
    loop {
        let reply = frame(wire).await;
        if reply.get("id").is_some() {
            return (reply, notifications);
        }
        notifications.push(reply);
    }
}

async fn connect(
    client: Client,
    stop: &CancellationToken,
) -> (Wire, tokio::task::JoinHandle<Result<(), maka_acp::Error>>) {
    let (wire, acp) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(acp);
    let facade = tokio::spawn(maka_acp::serve(client, read, write, stop.clone()));
    let mut wire = BufReader::new(wire);
    let (init, _) = rpc(
        &mut wire,
        1,
        "initialize",
        json!({"protocolVersion":2,"info":{"name":"retry-test","version":"1"}}),
    )
    .await;
    assert_eq!(init["result"]["protocolVersion"], 2, "{init}");
    (wire, facade)
}

async fn configure(client: &Client, connection: &str) {
    configure_model(client, connection, "gpt-4.1-mini").await;
}

async fn configure_model(client: &Client, connection: &str, model: &str) {
    host_load_stress::save_credential(client, connection).await;
    let catalog = call(
        client,
        "settings",
        "connections",
        json!({"kind":"start"}),
        Attachments::new(),
    )
    .await;
    let saved = call(
        client,
        "settings",
        "setDefault",
        json!({"expectedCatalogRevision":catalog["revision"],
                    "target":{"connectionId":connection,"modelId":model}}),
        Attachments::new(),
    )
    .await;
    assert_eq!(saved["kind"], "committed", "{saved}");
}

#[cfg(unix)]
#[tokio::test]
async fn acp_mixed_tool_burst_completes_in_both_calling_modes() {
    for code_mode in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), mixed_tool_burst(code_mode))
            .await
            .unwrap_or_else(|_| panic!("tool burst timed out, code_mode={code_mode}"));
    }
}

#[cfg(unix)]
async fn mixed_tool_burst(code_mode: bool) {
    let sandbox = Sandbox::new().await.unwrap();
    tokio::fs::write(sandbox.workspace.join("large.txt"), vec![b'x'; 512 * 1024])
        .await
        .unwrap();
    tokio::fs::write(sandbox.workspace.join("seed.txt"), "burst input\n")
        .await
        .unwrap();
    let batch: Vec<_> = (0..16).map(|slot| match slot {
        0 => ("Shell", json!({"command":"printf 'burst-output-start\n'; cat large.txt; printf '\nburst-output-end\n'","title":"large output"})),
        1 | 5 | 9 | 13 => ("Read", json!({"path":"seed.txt"})),
        2 | 6 | 10 | 14 => ("ApplyPatch", json!({"patch":format!(
            "*** Begin Patch\n*** Add File: patched-{slot}.txt\n+patched-{slot}\n*** End Patch"
        )})),
        _ => ("Shell", json!({"command":format!("printf 'probe-{slot}'"),"title":format!("probe-{slot}")})),
    }).collect();
    let model = if code_mode { "gpt-4.1" } else { "gpt-4.1-mini" };
    let server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple(model)],
            ..Default::default()
        })
        .handler_fn(move |request: &NormalizedRequest, _: &TurnContext| {
            let results: Vec<_> = request.messages.iter().filter(|m| m.tool_call_id.is_some()).collect();
            let plan = TurnPlan::new().with_usage(Usage::new(80, 20));
            if results.is_empty() {
                let plan = if code_mode {
                    let calls = batch.iter().map(|(name, input)| format!("tools.{name}({input})"))
                        .collect::<Vec<_>>().join(",\n");
                    plan.push_tool_call("burst_exec", "exec", json!({
                        "code":format!("await Promise.all([\n{calls}\n]); text('burst cell complete');"),
                        "yield_time_ms": 1000,
                    }))
                } else {
                    batch.iter().enumerate().fold(plan, |plan, (slot, (name, input))| {
                        plan.push_tool_call(format!("burst_{slot}"), *name, input.clone())
                    })
                };
                return plan.finish(FinishReason::ToolCalls);
            }
            if code_mode {
                let last = results.last().unwrap();
                if let Ok(value) = serde_json::from_str::<Value>(&last.text)
                    && value["state"] == "running"
                {
                    return plan.push_tool_call(format!("burst_wait_{}", request.sequence), "wait", json!({
                        "cell_id": value["cell_id"], "yield_time_ms": 1000
                    })).finish(FinishReason::ToolCalls);
                }
                assert!(last.text.contains("burst cell complete"), "{}", last.text);
            } else {
                assert_eq!(results.len(), 16);
                let read = results.iter().find(|m| m.tool_call_id.as_deref() == Some("burst_1")).unwrap();
                assert!(read.text.contains("burst input"), "{}", read.text);
                let shell = results.iter().find(|m| m.tool_call_id.as_deref() == Some("burst_0")).unwrap();
                assert!(shell.text.contains("burst-output-end"));
            }
            plan.push_text("Burst verified.").finish(FinishReason::Stop)
        })
        .start().await.unwrap();
    let connection = if code_mode {
        host_nightmare_stress::seed_codemode_connection(
            &sandbox.root,
            &server.base_url(),
            "javascript",
        )
        .await
    } else {
        host_load_stress::seed_connections(&sandbox.root, &server.base_url())
            .await
            .2
    };
    let mut host = Host::spawn(&sandbox).unwrap();
    let (mut client, address) = host.ready().await.unwrap();
    configure_model(&client, &connection, model).await;
    let stop = CancellationToken::new();
    let (mut wire, facade) = connect(
        Client::connect(&address, Some(client.epoch()))
            .await
            .unwrap(),
        &stop,
    )
    .await;
    let (created, _) = rpc(
        &mut wire,
        2,
        "session/new",
        json!({"cwd":sandbox.workspace}),
    )
    .await;
    let session = created["result"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("{created}"));
    let observation = call(
        &client,
        "agent",
        "observe",
        json!({"sessionId":session}),
        Attachments::new(),
    )
    .await;
    let meta = &observation["session"];
    let updated = call(&client, "agent", "metadata", json!({
        "sessionId": session, "expectedRevision":meta["revision"], "title":meta["title"], "labels":meta["labels"],
        "permissions":{"settings":{"access":"danger_full_access","requestPermissions":false},"revokeGrants":false}
    }), Attachments::new()).await;
    assert_eq!(updated["kind"], "committed", "{updated}");
    let (reply, mut updates) = rpc(
        &mut wire,
        3,
        "session/prompt",
        json!({
            "sessionId":session, "prompt":[{"type":"text","text":"Run the mixed tool burst."}]
        }),
    )
    .await;
    assert!(
        reply["result"].is_object(),
        "code_mode={code_mode}: {reply}"
    );
    loop {
        let note = frame(&mut wire).await;
        let update = &note["params"]["update"];
        if update["sessionUpdate"] == "state_update" && update["state"] == "idle" {
            assert_eq!(
                update["stopReason"], "end_turn",
                "code_mode={code_mode}: {note}"
            );
            break;
        }
        updates.push(note);
    }
    stop.cancel();
    facade.await.unwrap().unwrap();
    host.quit(&mut client).await.unwrap();
    for slot in [2, 6, 10, 14] {
        assert_eq!(
            tokio::fs::read_to_string(sandbox.workspace.join(format!("patched-{slot}.txt")))
                .await
                .unwrap(),
            format!("patched-{slot}\n")
        );
    }
    let inspection = inspect_session(&sandbox, session).await;
    let facts: Vec<_> = inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| &row["item"]["recorded"]["fact"])
        .collect();
    let terminal = facts
        .iter()
        .find(|fact| fact["kind"] == "run_terminated")
        .unwrap();
    assert_eq!(terminal["terminal"], "completed", "{terminal}");
    let blockers: Vec<_> = facts
        .iter()
        .filter(|fact| fact["kind"] == "blocked")
        .collect();
    assert!(blockers.is_empty(), "{blockers:?}");
    let completed_tools: std::collections::HashSet<_> = updates
        .iter()
        .map(|note| &note["params"]["update"])
        .filter(|update| {
            update["status"] == "completed"
                && matches!(
                    update["name"].as_str(),
                    Some("Shell" | "Read" | "ApplyPatch")
                )
        })
        .map(|update| update["toolCallId"].as_str().unwrap())
        .collect();
    assert_eq!(completed_tools.len(), 16, "code_mode={code_mode}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_v1_delivers_final_text_before_end_turn_across_32_sessions() {
    use std::process::Stdio;

    const SESSIONS: usize = 32;
    tokio::time::timeout(Duration::from_secs(90), async {
        let sandbox = Sandbox::new().await.unwrap();
        let mut server = MockAiBuilder::new().interactive(SESSIONS)
            .control(ControlPlaneConfig { models: vec![ModelEntry::simple("gpt-4.1-mini")], ..Default::default() })
            .start().await.unwrap();
        let (_, _, connection) = host_load_stress::seed_connections(&sandbox.root, &server.base_url()).await;
        let mut host = Host::spawn(&sandbox).unwrap();
        let (mut client, _) = host.ready().await.unwrap();
        configure(&client, &connection).await;

        let mut acp = host::command(&sandbox).unwrap()
            .args(["acp", "--root"]).arg(&sandbox.root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true)
            .spawn().unwrap();
        let mut wire = BufReader::new(tokio::io::join(
            acp.stdout.take().unwrap(), acp.stdin.take().unwrap(),
        ));
        let (init, _) = rpc(&mut wire, 0, "initialize", json!({"protocolVersion":1})).await;
        assert_eq!(init["result"]["protocolVersion"], 1, "{init}");
        let mut sessions: [String; SESSIONS] = Default::default();
        let (read, mut write) = tokio::io::split(wire);
        let mut read = BufReader::new(read);
        let send = async {
            for index in 0..SESSIONS {
                write_frame(&mut write, json!({
                    "jsonrpc":"2.0", "id":index + 1, "method":"session/new",
                    "params":{"cwd":sandbox.workspace,"mcpServers":[]}
                })).await;
            }
        };
        let receive = async {
            for _ in 0..SESSIONS {
                let (created, _) = response(&mut read).await;
                let lane = created["id"].as_u64().unwrap() as usize - 1;
                let result = &created["result"];
                assert!(sessions[lane].is_empty(), "{created}");
                sessions[lane] = result["sessionId"].as_str()
                    .unwrap_or_else(|| panic!("lane {lane}: {created}")).to_owned();
                let model = result["configOptions"].as_array().unwrap().iter()
                    .find(|option| option["id"] == "model").unwrap();
                assert_eq!(model["currentValue"], "default", "{created}");
                let value = json!([connection, "gpt-4.1-mini"]).to_string();
                assert!(model["options"].as_array().unwrap().iter()
                    .any(|option| option["value"] == value), "{created}");
            }
        };
        tokio::join!(send, receive);
        let mut wire = read.into_inner().unsplit(write);
        let unique: std::collections::HashSet<_> = sessions.iter().collect();
        assert_eq!(unique.len(), SESSIONS);
        let prompt = |index: usize| json!({
            "jsonrpc":"2.0", "id":index + 1, "method":"session/prompt",
            "params":{"sessionId":sessions[index],"prompt":[{"type":"text","text":format!("Lane {index}")}]}
        });
        write_frame(&mut wire, prompt(0)).await;
        let first = server.next_turn().await.unwrap();
        let before = call(&client, "agent", "observe", json!({"sessionId":sessions[0]}), Attachments::new()).await;
        let after = before["through"].as_u64().unwrap();
        for index in 1..SESSIONS {
            write_frame(&mut wire, prompt(index)).await;
        }
        let release = async {
            let mut turns = vec![first];
            for _ in 1..SESSIONS {
                turns.push(server.next_turn().await.unwrap());
            }
            for turn in turns {
                let answer = format!("Final answer for {}.", turn.request.last_user_text().unwrap());
                turn.reply_text(answer);
            }
        };
        let verify = async {
            let mut complete = [false; SESSIONS];
            let mut answers: [String; SESSIONS] = Default::default();
            let lane_by_session: std::collections::HashMap<_, _> =
                sessions.iter().map(String::as_str).zip(0..SESSIONS).collect();
            while complete.contains(&false) {
                let message = frame(&mut wire).await;
                if let Some(id) = message["id"].as_u64() {
                    let lane = id as usize - 1;
                    assert_eq!(message["result"]["stopReason"], "end_turn", "lane {lane}: {message}");
                    assert!(!std::mem::replace(&mut complete[lane], true), "{message}");
                    assert_eq!(answers[lane], format!("Final answer for Lane {lane}."), "lane {lane} at end_turn");
                } else if message["params"]["update"]["sessionUpdate"] == "agent_message_chunk" {
                    let session = message["params"]["sessionId"].as_str().unwrap();
                    let lane = lane_by_session[session];
                    assert!(!complete[lane], "lane {lane}: {message}");
                    answers[lane].push_str(message["params"]["update"]["content"]["text"].as_str().unwrap());
                }
            }
        };
        tokio::join!(release, verify);
        let terminal = call(&client, "agent", "observe", json!({"sessionId":sessions[0]}), Attachments::new()).await;
        let through = &terminal["through"];
        let read = |position: Value| json!({"sessionId":sessions[0], "through":through, "position":position});
        // The first lane was held at the provider while other sessions wrote to the log.
        let exact = call(&client, "agent", "history", read(json!({"kind":"event","sequence":after+1})), Attachments::new()).await;
        assert_eq!(exact["chunks"], json!([]), "the next global event belongs to another session");
        let range = call(&client, "agent", "history", read(json!({"kind":"after_event","sequence":after})), Attachments::new()).await;
        assert_eq!(range["chunks"][0]["text"], "Final answer for Lane 0.");
        assert_eq!(range["chunks"][0]["offset"], 0);

        drop(wire);
        assert!(acp.wait().await.unwrap().success());
        host.quit(&mut client).await.unwrap();
    }).await.expect("32 concurrent ACP prompts and Host shutdown");
}

#[tokio::test]
async fn acp_prompt_key_survives_host_and_connection_restart() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let sandbox = Sandbox::new().await.unwrap();
        let server = MockAiBuilder::new()
            .control(ControlPlaneConfig {
                models: vec![ModelEntry::simple("gpt-4.1-mini")],
                ..Default::default()
            })
            .handler_fn(move |_: &NormalizedRequest, _: &TurnContext| {
                TurnPlan::new().push_text("Recorded.").with_usage(Usage::new(10, 2)).finish(FinishReason::Stop)
            })
            .start().await.unwrap();
        let (_, _, connection) = host_load_stress::seed_connections(&sandbox.root, &server.base_url()).await;
        let mut original = None;
        let mut session = Value::Null;
        for replay in [false, true] {
            let mut host = Host::spawn(&sandbox).unwrap();
            let (mut client, address) = host.ready().await.unwrap();
            if !replay {
                configure(&client, &connection).await;
            }

            let stop = CancellationToken::new();
            let (mut wire, facade) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &stop).await;
            if replay {
                let (resumed, notifications) = rpc(&mut wire, 2, "session/resume", json!({"sessionId":session,"cwd":sandbox.workspace,"replayFrom":{"type":"start"}})).await;
                assert!(resumed["result"].is_object(), "{resumed}");
                let mut replay_order = vec![];
                for note in &notifications {
                    assert_eq!(note["method"], "session/update", "{note}");
                    assert_eq!(note["params"]["sessionId"], session);
                    let update = &note["params"]["update"];
                    match update["sessionUpdate"].as_str() {
                        Some("user_message") => {
                            assert_eq!(update["messageId"].as_str(), original.as_deref());
                            assert_eq!(update["content"][0]["text"], "Record once.");
                            replay_order.push("user");
                        }
                        Some("replay_complete") => replay_order.push("complete"),
                        Some("state_update") => {
                            assert_eq!(update["state"], "idle");
                            replay_order.push("idle");
                        }
                        _ => {}
                    }
                }
                assert_eq!(replay_order, ["user", "complete", "idle"], "{notifications:?}");
            } else {
                let (created, _) = rpc(&mut wire, 2, "session/new", json!({"cwd":sandbox.workspace})).await;
                assert!(created["result"]["sessionId"].is_string(), "{created}");
                session = created["result"]["sessionId"].clone();
            }
            let prompt = |key: Value| json!({"sessionId":session, "prompt":[{"type":"text","text":"Record once."}], "idempotencyKey":key});
            if !replay {
                for key in [json!(""), json!("x".repeat(256)), json!(7)] {
                    let (invalid, _) = rpc(&mut wire, 3, "session/prompt", prompt(key)).await;
                    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
                }
            }
            let (reply, _) = rpc(&mut wire, 4, "session/prompt", prompt(json!("一".repeat(255)))).await;
            let message = reply["result"]["messageId"].as_str().unwrap_or_else(|| panic!("{reply}"));
            if replay {
                assert_eq!(Some(message), original.as_deref());
            } else {
                original = Some(message.to_owned());
                loop {
                    let update = frame(&mut wire).await;
                    if update["params"]["update"]["state"] == "idle" {
                        assert_eq!(update["params"]["update"]["stopReason"], "end_turn", "{update}");
                        break;
                    }
                }
            }
            stop.cancel();
            facade.await.unwrap().unwrap();
            if replay {
                let history = call(&client, "agent", "history", json!({"sessionId":session,"position":{"kind":"start"}}), Attachments::new()).await;
                assert_eq!(history["kind"], "ready", "{history}");
                assert!(history["after"].is_null(), "{history}");
                let users: Vec<_> = history["chunks"].as_array().unwrap().iter().filter(|c| c["role"] == "user").map(|c| &c["messageId"]).collect();
                assert_eq!(users, [&json!(message)]);
            }
            host.quit(&mut client).await.unwrap();
        }
        let inspection = inspect_session(&sandbox, session.as_str().unwrap()).await;
        let runs = inspection["facts"].as_array().unwrap().iter()
            .filter(|row| row["item"]["recorded"]["fact"]["kind"] == "run_admitted").count();
        assert_eq!(runs, 1, "exactly one durable admission for the session");
        assert_eq!(server.metrics().chat_completions_requests, 1, "retry must not start model work");
    }).await.expect("bounded ACP retry and Host restart");
}

async fn wait_for_queued(client: &Client, session: &str, text: &str) {
    loop {
        let queue = call(
            client,
            "agent",
            "queue",
            json!({"sessionId":session}),
            Attachments::new(),
        )
        .await;
        if queue["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["preview"] == text)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn acp_prompt_key_cancel_before_insertion_allows_a_fresh_retry() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let sandbox = Sandbox::new().await.unwrap();
        let mut server = MockAiBuilder::new().interactive(2)
            .control(ControlPlaneConfig { models: vec![ModelEntry::simple("gpt-4.1-mini")], ..Default::default() })
            .start().await.unwrap();
        let (_, _, connection) = host_load_stress::seed_connections(&sandbox.root, &server.base_url()).await;
        let mut host = Host::spawn(&sandbox).unwrap();
        let (mut client, address) = host.ready().await.unwrap();
        configure(&client, &connection).await;
        let stop = CancellationToken::new();
        let (mut a, a_task) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &stop).await;
        let (mut b, b_task) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &stop).await;
        let (created, _) = rpc(&mut a, 2, "session/new", json!({"cwd":sandbox.workspace})).await;
        let session = created["result"]["sessionId"].as_str().unwrap();
        let (resumed, _) = rpc(&mut b, 2, "session/resume", json!({"sessionId":session,"cwd":sandbox.workspace})).await;
        assert!(resumed["result"].is_object(), "{resumed}");
        let prompt = |key, text| json!({"sessionId":session,"idempotencyKey":key,"prompt":[{"type":"text","text":text}]});
        let (first, _) = rpc(&mut a, 3, "session/prompt", prompt("A","Block here.")).await;
        let first_id = first["result"]["messageId"].as_str().unwrap();
        let blocked = server.next_turn().await.unwrap();
        let (recorded, _) = rpc(&mut b, 8, "session/prompt", json!({
            "sessionId":session,"idempotencyKey":"A","prompt":[{
                "type":"resource_link","name":"missing","uri":format!("file://{}/missing", sandbox.workspace.display())
            }]
        })).await;
        assert_eq!(recorded["result"]["messageId"], first_id, "{recorded}");

        let submit_b = |id, text| json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":prompt("B",text)});
        write_frame(&mut b, submit_b(3, "Withdraw this.")).await;
        wait_for_queued(&client, session, "Withdraw this.").await;
        write_frame(&mut b, submit_b(9, "Withdraw this.")).await;
        // A positive wire barrier rather than a timed assertion that no reply arrived.
        let (list, _) = rpc(&mut b, 4, "session/list", json!({})).await;
        assert!(list["result"].is_object(), "{list}");
        write_frame(&mut b, json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await;
        write_frame(&mut b, submit_b(5, "Fresh retry.")).await;
        let mut withdrawn = vec![];
        for _ in 0..2 {
            let (cancelled, _) = response(&mut b).await;
            assert_eq!(cancelled["error"]["code"], -32800, "{cancelled}");
            withdrawn.push(cancelled["id"].as_u64().unwrap());
        }
        withdrawn.sort();
        assert_eq!(withdrawn, [3, 9]);
        tokio::select! {
            _ = wait_for_queued(&client, session, "Fresh retry.") => {}
            (reply, _) = response(&mut b) => panic!("fresh submission answered before insertion: {reply}"),
        }
        write_frame(&mut b, submit_b(6, "Ignore this changed payload.")).await;
        let (list, _) = rpc(&mut b, 7, "session/list", json!({})).await;
        assert!(list["result"].is_object(), "{list}");
        assert!(blocked.delta("Done.").await);
        blocked.finish().await;
        let (one, _) = response(&mut b).await;
        let (two, _) = response(&mut b).await;
        let mut ids = [one["id"].as_u64().unwrap(), two["id"].as_u64().unwrap()];
        ids.sort();
        assert_eq!(ids, [5, 6]);
        let second_id = one["result"]["messageId"].as_str().unwrap_or_else(|| panic!("{one}"));
        assert_eq!(two["result"]["messageId"], second_id, "{two}");
        assert_ne!(second_id, first_id);
        let second = server.next_turn().await.unwrap();
        assert!(second.delta("Done.").await);
        second.finish().await;
        work(&client, session, json!({"kind":"message","messageId":second_id}), Some("completed")).await;
        let history = call(&client, "agent", "history", json!({"sessionId":session,"position":{"kind":"start"}}), Attachments::new()).await;
        assert!(history["after"].is_null());
        let users: Vec<_> = history["chunks"].as_array().unwrap().iter().filter(|c| c["role"] == "user")
            .map(|c| (c["messageId"].as_str().unwrap(), c["text"].as_str().unwrap())).collect();
        assert_eq!(users, [(first_id, "Block here."), (second_id, "Fresh retry.")]);
        stop.cancel();
        a_task.await.unwrap().unwrap();
        b_task.await.unwrap().unwrap();
        host.quit(&mut client).await.unwrap();
        assert_eq!(server.metrics().chat_completions_requests, 2);
    }).await.expect("bounded pending prompt cancellation and retry");
}

#[tokio::test]
async fn acp_prompt_key_reconnect_during_independent_host_work() {
    reconnect_during_host_work(false).await;
}

#[tokio::test]
async fn acp_prompt_key_cancelled_repeat_resume_keeps_the_live_connection() {
    reconnect_during_host_work(true).await;
}

async fn reconnect_during_host_work(cancel_replay: bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        let sandbox = Sandbox::new().await.unwrap();
        let mut server = MockAiBuilder::new().interactive(2)
            .control(ControlPlaneConfig { models: vec![ModelEntry::simple("gpt-4.1-mini")], ..Default::default() })
            .start().await.unwrap();
        let (_, _, connection) = host_load_stress::seed_connections(&sandbox.root, &server.base_url()).await;
        let mut host = Host::spawn(&sandbox).unwrap();
        let (mut client, address) = host.ready().await.unwrap();
        configure(&client, &connection).await;
        let stop = CancellationToken::new();
        let (mut a, task) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &stop).await;
        let (created, _) = rpc(&mut a, 2, "session/new", json!({"cwd":sandbox.workspace})).await;
        let session = created["result"]["sessionId"].as_str().unwrap();
        let prompt = json!({"sessionId":session,"idempotencyKey":"original","prompt":[{"type":"text","text":"Once."}]});
        let (first, _) = rpc(&mut a, 3, "session/prompt", prompt.clone()).await;
        let message = first["result"]["messageId"].as_str().unwrap();
        let turn = server.next_turn().await.unwrap();
        assert!(turn.delta("Done.").await);
        turn.finish().await;
        while frame(&mut a).await["params"]["update"]["state"] != "idle" {}
        stop.cancel();
        task.await.unwrap().unwrap();

        let sent = call(&client, "agent", "send", json!({"sessionId":session,"message":"Hold.","delivery":"queue","backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1-mini"}}), Attachments::new()).await;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let blocked = server.next_turn().await.unwrap();
        // Dropping one read-only observer must leave the original Host work running.
        let detach = CancellationToken::new();
        let (mut spectator, spectator_task) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &detach).await;
        let (resumed, _) = rpc(&mut spectator, 2, "session/resume", json!({"sessionId":session,"cwd":sandbox.workspace})).await;
        assert!(resumed["result"].is_object(), "{resumed}");
        detach.cancel();
        spectator_task.await.unwrap().unwrap();

        let stop = CancellationToken::new();
        let (mut b, task) = connect(Client::connect(&address, Some(client.epoch())).await.unwrap(), &stop).await;
        let (resumed, notes) = rpc(&mut b, 2, "session/resume", json!({"sessionId":session,"cwd":sandbox.workspace,"replayFrom":{"type":"start"}})).await;
        assert!(resumed["result"].is_object(), "{resumed}");
        let snapshot = notes.iter().filter_map(|n| {
            let update = &n["params"]["update"];
            match update["sessionUpdate"].as_str()? {
                "replay_complete" => Some("complete"),
                "state_update" => update["state"].as_str(),
                _ => None,
            }
        }).collect::<Vec<_>>();
        assert_eq!(snapshot, ["complete", "running"]);
        if cancel_replay {
            write_frame(&mut b, json!({"jsonrpc":"2.0","id":4,"method":"session/resume","params":{"sessionId":session,"cwd":sandbox.workspace,"replayFrom":{"type":"start"}}})).await;
            // A busy reply proves the second resume has entered this session's gate.
            let (busy, _) = rpc(&mut b, 5, "session/set_config_option", json!({"sessionId":session,"configId":"model","type":"id","value":"unused"})).await;
            assert_eq!(busy["error"]["data"], "ACP session is busy", "{busy}");
            write_frame(&mut b, json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await;
            let (cancelled, notes) = response(&mut b).await;
            assert_eq!(cancelled["id"], 4, "{cancelled}");
            assert_eq!(cancelled["error"]["data"], "ACP replay cancelled", "{cancelled}");
            assert!(!notes.iter().any(|n| n["params"]["update"]["sessionUpdate"] == "replay_complete"), "{notes:?}");
        }
        let (retry, _) = rpc(&mut b, 3, "session/prompt", prompt).await;
        assert_eq!(retry["result"]["messageId"], message, "{retry}");
        assert!(blocked.delta("Done.").await);
        blocked.finish().await;
        work(&client, session, json!({"kind":"message","messageId":sent["messageId"]}), Some("completed")).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let note = frame(&mut b).await;
                assert_eq!(note["params"]["sessionId"], session, "{note}");
                let update = &note["params"]["update"];
                if update["sessionUpdate"] == "state_update" {
                    assert_eq!(update["state"], "idle", "{note}");
                    assert_eq!(update["stopReason"], "end_turn", "{note}");
                    break;
                }
            }
        }).await.expect("resumed ACP connection never saw the Host go idle");
        stop.cancel();
        task.await.unwrap().unwrap();
        host.quit(&mut client).await.unwrap();
        assert_eq!(server.metrics().chat_completions_requests, 2);
    }).await.expect("bounded busy resume");
}
