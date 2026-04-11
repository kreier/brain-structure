# Structure of my digital brain - conversations with LLMs

![GitHub License](https://img.shields.io/github/license/kreier/brain-structure)
![GitHub Release](https://img.shields.io/github/v/release/kreier/brain-structure)

This documents the structure of my **brain** project to collect and analyze my conversations with LLMs. And brain is obviously private.

## Get the raw data

It would be great if there was just a button "Download conversations as JSON or MD" but it is not. There are plugins, but they require sometimes to click on every single conversation. It can't be that complicated, now can it?

### Google Gemini

The output is currently only HTML plus created images as jpg.

- Go to [takeout.google.com](https://takeout.google.com).
- Click **Deselect all**.
- Find **My Activity** and click the button "All activity data included."
- Deselect everything and check **ONLY "Gemini Apps."**
- Proceed to the next step and create the export.
- [!IMPORTANT]<br>**The Takeout "Gotcha":** In the Takeout list, there is a separate "Gemini" category. **Do not use that.** That category only exports your "Gems" (custom instructions) and settings. To get your actual chat history, you must use the **My Activity > Gemini Apps** path mentioned above.

And since I have some Android phones, whenever you ask "OK Google" on your Google home or Android phone, you get an entry that late has to be cleaned out. Better use the following two ones:

### Claude

The steps are: **Claude** → `claude.ai` Settings → Export data → JSON. Claude will then send you an email with a zip file that contains four json files:

- conversations.json
- memories.json
- projects.json
- users.json

### ChatGPT

Instructions will follow. Should be JSON that you get via email.

## Ideas

I got some ideas about reflecting on my conversations with AI and to learn from them. The structure:

```
brain/
├── sources/
│   ├── chatgpt_2024.json        # normalized, year-split source files
│   ├── chatgpt_2025.json
│   ├── gemini_2024.json
│   ├── gemini_2025.json
│   └── claude_2024.json
├── vault/
│   ├── chatgpt/
│   │   └── 2024-11-14 How Python decorators work.md
│   ├── gemini/
│   └── claude/
└── brain.py                     # the single CLI tool for everything
```

The script will have three commands:

-   `brain.py ingest <exports...>` — parse raw exports → split into `sources/` by year
-   `brain.py stats` — overview of all source files (conversations, words, avg response length)
-   `brain.py clean` — interactive per-turn review with confirm/skip/auto
-   `brain.py export` — generate Obsidian vault Markdown from cleaned sources

The `-v` flag is on the subparser not the parent — I need to add `--verbose` to each subcommand, or move it.  Drop `brain.py` in the root of your repo and you're good to go. Here's the full workflow:

### Step 1 — Ingest your exports into `sources/`

```bash
python brain.py ingest ~/Downloads/chatgpt_export.zip ~/Downloads/takeout.zip ~/Downloads/claude.dms
```

This auto-detects each source, splits by year, and writes e.g. `sources/chatgpt_2024.json`, `sources/gemini_2025.json`. Re-running is safe — duplicates are skipped by ID.

### Step 2 — Check stats

```bash
python brain.py stats
```

Shows per-file: conversation count, your word count, AI word count, average message length, and how many messages are flagged as noise pending review.

### Step 3 — Clean interactively, one file at a time

```bash
python brain.py clean --source sources/gemini_2024.json
```

For each flagged message you see the context (previous message shown above it) and the reason it was flagged. You choose:

-   **`k`** — keep it as-is
-   **`d`** — mark removed
-   **`s`** — strip the voice preamble, keep the rest (e.g. "Hey Gemini, explain X" → "explain X")
-   **`a`** — auto-decide everything remaining in this file
-   **`q`** — save and quit

### Step 4 — Export to Obsidian vault

```bash
python brain.py export
```

Writes to `vault/chatgpt/`, `vault/gemini/`, `vault/claude/` — one `.md` per conversation, named `YYYY-MM-DD Title.md`, with YAML frontmatter (`source`, `date`, `model`) that Smart Connections and other Obsidian plugins can index.

### Summary

The `sources/*.json` files stay as the canonical source of truth — the vault is always regeneratable from them. When you later want a different output format (Genspark, Notion, whatever), you just write a new exporter on top of the same source files.
