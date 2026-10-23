# GitMenorah

**A Git worktrees UI, a central control room for your coding agents, and an Inference Router that sends each Claude Code task to the right model.**

GitMenorah is a desktop app for developers who run Claude Code and Codex every day. It does three jobs in one window:

1. **Git worktrees, made visual.** Create, inspect, merge and clean up worktrees from a UI instead of the command line, so every task gets its own branch and folder.
2. **Every agent, managed in one place.** Each Claude Code, Codex or shell session is a live node on a canvas. See which agent is running, which is waiting for you and which is done, across all your projects.
3. **New: the right model for every task.** The [Inference Router](#inference-router) sorts each Claude Code sub-agent task (bug fix, tests, architecture, docs…) and runs it on the Claude model you picked for that kind of work: Opus where quality matters, Haiku where speed and cost matter. A Statistics tab shows where every token and dollar went.

Put them together: give each agent its own worktree, let agents share context, route their work to the right model, then review and merge it from the same window.

**[⬇ Download GitMenorah](https://github.com/diepnghitinh/git-menorah/releases)** for macOS (Apple Silicon and Intel) or Windows x64.

https://github.com/user-attachments/assets/3b82def1-d6b9-46e9-866a-03fd1e46cdd1

---

## Why GitMenorah

Coding agents are fast. Juggling them is not. Five terminal tabs, three half-finished branches, one agent that quietly ate 14 GB of RAM, and no idea which session is waiting for you. GitMenorah is built for that.

| | |
|---|---|
| **One task, one worktree** | Spin up a branch in its own `.worktrees/<name>` folder in two clicks. Agents never step on each other's files, and your main checkout stays put. |
| **All agents, one view** | Claude Code, Codex and shells live side by side on a canvas and in a single Agents list, instead of being scattered across terminal tabs. |
| **Know who needs you** | Running, waiting and finished states show on every node, in the Agents list and at the MacBook notch. A finished turn never sits unnoticed. |
| **Agents that share context** | Draw a wire between two nodes and each agent can read the other's notes, transcript or terminal with one command. |
| **Git you can trust** | Every Git action shows the exact commands before it runs. Nothing happens behind your back. |
| **Resource guard rails** | Cap CPU and RAM for everything your agents spawn, so a runaway test suite cannot freeze your machine. |
| **Pay for the model the task needs** | The Inference Router runs tests and docs on Haiku and design work on Opus, per project, and shows the cost of every turn. |

---

## Inference Router

> **New in 1.0.7.** Works with **Claude Code only**. Codex sessions and shells are never routed.

Claude Code hands a lot of its work to sub-agents: "fix this failing test", "write the docs for this module", "design the data model". By default every one of them runs on the same model as the main session. That means paying Opus prices for a README, or getting Haiku-level thinking on an architecture decision.

The Inference Router fixes that. Open **AI Hub** in the left rail, turn the router on and give a project a router:

- **Software Engineering:** bug fixing, code generation, testing, performance, architecture, UX and UI components, code review and security, DevOps, documentation.
- **AI Engineer:** training and fine-tuning, data pipelines, AI-generated data, LLM apps and agents, prompt engineering, model evaluation, data analysis, AI system design, MLOps.

Each task has its own Claude model, with sensible defaults (Opus for architecture, UI and prompts; Sonnet for code; Haiku for tests and docs) that you can change.

### How it works

1. Claude Code sessions opened from a project with a router talk to a small proxy on `127.0.0.1` instead of the API directly.
2. When a sub-agent starts, a small, cheap judge model (Claude Haiku 4.5 by default, or a provider from Settings) reads the task once and picks one of the router's tasks.
3. The proxy sends that turn to the model set for the task, then forwards it to your real endpoint: `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`, the environment, or `api.anthropic.com`.
4. The main conversation, Explore agents, side requests and safety checks pass through untouched. If Anthropic refuses the routed model, the original request is sent again, so a turn never fails because of routing.

### Benefits

| | |
|---|---|
| **Lower cost** | Routine work (tests, docs, data analysis) runs on cheaper, faster models. You only pay for Opus where it changes the result. |
| **Better results where it counts** | Architecture, UI and prompt work get the strongest model even when your main session runs on something lighter. |
| **Faster turns** | Small models answer simple sub-agent tasks quicker, so the whole session moves faster. |
| **Per-project control** | A backend repo can use Software Engineering, an ML repo AI Engineer, and a side project no router at all. |
| **See where the money goes** | The **Statistics** tab in AI Hub draws a flow diagram of Claude Code → router → task → model, sized by turns, tokens or estimated cost, for today, 7 or 30 days, per project. |
| **Private by design** | Usage is stored in a local SQLite database in the app's data folder: task, model, tokens, cost and time, never prompt text. One click deletes it. |
| **Zero lock-in** | Turn the router off and sessions go straight to the API again from the next turn. |

### Claude Code outside GitMenorah

The router also works for Claude Code in your own terminal or IDE. In AI Hub, under **Claude Code outside Git Menorah**, pick a router and press **Install into settings.json**. GitMenorah points `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` at its proxy and keeps a backup of the original file next to it.

**Restore original** puts the file back exactly as it was. If you edited the file after the install, only the old `ANTHROPIC_BASE_URL` is restored and your other changes stay. While installed, Claude Code needs GitMenorah to be running; the proxy keeps the same address across restarts.

### Providers

**Settings** lists AI providers: OpenRouter, OpenAI, Google Gemini, DeepSeek, Ollama, any OpenAI-compatible server (vLLM, LM Studio, LiteLLM…) and TypeSafe (judge only). **Add provider** checks the connection before saving. API keys are encrypted with the OS keychain and never shown again.

Today a provider can act as the **judge**; in that case the sub-agent's task text is sent to that provider to be sorted. A task can also be given a provider model as its **target**: the choice is saved, but the turn still runs on Claude until protocol translation for other providers ships.

---

## Git worktrees UI

GitMenorah treats worktrees as the default way to work, not an advanced trick.

- **New worktree in two clicks.** Press **+** next to *Worktrees* in the sidebar, or right-click any worktree and choose **New worktree from …**. The branch defaults to whatever the main worktree is on.
- **Consistent names.** Branches follow `feat/<yyyy-mm-dd-hh-mm>_<name>` or `hotfix/…`. Worktrees live in `.worktrees/<name>`, and that folder is kept out of Git automatically.
- **Every worktree at a glance.** The sidebar lists all worktrees with their branch and pending changes, sorted by newest or A–Z.
- **A terminal in any worktree.** Open a shell in any worktree or folder from the bottom tray, or drop a terminal or agent node on the canvas.
- **Commit & merge into develop.** Ship a feature branch from its worktree to `develop` in one reviewed step.
- **Clean up safely.** Removing a worktree is refused while it has uncommitted files or processes still running inside it, and you see which ignored files (`.env.local`, `dist/` …) would go with it. Shared branches such as `develop` and `main` are never deleted.

### The rest of the Git client

- **Commit graph** with branch and tag lanes, commit details and changed files as a path list or tree.
- **Files view** with a file tree, per-file history and a built-in terminal. Markdown files open with a **Preview | Code** switch.
- **Stage, unstage or discard** any file or folder in the working tree. Discard always shows the exact `git restore` / `git clean` commands first and never deletes untracked secret files such as `.env.local`.
- **Branches, remotes and stashes** in one sidebar, with fetch, pull, push, stash and pop.
- **Review before run.** Every action opens a dialog with the exact `git` commands and any warnings. **Command history** in the bottom tray records what ran and what it printed.
- **Project groups.** Add every repository of a multi-repo product once, then fetch all of them in one click.
- **Clone from URL.** Paste an HTTPS or SSH URL, or pick from the repositories of a signed-in account (`⇧⌘C`).
- **Gitflow guard.** In repositories that have a `develop` branch, `main`, `master`, `staging` and `prod` only take changes through pull requests, and merging `develop` into them is refused. Repositories without `develop` are left alone.

---

## Central agent management

- **Claude Code, Codex and plain terminals** as first-class nodes. `⌘T` for Claude Code, `⇧⌘T` for Codex, `⌥⌘T` for a shell.
- **Agents view** (`⌘3`) lists every session across all your projects with its live status: running, waiting for input or done.
- **Notch indicator (macOS).** Running and waiting agents appear around the MacBook notch. Click one to jump straight to it.
- **Chat panel.** Read an agent's conversation as clean messages, including tool calls such as `Bash · npm test`, and reply from a normal text box.
- **Sub-agent strip.** Follow the sub-agents a session spawns, with their steps and when they finish.
- **Resume after restart.** Stopped Claude Code and Codex sessions reopen from the canvas with their history.
- **Screenshots in one drag.** Your recent screenshots sit in the toolbar. Drag one into a terminal to hand it to the agent.

### Shared context between agents

Connect two nodes with a wire and each agent gets the `menorah-context` command in its terminal:

```sh
menorah-context list                       # nodes wired to this one
menorah-context summary --node "API" -n 15 # last messages of a linked agent
menorah-context transcript --node "API"    # its full conversation
menorah-context terminal --node "Build"    # what a linked terminal printed
```

GitMenorah also installs a matching skill, so agents learn to use the command on their own. The command only listens on `127.0.0.1` and requires a per-session token.

### Resource limits

Open **GitMenorah → Settings… → Terminal limits** (`⌘,`) and set:

- **Max CPU (cores):** processes started from your terminals are throttled once they exceed the limit.
- **Max RAM (GB):** when the limit is hit, the process using the most memory is stopped and you get a notification.

Your shell and the agent itself are never throttled or killed, only the processes they spawn. On Windows, usage is measured but not enforced yet.

---

## Canvas

- **Infinite, zoomable workspace** with a minimap. `⌘0` fits everything on screen.
- **Tabs per project.** The top bar reads like a breadcrumb: **project ▾ / tab 1 · tab 2**. Click the project to switch to another one or open a new folder. Each tab is its own canvas, and the **+** opens a tab on a folder, on a repository you already have, or on a fresh clone.
- **Notes** sit next to the agents they describe and can be shared with them through wires.
- **Images, Figma style.** Paste (`⌘V`) or drop an image onto the canvas, drag it around, resize it from any corner with its aspect ratio kept (`⇧` for free), and drop it onto a terminal to hand it to the agent.
- **Layouts persist.** Close the app and your canvas, wires and sessions are where you left them.
- **Multiple windows.** `⌘N` opens another window, for example Git on one screen and the canvas on another.

---

## Accounts

Open **GitMenorah → Accounts…** (or **Settings… → Accounts**) to sign in to GitHub, GitHub Enterprise, GitLab, Bitbucket Cloud or any other git host with a personal access token, as in Sourcetree. GitMenorah checks the token with the provider, then hands it to git's credential helper (macOS Keychain or Git Credential Manager). Fetch, pull, push and clone then work without password prompts, in the app and in your own terminals. GitMenorah stores no copy of the token.

- **GitHub:** a classic token with `repo` and `read:org` (add `workflow` to push Actions files), or a fine-grained token with Contents read and write.
- **GitLab:** `read_api`, `read_repository`, `write_repository`.
- **Bitbucket Cloud:** an Atlassian API token with Bitbucket scopes `read:user`, `read:workspace`, `read:repository`, `write:repository`, plus your Atlassian email.

---

## Under the hood

- **Electron** shell for the window, canvas and Git UI.
- **menorah-agentd**, a small Go sidecar that runs every terminal (PTY on macOS, ConPTY on Windows), reads agent transcripts, enforces resource limits and serves `menorah-context`. It idles at about 6 MB of RAM. If it crashes, it restarts within a second and restores your limits and wiring.
- **Inference Router proxy** inside the app, on `127.0.0.1` with a per-install token. Usage statistics live in a local SQLite database.
- **Local first.** No GitMenorah cloud and no GitMenorah account. Everything runs on your machine against your own repositories and your own Claude Code / Codex installs. Requests only go to the endpoints you already use and to providers you add yourself.

---

## Get started

### Download

Grab the latest `.dmg` (macOS) or `.zip` (Windows) from the [Releases page](https://github.com/diepnghitinh/git-menorah/releases). You still need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) installed to run agent nodes.

### Requirements (build from source)

- macOS (Apple Silicon or Intel) or Windows x64
- Node.js 20+ and npm
- Go 1.22+ (to build `menorah-agentd`; no cgo needed)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) installed for agent nodes

### Run from source

```sh
cd tools/git-desktop
npm ci
npm start        # builds bin/menorah-agentd first, then opens the app
```

`npm run agentd` rebuilds only the sidecar (macOS / Linux).

### Git page in a browser

The Git page also runs without the desktop app (no canvas, no agents):

```sh
node tools/git-server.mjs --open        # http://127.0.0.1:4990, --port=<n> to change
```

Repositories and project groups are saved in `~/.config/gitmenorah/git.json`, shared by the app and the browser page. Set `GITMENORAH_CONF=<file>` to use another file. Add `"linkNodeModules": true` there to give new worktrees symlinks to the main worktree's `node_modules`.

### Build installers

```sh
tools/build-git.sh --platform=macosx --arch=universal   # .dmg, Intel + Apple Silicon
tools/build-git.sh --platform=windows                   # .zip for Windows x64
```

Output goes to `tools/git-desktop/dist/`. Windows builds can be produced on a Mac.

---

## Keyboard shortcuts

| Action | macOS | Windows |
|---|---|---|
| Project · Git | `⌘1` | `Ctrl+1` |
| Canvas | `⌘2` | `Ctrl+2` |
| Agents | `⌘3` | `Ctrl+3` |
| New Claude Code | `⌘T` | `Ctrl+T` |
| New Codex | `⇧⌘T` | `Ctrl+Shift+T` |
| New terminal | `⌥⌘T` | `Ctrl+Alt+T` |
| Fit canvas | `⌘0` | `Ctrl+0` |
| New window | `⌘N` | `Ctrl+N` |
| Add repository | `⌘O` | `Ctrl+O` |
| Add project folder | `⇧⌘O` | `Ctrl+Shift+O` |
| Clone repository | `⇧⌘C` | `Ctrl+Alt+C` |
| Terminal tray (Git tab) | `` ⌃` `` | `` Ctrl+` `` |
| Settings | `⌘,` | `Ctrl+,` |

---

## What's new

See [changelogs.txt](tools/git-desktop/changelogs.txt).

---

## License

GitMenorah is open source under the [MIT License](LICENSE). Use it, change it and ship it, at work or in your own products.

---

Made by [InChurch.app](https://inchurch.app).
