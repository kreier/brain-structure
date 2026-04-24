import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CleanOptions, Conversation, Message, SourceData } from './types';
import { SOURCE_EMOJI, header, section, ok, warn, red, green, yellow, cyan, dim, bold } from './utils';

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

const CLEAN_HELP = `
  ${bold('[k]eep')}   keep this message as-is
  ${bold('[d]elete')} mark as removed
  ${bold('[s]trip')}  strip voice preamble, keep remainder
  ${bold('[a]uto')}   auto-decide all remaining in this file
  ${bold('[q]uit')}   save & quit
  ${bold('[?]')}      show this help
`;

function detectNoise(msg: Message): string | null {
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

function stripVoicePrefix(text: string): string {
  const voiceRe = [
    /^hey\s+google[,.]?\s*/i,
    /^hey\s+gemini[,.]?\s*/i,
    /^hey\s+siri[,.]?\s*/i,
    /^ok\s+bixby[,.]?\s*/i,
    /^hey\s+cortana[,.]?\s*/i,
    /^hey\s+alexa[,.]?\s*/i,
  ];
  for (const pat of voiceRe) {
    text = text.replace(pat, '').trim();
  }
  return text;
}

function printMessageContext(conv: Conversation, msgIdx: number, flaggedReason: string): void {
  const convTitle = conv.title;
  const msgs = conv.messages;
  const msg = msgs[msgIdx];

  const width = Math.min(process.stdout.columns || 80, 88);
  console.log('\n' + cyan('─'.repeat(width)));
  console.log(`  ${bold('Conv:')} ${convTitle}`);
  console.log(`  ${bold('Flag:')} ${yellow(flaggedReason)}`);

  if (msgIdx > 0) {
    const prev = msgs[msgIdx - 1];
    const label = prev.role === 'user' ? 'You' : 'AI';
    const colour = dim;
    const wrapped = prev.text.substring(0, 300).split('\n').map(line => line || '>').join('\n    ');
    console.log(`\n  ${colour(label + ':')} ${dim('(context)')}`);
    console.log(colour('    ' + wrapped));
  }

  const label = msg.role === 'user' ? bold('You') : bold('AI');
  const wrapped = msg.text.substring(0, 500).split('\n').map(line => line || '>').join('\n    ');
  console.log(`\n  ${red('→')} ${label}${red(':')} ${yellow('[flagged]')}`);
  console.log(yellow('    ' + wrapped));
  console.log(cyan('─'.repeat(width)));
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function cmdClean(options: CleanOptions): Promise<void> {
  const root = path.resolve(options.root);
  const sourcesDir = path.join(root, 'sources');

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
    warn('No source files to clean.');
    return;
  }

  header('🧹  Interactive Clean');
  console.log(CLEAN_HELP);

  for (const fpath of files) {
    const data: SourceData = JSON.parse(await fs.readFile(fpath, 'utf-8'));
    const convs = data.conversations;
    const source = data.source;

    const flagged: [Conversation, number, string][] = [];
    for (const conv of convs) {
      for (let i = 0; i < conv.messages.length; i++) {
        const msg = conv.messages[i];
        if (msg.removed) continue;
        const reason = detectNoise(msg);
        if (reason) flagged.push([conv, i, reason]);
      }
    }

    if (!flagged.length) {
      ok(`${path.basename(fpath)}: no noise detected`);
      continue;
    }

    section(`${SOURCE_EMOJI[source as keyof typeof SOURCE_EMOJI] || '?'}  ${path.basename(fpath)}  —  ${flagged.length} messages to review`);

    let autoMode = false;
    let quitFlag = false;
    let changed = false;

    for (let j = 0; j < flagged.length; j++) {
      const [conv, msgIdx, reason] = flagged[j];
      const msg = conv.messages[msgIdx];

      if (autoMode) {
        const stripped = stripVoicePrefix(msg.text);
        if (stripped && stripped.length > 3 && ![...timeRe, ...trivialRe].some(pat => pat.test(stripped))) {
          msg.text = stripped;
          msg.remove_reason = `auto-stripped: ${reason}`;
        } else {
          msg.removed = true;
          msg.remove_reason = `auto-removed: ${reason}`;
        }
        changed = true;
        continue;
      }

      printMessageContext(conv, msgIdx, reason);
      const ch = await promptUser(`  ${dim(`(${j + 1}/${flagged.length})`)}  ${bold('[k/d/s/a/q/?]')} `);

      if (ch === 'k' || ch === 'keep' || ch === '') {
        // keep
      } else if (ch === 'd' || ch === 'delete') {
        msg.removed = true;
        msg.remove_reason = reason;
        changed = true;
        console.log(`  ${red('Removed.')}`);
      } else if (ch === 's' || ch === 'strip') {
        const stripped = stripVoicePrefix(msg.text);
        if (stripped) {
          msg.text = stripped;
          msg.remove_reason = `stripped preamble: ${reason}`;
          changed = true;
          console.log(`  ${green('Stripped to:')} ${stripped.substring(0, 80)}`);
        } else {
          msg.removed = true;
          msg.remove_reason = `stripped (nothing left): ${reason}`;
          changed = true;
          console.log(`  ${red('Nothing left after strip — removed.')}`);
        }
      } else if (ch === 'a' || ch === 'auto') {
        autoMode = true;
        console.log(`  ${cyan('Auto mode — processing remaining automatically.')}`);
        const stripped = stripVoicePrefix(msg.text);
        if (stripped && stripped.length > 3 && ![...timeRe, ...trivialRe].some(pat => pat.test(stripped))) {
          msg.text = stripped;
        } else {
          msg.removed = true;
          msg.remove_reason = `auto-removed: ${reason}`;
        }
        changed = true;
      } else if (ch === 'q' || ch === 'quit') {
        quitFlag = true;
      } else if (ch === '?') {
        console.log(CLEAN_HELP);
        j--; // retry
        continue;
      } else {
        console.log(`  ${dim('Unknown — type k/d/s/a/q/? ')} `);
        j--; // retry
        continue;
      }

      if (quitFlag) break;
    }

    if (changed) {
      await fs.writeFile(fpath, JSON.stringify(data, null, 2), 'utf-8');
      ok(`Saved ${path.basename(fpath)}`);
    }

    if (quitFlag) {
      warn('Quit early — remaining files skipped.');
      break;
    }
  }

  console.log();
}