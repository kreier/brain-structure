#!/usr/bin/env python3
"""
brain.py  —  AI Conversation Brain Manager
===========================================
Manages a structured archive of conversations from ChatGPT, Gemini, and Claude.

Repository layout this tool maintains:
  brain/
  ├── sources/
  │   ├── chatgpt_2024.json      ← normalized, year-split source files
  │   ├── chatgpt_2025.json
  │   ├── gemini_2024.json
  │   └── claude_2024.json
  ├── vault/
  │   ├── chatgpt/
  │   │   └── 2024-11-14 How Python decorators work.md
  │   ├── gemini/
  │   └── claude/
  └── brain.py                   ← this file

Commands
--------
  brain.py ingest <file|dir> [...]   Parse raw exports → sources/ (year-split)
  brain.py stats                     Print stats for all source files
  brain.py clean [--source FILE]     Interactive noise-removal with confirmation
  brain.py export [--source FILE]    Generate Obsidian vault Markdown

Options for all commands:
  --root DIR      Brain repo root (default: current directory)
  -v, --verbose   Extra output

Usage examples:
  python brain.py ingest ~/Downloads/chatgpt_export.zip ~/Downloads/takeout.zip
  python brain.py stats
  python brain.py clean --source sources/chatgpt_2024.json
  python brain.py export
"""

import argparse
import json
import os
import re
import shutil
import sys
import textwrap
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Colour / terminal helpers  (no external deps)
# ─────────────────────────────────────────────────────────────────────────────

def _supports_color() -> bool:
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

C = _supports_color()

def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if C else text

def bold(t):    return _c("1", t)
def dim(t):     return _c("2", t)
def green(t):   return _c("32", t)
def yellow(t):  return _c("33", t)
def red(t):     return _c("31", t)
def cyan(t):    return _c("36", t)
def magenta(t): return _c("35", t)
def blue(t):    return _c("34", t)

def header(title: str):
    width = min(shutil.get_terminal_size((80, 24)).columns, 88)
    print()
    print(bold(cyan("━" * width)))
    print(bold(f"  {title}"))
    print(bold(cyan("━" * width)))


def section(title: str):
    print(f"\n{bold(yellow('▸'))} {bold(title)}")


def info(msg: str):  print(f"  {dim('·')} {msg}")
def ok(msg: str):    print(f"  {green('✓')} {msg}")
def warn(msg: str):  print(f"  {yellow('⚠')} {msg}")
def err(msg: str):   print(f"  {red('✗')} {msg}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# Unified data model
# ─────────────────────────────────────────────────────────────────────────────

SOURCES = ("chatgpt", "gemini", "claude")
SOURCE_LABEL = {"chatgpt": "ChatGPT", "gemini": "Gemini", "claude": "Claude"}
SOURCE_EMOJI = {"chatgpt": "🤖", "gemini": "♊", "claude": "🟠"}

def _ts(epoch) -> Optional[datetime]:
    if epoch is None:
        return None
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc)
    except (ValueError, OSError, TypeError):
        return None

