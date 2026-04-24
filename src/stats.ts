import { promises as fs } from 'fs';
import * as path from 'path';
import { CommandOptions, SourceData } from './types';
import { SOURCE_EMOJI, header, section, bold, red, yellow, wordCount } from './utils';

export async function cmdStats(options: CommandOptions): Promise<void> {
  const root = path.resolve(options.root);
  const sourcesDir = path.join(root, 'sources');

  try {
    await fs.access(sourcesDir);
  } catch {
    console.error('No sources/ directory found. Run \'ingest\' first.');
    return;
  }

  const files = (await fs.readdir(sourcesDir)).filter(f => f.endsWith('.json')).sort();

  if (!files.length) {
    console.warn('No source files found in sources/');
    return;
  }

  header('📊  Brain Stats');

  let grand = { convs: 0, msgs: 0, userWords: 0, aiWords: 0, noise: 0 };

  for (const fpath of files) {
    const fullPath = path.join(sourcesDir, fpath);
    const data: SourceData = JSON.parse(await fs.readFile(fullPath, 'utf-8'));
    const convs = data.conversations;
    const source = data.source;

    const nConvs = convs.length;
    const nMsgs = convs.reduce((sum, c) => sum + c.messages.length, 0);
    const userWords = convs.reduce((sum, c) =>
      sum + c.messages.filter(m => m.role === 'user' && !m.removed).reduce((s, m) => s + wordCount(m.text), 0), 0);
    const aiWords = convs.reduce((sum, c) =>
      sum + c.messages.filter(m => m.role === 'assistant' && !m.removed).reduce((s, m) => s + wordCount(m.text), 0), 0);
    const noise = convs.reduce((sum, c) => sum + c.messages.filter(m => m.removed).length, 0);
    const pendingNoise = convs.reduce((sum, c) =>
      sum + c.messages.filter(m => !m.removed && detectNoise(m)).length, 0);

    const avgUser = userWords / Math.max(convs.reduce((sum, c) =>
      sum + c.messages.filter(m => m.role === 'user' && !m.removed).length, 0), 1);
    const avgAi = aiWords / Math.max(convs.reduce((sum, c) =>
      sum + c.messages.filter(m => m.role === 'assistant' && !m.removed).length, 0), 1);

    const emoji = SOURCE_EMOJI[source as keyof typeof SOURCE_EMOJI] || '💬';
    section(`${emoji}  ${fpath}`);
    console.log(`    Conversations : ${bold(nConvs.toString())}`);
    console.log(`    Messages      : ${nMsgs}`);
    console.log(`    Your words    : ${userWords.toLocaleString()}  (avg ${avgUser.toFixed(0)} per message)`);
    console.log(`    AI words      : ${aiWords.toLocaleString()}  (avg ${avgAi.toFixed(0)} per message)`);
    if (noise) {
      console.log(`    Removed noise : ${red(noise.toString())}`);
    }
    if (pendingNoise) {
      console.log(`    Pending review: ${yellow(pendingNoise.toString())} messages flagged as noise`);
    }

    grand.convs += nConvs;
    grand.msgs += nMsgs;
    grand.userWords += userWords;
    grand.aiWords += aiWords;
    grand.noise += noise;
  }

  section('Totals');
  console.log(`    Conversations : ${bold(grand.convs.toString())}`);
  console.log(`    Messages      : ${grand.msgs}`);
  console.log(`    Your words    : ${grand.userWords.toLocaleString()}`);
  console.log(`    AI words      : ${grand.aiWords.toLocaleString()}`);
  console.log();
}

function detectNoise(msg: { role: string; text: string }): string | null {
  if (msg.role !== 'user') return null;
  const text = msg.text;

  const voiceRe = [
    /^hey\s+google[,.]?\s*/i,
    /^hey\s+gemini[,.]?\s*/i,
    /^hey\s+siri[,.]?\s*/i,
    /^ok\s+bixby[,.]?\s*/i,
    /^hey\s+cortana[,.]?\s*/i,
    /^hey\s+alexa[,.]?\s*/i,
  ];

  const timeRe = [
    /^what.{0,15}time.{0,20}\??$/i,
    /^what.{0,15}(date|day).{0,20}\??$/i,
    /^(what'?s?|how'?s?)\s+the\s+weather.{0,30}\??$/i,
    /^set\s+(a\s+)?(timer|alarm|reminder)\s+(for\s+)?.{1,60}$/i,
    /^what.{0,10}year.{0,10}\??$/i,
  ];

  const trivialRe = [
    /^(ok|okay|sure|thanks?|thank you|got it|alright|yes|no|yep|nope|great|cool|nice)[.!?]?$ /i,
    /^(stop|cancel|pause|resume|next|back|go\s+back)[.!?]?$ /i,
    /^\s*$/,
  ];

  for (const pat of voiceRe) {
    if (pat.test(text)) {
      const remainder = text.replace(pat, '').trim();
      for (const tpat of timeRe) {
        if (tpat.test(remainder)) return 'voice preamble + time query';
      }
      for (const trivpat of trivialRe) {
        if (trivpat.test(remainder)) return 'voice preamble + trivial';
      }
      if (!remainder) return 'empty after stripping voice preamble';
    }
  }

  for (const pat of timeRe) {
    if (pat.test(text.trim())) return 'time/date/weather/timer query';
  }

  for (const pat of trivialRe) {
    if (pat.test(text.trim())) return 'trivial utterance';
  }

  if (text.trim().length < 3) return 'too short (< 3 chars)';

  return null;
}