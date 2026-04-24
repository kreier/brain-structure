import { cmdStats } from './stats';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { Conversation, IngestOptions, Source, SourceData } from './types';
import { parseChatgptJson, parseClaudeJson, parseGeminiFile } from './parsers';
import { SOURCES, SOURCE_LABEL, header, section, info, ok, err, warn } from './utils';

export function yearOfConv(conv: Conversation): number {
  if (conv.created) {
    try {
      return new Date(conv.created).getFullYear();
    } catch {}
  }
  for (const msg of conv.messages) {
    if (msg.ts) {
      try {
        return new Date(msg.ts).getFullYear();
      } catch {}
    }
  }
  return new Date().getFullYear();
}

async function handleBytes(name: string, raw: Buffer, hint?: Source): Promise<Conversation[]> {
  const nl = name.toLowerCase();
  const results: Record<Source, Conversation[]> = {
    chatgpt: [],
    gemini: [],
    claude: [],
  };

  if (nl.endsWith('.json')) {
    try {
      const data = JSON.parse(raw.toString('utf-8'));
      if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
        if ('mapping' in data[0]) {
          results.chatgpt = parseChatgptJson(data);
          return results.chatgpt;
        }
        if ('chat_messages' in data[0] || JSON.stringify(data[0]).slice(0, 200).includes('sender')) {
          results.claude = parseClaudeJson(data);
          return results.claude;
        }
      }
      if (hint === 'gemini' || nl.includes('gemini') || nl.includes('bard')) {
        const conv = parseGeminiFile(name, raw);
        if (conv) results.gemini = [conv];
        return results.gemini;
      }
      const conv = parseGeminiFile(name, raw);
      if (conv) results.gemini = [conv];
    } catch {}
  } else if (nl.endsWith('.html') || nl.endsWith('.htm')) {
    const conv = parseGeminiFile(name, raw);
    if (conv) results.gemini = [conv];
  }

  return Object.values(results).flat();
}

export async function ingestFile(filePath: string, verbose: boolean = false): Promise<Record<Source, Conversation[]>> {
  const results: Record<Source, Conversation[]> = {
    chatgpt: [],
    gemini: [],
    claude: [],
  };

  const stat = await fs.stat(filePath);
  if (stat.isFile()) {
    if (filePath.toLowerCase().endsWith('.zip') || filePath.toLowerCase().endsWith('.dms')) {
      await new Promise<void>((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err);
          zipfile.readEntry();
          zipfile.on('entry', async (entry) => {
            if (entry.fileName.endsWith('/')) {
              zipfile.readEntry();
              return;
            }
            zipfile.openReadStream(entry, async (err, readStream) => {
              if (err) return reject(err);
              const chunks: Buffer[] = [];
              readStream.on('data', chunk => chunks.push(chunk));
              readStream.on('end', async () => {
                const raw = Buffer.concat(chunks);
                const hint = entry.fileName.includes('Gemini') || entry.fileName.includes('gemini') ? 'gemini' : undefined;
                const convs = await handleBytes(entry.fileName, raw, hint);
                for (const conv of convs) {
                  const source = conv.id.startsWith('chatgpt') ? 'chatgpt' :
                                 conv.id.startsWith('claude') ? 'claude' : 'gemini';
                  results[source].push(conv);
                }
                if (verbose) info(`${entry.fileName}: ${convs.length} conversations`);
                zipfile.readEntry();
              });
            });
          });
          zipfile.on('end', resolve);
          zipfile.on('error', reject);
        });
      });
    } else {
      const raw = await fs.readFile(filePath);
      const convs = await handleBytes(path.basename(filePath), raw);
      for (const conv of convs) {
        const source = conv.id.startsWith('chatgpt') ? 'chatgpt' :
                       conv.id.startsWith('claude') ? 'claude' : 'gemini';
        results[source].push(conv);
      }
    }
  } else if (stat.isDirectory()) {
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && ['.json', '.html', '.htm'].some(ext => entry.name.toLowerCase().endsWith(ext))) {
        const fullPath = path.join(filePath, entry.name);
        const raw = await fs.readFile(fullPath);
        const hint = entry.name.toLowerCase().includes('gemini') ? 'gemini' : undefined;
        const convs = await handleBytes(entry.name, raw, hint);
        for (const conv of convs) {
          const source = conv.id.startsWith('chatgpt') ? 'chatgpt' :
                         conv.id.startsWith('claude') ? 'claude' : 'gemini';
          results[source].push(conv);
        }
        if (verbose) info(`${entry.name}: ${convs.length} conversations`);
      }
    }
  }

  return results;
}

export async function cmdIngest(options: IngestOptions): Promise<void> {
  const root = path.resolve(options.root);
  const sourcesDir = path.join(root, 'sources');
  await fs.mkdir(sourcesDir, { recursive: true });

  header('📥  Ingesting Exports');

  const bucket: Record<string, Conversation[]> = {};
  const seenIds = new Set<string>();

  // Load existing
  try {
    const files = await fs.readdir(sourcesDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data: SourceData = JSON.parse(await fs.readFile(path.join(sourcesDir, file), 'utf-8'));
        for (const c of data.conversations) {
          if (c.id) seenIds.add(c.id);
        }
      }
    }
  } catch {}

  for (const inp of options.inputs) {
    const p = path.resolve(inp);
    try {
      await fs.access(p);
    } catch {
      err(`Not found: ${p}`);
      continue;
    }
    section(`Parsing ${path.basename(p)}`);
    const parsed = await ingestFile(p, options.verbose);
    for (const [source, convs] of Object.entries(parsed)) {
      let newCount = 0;
      for (const conv of convs) {
        if (!seenIds.has(conv.id)) {
          seenIds.add(conv.id);
          const year = yearOfConv(conv);
          const key = `${source}_${year}`;
          if (!bucket[key]) bucket[key] = [];
          bucket[key].push(conv);
          newCount++;
        }
      }
      if (newCount) {
        ok(`${SOURCE_LABEL[source as Source] || source}: ${newCount} new conversations`);
      } else {
        info(`${SOURCE_LABEL[source as Source] || source}: no new conversations`);
      }
    }
  }

  if (!Object.keys(bucket).length) {
    warn('Nothing new to write.');
    return;
  }

  section('Writing source files');
  for (const [key, newConvs] of Object.entries(bucket)) {
    const [source, yearStr] = key.split('_');
    const year = parseInt(yearStr);
    const fname = path.join(sourcesDir, `${key}.json`);
    let existing: SourceData;
    try {
      existing = JSON.parse(await fs.readFile(fname, 'utf-8'));
      existing.conversations.push(...newConvs);
    } catch {
      existing = { source, year, conversations: newConvs };
    }
    await fs.writeFile(fname, JSON.stringify(existing, null, 2), 'utf-8');
    ok(`Wrote ${path.relative(root, fname)} (${existing.conversations.length} total conversations)`);
  }

  console.log();
  await cmdStats({ root, verbose: false });
}