def _parse_iso(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None

def _clean_text(t: str) -> str:
    t = re.sub(r"\r\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()

def _word_count(text: str) -> int:
    return len(text.split())


# JSON-serialisable schema for sources/
#   {
#     "source": "chatgpt",
#     "conversations": [
#       {
#         "id": "...",
#         "title": "...",
#         "created": "2024-11-14T10:00:00+00:00",
#         "model": "gpt-4o",        # may be null
#         "messages": [
#           {"role": "user"|"assistant"|"system",
#            "text": "...",
#            "ts": "2024-11-14T10:00:01+00:00",   # may be null
#            "removed": false,
#            "remove_reason": null}
#         ]
#       }
#     ]
#   }

def _conv_to_dict(conv_id: str, title: str, created: Optional[datetime],
                  model: Optional[str], messages: list) -> dict:
    return {
        "id": conv_id,
        "title": title,
        "created": created.isoformat() if created else None,
        "model": model,
        "messages": messages,
    }

def _msg_dict(role: str, text: str, ts: Optional[datetime] = None) -> dict:
    return {
        "role": role,
        "text": text,
        "ts": ts.isoformat() if ts else None,
        "removed": False,
        "remove_reason": None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Parsers  (ChatGPT / Gemini / Claude)
# ─────────────────────────────────────────────────────────────────────────────

# ── ChatGPT ──────────────────────────────────────────────────────────────────

def parse_chatgpt_json(data: list) -> list[dict]:
    """Return list of normalised conversation dicts from conversations.json."""
    out = []
    for conv in data:
        title = conv.get("title") or "Untitled"
        created = _ts(conv.get("create_time"))
        mapping = conv.get("mapping", {})

        parent_map = {}
        for node_id, node in mapping.items():
            for child_id in node.get("children", []):
                parent_map[child_id] = node_id

        roots = [nid for nid in mapping if nid not in parent_map]

        def walk(node_id) -> list:
            node = mapping.get(node_id, {})
            result = []
            msg = node.get("message")
            if msg:
                result.append(msg)
            children = node.get("children", [])
            if children:
                result.extend(walk(children[0]))
            return result

        raw_messages = []
        for root in roots:
            raw_messages.extend(walk(root))

        messages = []
        model = None
        for msg in raw_messages:
            author = msg.get("author", {})
            role = author.get("role", "")
            if role not in ("user", "assistant", "system"):
                continue
            content = msg.get("content", {})
            parts = content.get("parts", [])
            text = " ".join(p for p in parts if isinstance(p, str))
            if not text.strip():
                continue
            ts = _ts(msg.get("create_time"))
            if not model:
                meta = msg.get("metadata", {})
                if meta.get("model_slug"):
                    model = meta["model_slug"]
            messages.append(_msg_dict(
                role="assistant" if role == "assistant" else role,
                text=_clean_text(text),
                ts=ts,
            ))

        if messages:
            conv_id = conv.get("id") or f"chatgpt_{len(out)}"
            out.append(_conv_to_dict(conv_id, title, created, model, messages))

    return out


# ── Gemini ────────────────────────────────────────────────────────────────────

class _HTMLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: list[str] = []
        self._role: Optional[str] = None
        self._msgs: list[tuple[str,str]] = []
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class", "")
        if any(x in cls for x in ("user-query", "human-turn", "human")):
            self._flush(); self._role = "user"
        elif any(x in cls for x in ("model-response", "assistant-turn", "assistant", "model")):
            self._flush(); self._role = "assistant"

    def handle_data(self, data):
        if self._role:
            self._buf.append(data)

    def _flush(self):
        if self._role and self._buf:
            text = "".join(self._buf).strip()
            if text:
                self._msgs.append((self._role, text))
        self._buf = []; self._role = None

    @property
    def messages(self):
        self._flush()
        return self._msgs


def _parse_gemini_turns(data) -> list[dict]:
    turns = None
    if isinstance(data, list):
        turns = data
    elif isinstance(data, dict):
        for key in ("conversations", "messages", "turns", "history"):
            if key in data:
                turns = data[key]
                break
    if not turns:
        return []

    msgs = []
    for t in turns:
        if not isinstance(t, dict):
            continue
        role = t.get("role") or t.get("author") or "user"
        if role == "model":
            role = "assistant"
        text = ""
        if "parts" in t:
            text = " ".join(p.get("text","") if isinstance(p,dict) else str(p) for p in t["parts"])
        elif "text" in t:
            text = t["text"]
        elif "content" in t:
            c = t["content"]
            text = c if isinstance(c, str) else " ".join(p.get("text","") if isinstance(p,dict) else str(p) for p in c)
        ts = _ts(t.get("create_time")) or _parse_iso(t.get("timestamp") or "")
        if text.strip():
            msgs.append(_msg_dict(role, _clean_text(text), ts))
    return msgs


def _title_from_msgs(msgs: list[dict], fallback: str = "Untitled") -> str:
    for m in msgs:
        if m["role"] == "user" and len(m["text"]) > 5:
            t = m["text"]
            return (t[:60] + "…") if len(t) > 60 else t
    return fallback


def parse_gemini_file(name: str, raw: bytes) -> Optional[dict]:
    nl = name.lower()
    msgs = []
    if nl.endswith(".json"):
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
            msgs = _parse_gemini_turns(data)
        except json.JSONDecodeError:
            return None
    elif nl.endswith((".html", ".htm")):
        parser = _HTMLStripper()
        parser.feed(raw.decode("utf-8", errors="replace"))
        msgs = [_msg_dict(r, _clean_text(t)) for r, t in parser.messages]

    if not msgs:
        return None

    stem = Path(name).stem
    return _conv_to_dict(
        conv_id=stem,
        title=_title_from_msgs(msgs, stem),
        created=next((m["ts"] for m in msgs if m.get("ts")), None),
        model=None,
        messages=msgs,
    )


# ── Claude ─────────────────────────────────────────────────────────────────────

def parse_claude_json(data: list) -> list[dict]:
    out = []
    for conv in data:
        title = conv.get("name") or conv.get("title") or "Untitled"
        created = _parse_iso(conv.get("created_at") or "") or _ts(conv.get("create_time"))
        raw_msgs = conv.get("chat_messages") or conv.get("messages") or []
        messages = []
        for msg in raw_msgs:
            sender = msg.get("sender") or msg.get("role") or "user"
            role = "user" if sender in ("human","user") else "assistant" if sender in ("assistant","ai","claude") else sender
            content = msg.get("text") or msg.get("content") or ""
            if isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, str):
                        parts.append(block)
                    elif isinstance(block, dict):
                        parts.append(block.get("text") or block.get("content") or "")
                content = "\n".join(parts)
            ts = _parse_iso(msg.get("created_at") or "") or _ts(msg.get("timestamp"))
            if content.strip():
                messages.append(_msg_dict(role, _clean_text(content), ts))

        if messages:
            conv_id = conv.get("uuid") or conv.get("id") or f"claude_{len(out)}"
            out.append(_conv_to_dict(conv_id, title, created, None, messages))

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Source detection & ingestion
# ─────────────────────────────────────────────────────────────────────────────

def _year_of_conv(conv: dict) -> int:
    if conv.get("created"):
        try:
            return datetime.fromisoformat(conv["created"].replace("Z", "+00:00")).year
        except ValueError:
            pass
    # Try first message timestamp
    for msg in conv.get("messages", []):
        if msg.get("ts"):
            try:
                return datetime.fromisoformat(msg["ts"].replace("Z", "+00:00")).year
            except ValueError:
                pass
    return datetime.now().year


def ingest_file(path: Path, verbose: bool = False) -> dict[str, list[dict]]:
    """
    Parse a raw export file/folder.
    Returns {source_name: [conv_dict, ...]}
    """
    results: dict[str, list] = defaultdict(list)

    def handle_bytes(name: str, raw: bytes, hint: Optional[str] = None):
        nl = name.lower()

        # Sniff JSON
        if nl.endswith(".json"):
            try:
                data = json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                return

            if isinstance(data, list) and data and isinstance(data[0], dict):
                # ChatGPT: has "mapping" key
                if "mapping" in data[0]:
                    convs = parse_chatgpt_json(data)
                    results["chatgpt"].extend(convs)
                    if verbose:
                        info(f"ChatGPT {Path(name).name}: {len(convs)} conversations")
                    return
                # Claude: has "chat_messages" or "sender" somewhere
                if "chat_messages" in data[0] or "sender" in str(data[0])[:200]:
                    convs = parse_claude_json(data)
                    results["claude"].extend(convs)
                    if verbose:
                        info(f"Claude {Path(name).name}: {len(convs)} conversations")
                    return

            # Gemini per-file JSON (single conv)
            if hint == "gemini" or "gemini" in nl or "bard" in nl:
                conv = parse_gemini_file(name, raw)
                if conv:
                    results["gemini"].append(conv)
                    if verbose:
                        info(f"Gemini {Path(name).name}: 1 conversation")
                return

            # Try Gemini anyway
            conv = parse_gemini_file(name, raw)
            if conv:
                results["gemini"].append(conv)

        elif nl.endswith((".html", ".htm")):
            conv = parse_gemini_file(name, raw)
            if conv:
                results["gemini"].append(conv)
                if verbose:
                    info(f"Gemini HTML {Path(name).name}: 1 conversation")

    # ZIP / DMS
    if path.suffix.lower() in (".zip", ".dms"):
        with zipfile.ZipFile(path) as zf:
            entries = zf.namelist()

        with zipfile.ZipFile(path) as zf:
            has_gemini = any("Gemini" in e or "gemini" in e for e in entries)
            has_cjson  = any(e.endswith("conversations.json") for e in entries)

            for name in entries:
                if name.endswith("/"):
                    continue
                raw = zf.read(name)
                hint = "gemini" if has_gemini else None
                handle_bytes(name, raw, hint)

    # Directory
    elif path.is_dir():
        for child in sorted(path.rglob("*")):
            if child.is_file() and child.suffix.lower() in (".json", ".html", ".htm"):
                hint = "gemini" if "gemini" in str(child).lower() else None
                handle_bytes(str(child), child.read_bytes(), hint)

    # Single file
    elif path.is_file():
        handle_bytes(path.name, path.read_bytes())

    return dict(results)


# ─────────────────────────────────────────────────────────────────────────────
# Cleanup — noise detection
# ─────────────────────────────────────────────────────────────────────────────

VOICE_RE = [
    re.compile(r"^(hey\s+)?(ok\s+)?google[,.]?\s*", re.I),
    re.compile(r"^(hey\s+)?gemini[,.]?\s*", re.I),
    re.compile(r"^(hey\s+)?siri[,.]?\s*", re.I),
    re.compile(r"^(ok\s+)?bixby[,.]?\s*", re.I),
    re.compile(r"^(hey\s+)?cortana[,.]?\s*", re.I),
    re.compile(r"^(hey\s+)?alexa[,.]?\s*", re.I),
]

TIME_RE = [
    re.compile(r"^what.{0,15}time.{0,20}\??$", re.I),
    re.compile(r"^what.{0,15}(date|day).{0,20}\??$", re.I),
    re.compile(r"^(what'?s?|how'?s?)\s+the\s+weather.{0,30}\??$", re.I),
    re.compile(r"^set\s+(a\s+)?(timer|alarm|reminder)\s+(for\s+)?.{1,60}$", re.I),
    re.compile(r"^what.{0,10}year.{0,10}\??$", re.I),
]

TRIVIAL_RE = [
    re.compile(r"^(ok|okay|sure|thanks?|thank you|got it|alright|yes|no|yep|nope|great|cool|nice)[.!?]?$", re.I),
    re.compile(r"^(stop|cancel|pause|resume|next|back|go\s+back)[.!?]?$", re.I),
    re.compile(r"^\s*$"),
]


def _detect_noise(msg: dict) -> Optional[str]:
    """Return a reason string if this message looks like noise, else None."""
    if msg["role"] != "user":
        return None
    text = msg["text"]

    for pat in VOICE_RE:
        if pat.match(text):
            # Check if after stripping the preamble there's nothing of value
            remainder = pat.sub("", text).strip()
            for tpat in TIME_RE:
                if tpat.match(remainder):
                    return f"voice preamble + time query"
            for trivpat in TRIVIAL_RE:
                if trivpat.match(remainder):
                    return f"voice preamble + trivial"
            if not remainder:
                return "empty after stripping voice preamble"

    for pat in TIME_RE:
        if pat.match(text.strip()):
            return "time/date/weather/timer query"

    for pat in TRIVIAL_RE:
        if pat.match(text.strip()):
            return "trivial utterance"

    if len(text.strip()) < 3:
        return "too short (< 3 chars)"

    return None


def _strip_voice_prefix(text: str) -> str:
    for pat in VOICE_RE:
        text = pat.sub("", text).strip()
    return text


# ─────────────────────────────────────────────────────────────────────────────
# Stats
# ─────────────────────────────────────────────────────────────────────────────

def cmd_stats(root: Path):
    sources_dir = root / "sources"
    if not sources_dir.exists():
        err("No sources/ directory found. Run 'ingest' first.")
        return

    files = sorted(sources_dir.glob("*.json"))
    if not files:
        warn("No source files found in sources/")
        return

    header("📊  Brain Stats")

    grand = {"convs": 0, "msgs": 0, "user_words": 0, "ai_words": 0, "noise": 0}

    for fpath in files:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        convs = data.get("conversations", [])
        source = data.get("source", fpath.stem)

        n_convs = len(convs)
        n_msgs = sum(len(c["messages"]) for c in convs)
        user_words = sum(
            _word_count(m["text"]) for c in convs for m in c["messages"]
            if m["role"] == "user" and not m.get("removed")
        )
        ai_words = sum(
            _word_count(m["text"]) for c in convs for m in c["messages"]
            if m["role"] == "assistant" and not m.get("removed")
        )
        noise = sum(
            1 for c in convs for m in c["messages"] if m.get("removed")
        )
        pending_noise = sum(
            1 for c in convs for m in c["messages"]
            if not m.get("removed") and _detect_noise(m)
        )

        avg_user = user_words // max(
            sum(1 for c in convs for m in c["messages"] if m["role"] == "user" and not m.get("removed")), 1
        )
        avg_ai = ai_words // max(
            sum(1 for c in convs for m in c["messages"] if m["role"] == "assistant" and not m.get("removed")), 1
        )

        emoji = SOURCE_EMOJI.get(source.split("_")[0], "💬")
        section(f"{emoji}  {fpath.name}")
        print(f"    Conversations : {bold(str(n_convs))}")
        print(f"    Messages      : {n_msgs}")
        print(f"    Your words    : {user_words:,}  (avg {avg_user} per message)")
        print(f"    AI words      : {ai_words:,}  (avg {avg_ai} per message)")
        if noise:
            print(f"    Removed noise : {red(str(noise))}")
        if pending_noise:
            print(f"    Pending review: {yellow(str(pending_noise))} messages flagged as noise")

        grand["convs"]      += n_convs
        grand["msgs"]       += n_msgs
        grand["user_words"] += user_words
        grand["ai_words"]   += ai_words
        grand["noise"]      += noise

    section("Totals")
    print(f"    Conversations : {bold(str(grand['convs']))}")
    print(f"    Messages      : {grand['msgs']}")
    print(f"    Your words    : {grand['user_words']:,}")
    print(f"    AI words      : {grand['ai_words']:,}")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# Ingest
