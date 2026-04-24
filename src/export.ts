import { promises as fs } from 'fs';
import * as path from 'path';
import { ExportOptions, Conversation, Message, SourceData } from './types';
import { header, section, ok, warn, info, bold, dim, slug } from './utils';

const ROLE_LABEL: Record<string, string> = {
  user: '**You**',
  assistant: '**AI**',
  system: '*System*',
};

function renderConvMd(conv: Conversation, source: string): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('source: ' + source);
  if (conv.created) {
    lines.push('date: ' + conv.created.substring(0, 10));
  }
  if (conv.model) {
    lines.push('model: ' + conv.model);
  }
  lines.push('title: "' + conv.title.replace(/"/g, "'") + '"');
  lines.push('---\n');
  lines.push('# ' + conv.title + '\n');

  for (const msg of conv.messages) {
    if (msg.removed) continue;
    const roleLabel = ROLE_LABEL[msg.role] || '**' + msg.role + '**';
    let ts = '';
    if (msg.ts) {
      try {
        ts = '  _' + new Date(msg.ts).toISOString().substring(11, 16) + '_';
      } catch {}
    }
    lines.push(roleLabel + ts + ':');
    for (const line of msg.text.split('\n')) {
      lines.push(line ? '> ' + line : '>');
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function cmdExport(options: ExportOptions): Promise<void> {
  const root = path.resolve(options.root);
  const sourcesDir = path.join(root, 'sources');
  const vaultDir = path.join(root, 'vault');

  let files: string[];
  if (options.source) {
    files = [options.source];
    if (!files[0].includes(path.sep)) {
      files = [path.join(sourcesDir, options.source)];
    }
  } else {
    try {
      files = (await fs.readdir(sourcesDir)).filter(f => f.endsWith('.json')).map(f => path.join(sourcesDir, f));
    } catch {
      files = [];
    }
  }

  if (!files.length) {
    warn('No source files found. Run \'ingest\' first.');
    return;
  }

  header('📓  Exporting to Obsidian Vault');

  let totalWritten = 0;

  for (const fpath of files) {
    const data: SourceData = JSON.parse(await fs.readFile(fpath, 'utf-8'));
    const source = data.source;
    const convs = data.conversations;

    const outDir = path.join(vaultDir, source);
    await fs.mkdir(outDir, { recursive: true });

    let written = 0;
    for (const conv of convs) {
      const activeMsgs = conv.messages.filter(m => !m.removed);
      if (!activeMsgs.length) continue;

      let datePrefix = '';
      if (conv.created) {
        datePrefix = conv.created.substring(0, 10) + ' ';
      }

      const fname = path.join(outDir, datePrefix + slug(conv.title) + '.md');
      const md = renderConvMd(conv, source);
      await fs.writeFile(fname, md, 'utf-8');
      written++;
      if (options.verbose) {
        info(`  ${path.relative(root, fname)}`);
      }
    }

    ok(`${source}: ${written} notes → vault/${source}/`);
    totalWritten += written;
  }

  console.log();
  ok(`Total: ${totalWritten} Obsidian notes written to ${path.relative(root, vaultDir)}/`);
  console.log();
  info('Vault structure:');
  try {
    const dirs = await fs.readdir(vaultDir);
    for (const d of dirs) {
      const stat = await fs.stat(path.join(vaultDir, d));
      if (stat.isDirectory()) {
        const count = (await fs.readdir(path.join(vaultDir, d))).filter(f => f.endsWith('.md')).length;
        console.log(`    vault/${d}/  (${count} notes)`);
      }
    }
  } catch {}
  console.log();
}