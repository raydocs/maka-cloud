<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->


# Maka Cloud

A cloud personal agent for software work, built on a fork of [Apache Maka](https://github.com/apache/maka).
You hand off a task from the web app or your phone. It runs in a sandbox of its own, a model from a second
vendor reviews any code it writes, and you get a result with the proof of what was checked.

In the app it is called Maka.

## What it does

- **You give a goal once.** A conductor plans the work and hands it to agents (Claude Agent SDK first, Codex as
  the other vendor) that run in a cloud sandbox. Each invite gets its own sandbox machine; nothing is shared
  between invites.
- **It checks its own work.** For a coding task the runner, not the agent, runs the checks: the agent's
  reproduction test must fail on the base commit and pass with the change, and the repository's own tests must
  pass. A model from the other vendor then reviews the change. After two failures it hands the task to the other
  vendor once, and never runs a third agent.
- **It interrupts you only for real decisions.** Opening a pull request, or anything else that cannot be undone,
  waits for your approval. You pick a mode, never a model.
- **Web and phone.** A phone-first web app (`packages/cloud-web`: Home, Chat, Projects and Settings) and iOS and
  Android apps (`packages/cloud-mobile`: Home, Chat and Settings so far).

The design notes are in [`docs/fork/design/`](./docs/fork/design); start with
[`autonomy.md`](./docs/fork/design/autonomy.md) and [`coding-playbook.md`](./docs/fork/design/coding-playbook.md).
The sandbox threat model is [`docs/fork/isolation-model.md`](./docs/fork/isolation-model.md).

## The proof it shows

- **The pull request.** A coding task's pull request is built on the host from the checked change, and its
  description says what was run: the reproduction test failing on the base commit and passing with the change,
  the repository's tests, the second vendor's review, the changed files, and what was not verified. A change no
  review cleared is not opened; one kept for you to look at opens only as a draft, and only if you ask. Coming (#332): the same proof as one table,
  with the cost against the budget and a link to the run.
- **Result cards.** A finished task arrives in Chat as one card: a sentence, one picture or the diff, and at most
  two actions (the pull request, the preview). Its task page shows the outcome, the review, the steps, the diff, the
  cost and the pull request.
- **Approvals bound to exact text.** An approval card shows the call it approves exactly as it will run, with no
  rewording. A card that holds a hidden character cannot be approved.
- **Kept approvals.** For opening a pull request you can approve this once, for this task, or for this repository.
  A kept approval can be listed and revoked, and every use of it is recorded. Coming (#387): the list in Settings.
- **Spend caps and pause.** Daily and monthly caps per invite, and a daily cap for the whole server, are enforced at
  the model gateway, so a task cannot spend past them. `maka-cloud pause` stops all spending within
  seconds; `maka-cloud resume` allows it again.

## Install

The one-command install is coming: once the `deploy/install.sh` installer and the `maka-cloud setup` wizard land,
this is the command.

```sh
curl -fsSL https://raw.githubusercontent.com/raydocs/maka-cloud/main/deploy/install.sh | sh
```

Or clone the repository and run `./deploy/install.sh`.

Until then, [`docs/fork/deploy.md`](./docs/fork/deploy.md) is the manual runbook for one host, and
[`deploy/rehearsal/README.md`](./deploy/rehearsal/README.md) is a rehearsal of the deploy that costs nothing: the
same images, Compose file and Caddyfile, with stand-ins for the model and sandbox APIs.

What you need:

- An Anthropic API key.
- An instabox API key (the sandbox provider).
- A host with Docker, and a domain that points at it.
- Recommended: an OpenAI API key, so a second vendor reviews the work.
- Optional: a fine-grained GitHub token (`github_pat_…`), to open pull requests.

Models are reached with API keys only. There is no subscription login.

What stays off at the first launch, and why, is in [`docs/fork/launch-notes.md`](./docs/fork/launch-notes.md).

## Built on Apache Maka

Maka Cloud is a fork of [Apache Maka](https://github.com/apache/maka) and merges upstream often. Upstream describes
itself in one sentence: Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.
Maka Cloud adds its own packages (`packages/cloud-*`) and uses Maka's runtime through its extension points.

<details>
<summary>Upstream's picture of one turn</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/readme-hero.en.dark.png" />
  <img alt="One turn of RuntimeEvents: the model speaks, runs a command, asks permission, you approve, it gets the result, edits a file, the turn ends." src="./.github/assets/readme-hero.en.light.png" />
</picture>

</details>

- Contributing: read [`AGENTS.md`](./AGENTS.md) first. It covers the upstream sync, where fork code goes and the
  list of upstream files this fork changes.
- Fork docs: [`docs/fork/`](./docs/fork), with the task briefs in [`docs/fork/TASKS.md`](./docs/fork/TASKS.md).
- Upstream's own documentation: [`docs/README.md`](./docs/README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## License

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution. Third-party components
remain subject to their own licenses and notices; the ones this fork adds are listed in
[`docs/fork/THIRD_PARTY.md`](./docs/fork/THIRD_PARTY.md).

Apache Maka, Maka, Apache, the Apache feather, and the Apache Maka project logo are either registered trademarks or
trademarks of The Apache Software Foundation. Maka Cloud is not a project of the Apache Software Foundation.