# ─────────────────────────────────────────────────────────────────────────────

def cmd_ingest(inputs: list[str], root: Path, verbose: bool = False):
    sources_dir = root / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    header("📥  Ingesting Exports")

    # Collect all conversations grouped by (source, year)
    bucket: dict[tuple[str,int], list[dict]] = defaultdict(list)
    seen_ids: set[str] = set()

    # Load existing source files to avoid duplicates
    for fpath in sources_dir.glob("*.json"):
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            for c in data.get("conversations", []):
                if c.get("id"):
                    seen_ids.add(c["id"])
        except Exception:
            pass

    for inp in inputs:
        p = Path(inp)
        if not p.exists():
            err(f"Not found: {p}")
            continue
        section(f"Parsing {p.name}")
        parsed = ingest_file(p, verbose=verbose)
        for source, convs in parsed.items():
            new_count = 0
            for conv in convs:
                if conv["id"] in seen_ids:
                    continue
                seen_ids.add(conv["id"])
                year = _year_of_conv(conv)
                bucket[(source, year)].append(conv)
                new_count += 1
            if new_count:
                ok(f"{SOURCE_LABEL.get(source, source)}: {new_count} new conversations")
            else:
                info(f"{SOURCE_LABEL.get(source, source)}: no new conversations (all already imported)")

    if not bucket:
        warn("Nothing new to write.")
        return

    # Merge into existing source files
    section("Writing source files")
    for (source, year), new_convs in sorted(bucket.items()):
        fname = sources_dir / f"{source}_{year}.json"
        if fname.exists():
            existing = json.loads(fname.read_text(encoding="utf-8"))
            existing["conversations"].extend(new_convs)
        else:
            existing = {"source": source, "year": year, "conversations": new_convs}
        fname.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
        ok(f"Wrote {fname.relative_to(root)}  ({len(existing['conversations'])} total conversations)")

    print()
    cmd_stats(root)


