import * as cheerio from 'cheerio';
import { Conversation, Message, Source } from './types';
import { ts, parseIso, cleanText, wordCount } from './utils';

export function convToDict(
  convId: string,
  title: string,
  created: Date | null,
  model: string | null,
  messages: Message[]
): Conversation {
  return {
    id: convId,
    title,
    created: created ? created.toISOString() : undefined,
    model: model || undefined,
    messages,
  };
}

export function msgDict(role: 'user' | 'assistant' | 'system', text: string, ts?: Date | null): Message {
  return {
    role,
    text,
    ts: ts ? ts.toISOString() : undefined,
    removed: false,
  };
}

// ChatGPT parser
export function parseChatgptJson(data: any[]): Conversation[] {
  const out: Conversation[] = [];
  for (const conv of data) {
    const title = conv.title || 'Untitled';
    const created = ts(conv.create_time);
    const mapping = conv.mapping || {};

    const parentMap: Record<string, string> = {};
    for (const [nodeId, node] of Object.entries(mapping)) {
      for (const childId of (node as any).children || []) {
        parentMap[childId] = nodeId;
      }
    }

    const roots = Object.keys(mapping).filter(nid => !(nid in parentMap));

    const walk = (nodeId: string): any[] => {
      const node = mapping[nodeId] as any;
      const result = [];
      const msg = node.message;
      if (msg) result.push(msg);
      const children = node.children || [];
      if (children.length) result.push(...walk(children[0]));
      return result;
    };

    const rawMessages: any[] = [];
    for (const root of roots) {
      rawMessages.push(...walk(root));
    }

    const messages: Message[] = [];
    let model: string | null = null;
    for (const msg of rawMessages) {
      const author = msg.author || {};
      const role = author.role;
      if (!['user', 'assistant', 'system'].includes(role)) continue;
      const content = msg.content || {};
      const parts = content.parts || [];
      const text = parts.filter((p: any) => typeof p === 'string').join('');
      if (!text.trim()) continue;
      const msgTs = ts(msg.create_time);
      if (!model) {
        const meta = msg.metadata || {};
        if (meta.model_slug) model = meta.model_slug;
      }
      messages.push(msgDict(role === 'assistant' ? 'assistant' : role, cleanText(text), msgTs));
    }

    if (messages.length) {
      const convId = conv.id || `chatgpt_${out.length}`;
      out.push(convToDict(convId, title, created, model, messages));
    }
  }
  return out;
}

// Gemini parsers
function parseGeminiTurns(data: any): Message[] {
  let turns: any[] = [];
  if (Array.isArray(data)) {
    turns = data;
  } else if (data && typeof data === 'object') {
    turns = data.conversations || data.messages || data.turns || data.history || [];
  }
  const msgs: Message[] = [];
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;
    let role = t.role || t.author || 'user';
    if (role === 'model') role = 'assistant';
    let text = '';
    if (t.parts) {
      text = t.parts.map((p: any) => (typeof p === 'object' ? p.text || '' : p)).join('');
    } else if (t.text) {
      text = t.text;
    } else if (t.content) {
      const c = t.content;
      text = typeof c === 'string' ? c : c.map((p: any) => (typeof p === 'object' ? p.text || '' : p)).join('');
    }
    const msgTs = ts(t.create_time) || parseIso(t.timestamp || '');
    if (text.trim()) {
      msgs.push(msgDict(role, cleanText(text), msgTs));
    }
  }
  return msgs;
}

function titleFromMsgs(msgs: Message[], fallback: string = 'Untitled'): string {
  for (const m of msgs) {
    if (m.role === 'user' && m.text.length > 5) {
      const t = m.text;
      return t.length > 60 ? t.substring(0, 60) + '…' : t;
    }
  }
  return fallback;
}

export function parseGeminiFile(name: string, raw: Buffer): Conversation | null {
  const nl = name.toLowerCase();
  let msgs: Message[] = [];
  if (nl.endsWith('.json')) {
    try {
      const data = JSON.parse(raw.toString('utf-8'));
      msgs = parseGeminiTurns(data);
    } catch {
      return null;
    }
  } else if (nl.endsWith('.html') || nl.endsWith('.htm')) {
    const $ = cheerio.load(raw.toString('utf-8'));
    let role: 'user' | 'assistant' | null = null;
    const parts: string[] = [];
    $('*').each((_, el) => {
      const cls = $(el).attr('class') || '';
      if (cls.includes('user-query') || cls.includes('human-turn') || cls.includes('human')) {
        if (role) parts.push('');
        role = 'user';
      } else if (cls.includes('model-response') || cls.includes('assistant-turn') || cls.includes('assistant') || cls.includes('model')) {
        if (role) parts.push('');
        role = 'assistant';
      }
      if (role) {
        const text = $(el).text().trim();
        if (text) parts.push(text);
      }
    });
    let currentRole: 'user' | 'assistant' | null = null;
    let currentText = '';
    for (const part of parts) {
      if (part === '') {
        if (currentRole && currentText.trim()) {
          msgs.push(msgDict(currentRole, cleanText(currentText)));
        }
        currentRole = null;
        currentText = '';
      } else {
        if (!currentRole) {
          // Assume alternating, but since cheerio parsing might not be perfect, this is simplified
          // Original uses HTMLParser, this is an approximation
        }
        currentText += part + ' ';
      }
    }
    if (currentRole && currentText.trim()) {
      msgs.push(msgDict(currentRole, cleanText(currentText)));
    }
  }

  if (!msgs.length) return null;

  const stem = name.split('.').slice(0, -1).join('.');
  return convToDict(
    stem,
    titleFromMsgs(msgs, stem),
    msgs.find(m => m.ts) ? new Date(msgs.find(m => m.ts)!.ts!) : null,
    null,
    msgs
  );
}

// Claude parser
export function parseClaudeJson(data: any[]): Conversation[] {
  const out: Conversation[] = [];
  for (const conv of data) {
    const title = conv.name || conv.title || 'Untitled';
    const created = parseIso(conv.created_at || '') || ts(conv.create_time);
    const rawMsgs = conv.chat_messages || conv.messages || [];
    const messages: Message[] = [];
    for (const msg of rawMsgs) {
      const sender = msg.sender || msg.role || 'user';
      const role = sender === 'human' || sender === 'user' ? 'user' :
                   sender === 'assistant' || sender === 'ai' || sender === 'claude' ? 'assistant' : sender;
      let content = msg.text || msg.content || '';
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block === 'string') {
            parts.push(block);
          } else if (block && typeof block === 'object') {
            parts.push(block.text || block.content || '');
          }
        }
        content = parts.join('\n');
      }
      const msgTs = parseIso(msg.created_at || '') || ts(msg.timestamp);
      if (content.trim()) {
        messages.push(msgDict(role, cleanText(content), msgTs));
      }
    }

    if (messages.length) {
      const convId = conv.uuid || conv.id || `claude_${out.length}`;
      out.push(convToDict(convId, title, created, null, messages));
    }
  }
  return out;
}