# ─────────────────────────────────────────────────────────────────────────────
# Interactive clean
# ─────────────────────────────────────────────────────────────────────────────

CLEAN_HELP = (
    f"  {bold('[k]eep')}   keep this message as-is\n"
    f"  {bold('[d]elete')} mark as removed\n"
    f"  {bold('[s]trip')}  strip voice preamble, keep remainder\n"
    f"  {bold('[a]uto')}   auto-decide all remaining in this file\n"
    f"  {bold('[q]uit')}   save & quit\n"
    f"  {bold('[?]')}      show this help"
)


def _print_message_context(conv: dict, msg_idx: int, flagged_reason: str):
    conv_title = conv["title"]
    msgs = conv["messages"]
    msg = msgs[msg_idx]

    width = min(shutil.get_terminal_size((80,24)).columns, 88)
    print("\n" + cyan("─" * width))
    print(f"  {bold('Conv:')} {conv_title}")
    print(f"  {bold('Flag:')} {yellow(flagged_reason)}")

    # Print one message of context before
    if msg_idx > 0:
        prev = msgs[msg_idx - 1]
        label = "You" if prev["role"] == "user" else "AI"
        colour = dim
        wrapped = textwrap.fill(prev["text"][:300], width=width-12,
                                initial_indent="    ", subsequent_indent="    ")
        print(f"\n  {colour(label+':')} {dim('(context)')}")
        print(colour(wrapped))

    # The flagged message
    label = bold("You") if msg["role"] == "user" else bold("AI")
    wrapped = textwrap.fill(msg["text"][:500], width=width-12,
                            initial_indent="    ", subsequent_indent="    ")
    print(f"\n  {red('→')} {label}{red(':')} {yellow('[flagged]')}")
    print(yellow(wrapped))
    print(cyan("─" * width))


def cmd_clean(root: Path, source_file: Optional[str] = None):
    sources_dir = root / "sources"

    if source_file:
        files = [Path(source_file)]
        if not files[0].exists():
            files = [sources_dir / source_file]
    else:
        files = sorted(sources_dir.glob("*.json"))

    if not files:
        warn("No source files to clean.")
        return

    header("🧹  Interactive Clean")
    print(f"\n{CLEAN_HELP}\n")

    for fpath in files:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        convs = data.get("conversations", [])
        source = data.get("source", "?")

        # Collect all flagged messages
        flagged: list[tuple[dict, int, str]] = []  # (conv, msg_idx, reason)
        for conv in convs:
            for i, msg in enumerate(conv["messages"]):
                if msg.get("removed"):
                    continue
                reason = _detect_noise(msg)
                if reason:
                    flagged.append((conv, i, reason))

        if not flagged:
            ok(f"{fpath.name}: no noise detected")
            continue

        section(f"{SOURCE_EMOJI.get(source,'?')}  {fpath.name}  —  {len(flagged)} messages to review")

        auto_mode = False
        quit_flag = False
        changed = False

        for j, (conv, msg_idx, reason) in enumerate(flagged):
            msg = conv["messages"][msg_idx]

            if auto_mode:
                # Auto: strip voice prefix if that leaves something meaningful, else delete
                stripped = _strip_voice_prefix(msg["text"])
                if stripped and len(stripped) > 3 and not any(p.match(stripped) for p in TIME_RE+TRIVIAL_RE):
                    msg["text"] = stripped
                    msg["remove_reason"] = f"auto-stripped: {reason}"
                else:
                    msg["removed"] = True
                    msg["remove_reason"] = f"auto-removed: {reason}"
                changed = True
                continue

            _print_message_context(conv, msg_idx, reason)
            print(f"  {dim(f'({j+1}/{len(flagged)})')}  {bold('[k/d/s/a/q/?]')} ", end="", flush=True)

            while True:
                try:
                    ch = input().strip().lower()
                except (EOFError, KeyboardInterrupt):
                    ch = "q"

                if ch in ("k", "keep", ""):
                    break
                elif ch in ("d", "delete"):
                    msg["removed"] = True
                    msg["remove_reason"] = reason
                    changed = True
                    print(f"  {red('Removed.')}")
                    break
                elif ch in ("s", "strip"):
                    stripped = _strip_voice_prefix(msg["text"])
                    if stripped:
                        msg["text"] = stripped
                        msg["remove_reason"] = f"stripped preamble: {reason}"
                        changed = True
                        print(f"  {green('Stripped to:')} {stripped[:80]}")
                    else:
                        msg["removed"] = True
                        msg["remove_reason"] = f"stripped (nothing left): {reason}"
                        changed = True
                        print(f"  {red('Nothing left after strip — removed.')}")
                    break
                elif ch in ("a", "auto"):
                    auto_mode = True
                    print(f"  {cyan('Auto mode — processing remaining automatically.')}")
                    stripped = _strip_voice_prefix(msg["text"])
                    if stripped and len(stripped) > 3 and not any(p.match(stripped) for p in TIME_RE+TRIVIAL_RE):
                        msg["text"] = stripped
                    else:
                        msg["removed"] = True
                        msg["remove_reason"] = f"auto-removed: {reason}"
                    changed = True
                    break
                elif ch in ("q", "quit"):
                    quit_flag = True
                    break
                elif ch == "?":
                    print(f"\n{CLEAN_HELP}\n")
                    print(f"  {dim(f'({j+1}/{len(flagged)})')}  {bold('[k/d/s/a/q/?]')} ", end="", flush=True)
                else:
                    print(f"  {dim('Unknown — type k/d/s/a/q/? ')} ", end="", flush=True)

            if quit_flag:
                break

        if changed:
            fpath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            ok(f"Saved {fpath.name}")

        if quit_flag:
            warn("Quit early — remaining files skipped.")
            break

    print()


# ─────────────────────────────────────────────────────────────────────────────
# Obsidian vault export
# ─────────────────────────────────────────────────────────────────────────────

ROLE_LABEL = {"user": "**You**", "assistant": "**AI**", "system": "*System*"}

def _slug(text: str) -> str:
    """Make a filesystem-safe slug."""
    text = re.sub(r"[^\w\s\-]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:80]


def _render_conv_md(conv: dict, source: str) -> str:
    lines = []
    lines.append(f"---")
    lines.append(f"source: {source}")
    if conv.get("created"):
        lines.append(f"date: {conv['created'][:10]}")
    if conv.get("model"):
        lines.append(f"model: {conv['model']}")
    lines.append(f"title: \"{conv['title'].replace(chr(34), chr(39))}\"")
    lines.append(f"---\n")
    lines.append(f"# {conv['title']}\n")

    for msg in conv["messages"]:
        if msg.get("removed"):
            continue
        role_label = ROLE_LABEL.get(msg["role"], f"**{msg['role']}**")
        ts = ""
        if msg.get("ts"):
            try:
                ts = f"  _{datetime.fromisoformat(msg['ts'].replace('Z','+00:00')).strftime('%H:%M')}_"
            except ValueError:
                pass
        lines.append(f"{role_label}{ts}:\n")
        for line in msg["text"].split("\n"):
            lines.append(f"> {line}" if line.strip() else ">")
        lines.append("")

    return "\n".join(lines)


def cmd_export(root: Path, source_file: Optional[str] = None, verbose: bool = False):
    sources_dir = root / "sources"
    vault_dir   = root / "vault"

    if source_file:
        files = [Path(source_file)]
        if not files[0].exists():
            files = [sources_dir / source_file]
    else:
        files = sorted(sources_dir.glob("*.json"))

    if not files:
        warn("No source files found. Run 'ingest' first.")
        return

    header("📓  Exporting to Obsidian Vault")

    total_written = 0

    for fpath in files:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        source = data.get("source", "unknown")
        convs = data.get("conversations", [])

        out_dir = vault_dir / source
        out_dir.mkdir(parents=True, exist_ok=True)

        written = 0
        for conv in convs:
            active_msgs = [m for m in conv["messages"] if not m.get("removed")]
            if not active_msgs:
                continue

            # File name: YYYY-MM-DD Title.md
            date_prefix = ""
            if conv.get("created"):
                date_prefix = conv["created"][:10] + " "

            fname = out_dir / f"{date_prefix}{_slug(conv['title'])}.md"
            md = _render_conv_md(conv, source)
            fname.write_text(md, encoding="utf-8")
            written += 1
            if verbose:
                info(f"  {fname.relative_to(root)}")

        ok(f"{source}: {written} notes → vault/{source}/")
        total_written += written

    print()
    ok(f"Total: {total_written} Obsidian notes written to {vault_dir.relative_to(root)}/")
    print()
    info("Vault structure:")
    for d in sorted(vault_dir.iterdir()):
        if d.is_dir():
            count = len(list(d.glob("*.md")))
            print(f"    vault/{d.name}/  ({count} notes)")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="brain.py",
        description="AI Conversation Brain Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--root", default=".", metavar="DIR",
                        help="Brain repo root directory (default: .)")
    parser.add_argument("-v", "--verbose", action="store_true")

    sub = parser.add_subparsers(dest="cmd", required=True)

    # ingest
    def _av(p):
        p.add_argument("-v", "--verbose", action="store_true")
        return p

    p_ingest = _av(sub.add_parser("ingest", help="Parse raw exports into sources/"))
    p_ingest.add_argument("inputs", nargs="+", metavar="FILE",
                          help="Export file(s) or folder(s)")

    # stats
    sub.add_parser("stats", help="Show statistics for all source files")

    # clean
    p_clean = sub.add_parser("clean", help="Interactive noise removal")
    p_clean.add_argument("--source", metavar="FILE",
                         help="Specific source file to clean (default: all)")

    # export
    p_export = _av(sub.add_parser("export", help="Generate Obsidian vault Markdown"))
    p_export.add_argument("--source", metavar="FILE",
                          help="Specific source file to export (default: all)")

    args = parser.parse_args()
    root = Path(args.root).resolve()
    verbose = getattr(args, "verbose", False)

    if args.cmd == "ingest":
        cmd_ingest(args.inputs, root, verbose=verbose)
    elif args.cmd == "stats":
        cmd_stats(root)
    elif args.cmd == "clean":
        cmd_clean(root, getattr(args, "source", None))
    elif args.cmd == "export":
        cmd_export(root, getattr(args, "source", None), verbose=verbose)


if __name__ == "__main__":
    main()
    