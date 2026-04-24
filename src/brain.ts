#!/usr/bin/env node

import { Command } from 'commander';
import { cmdIngest } from './ingest';
import { cmdStats } from './stats';
import { cmdClean } from './clean';
import { cmdExport } from './export';

const program = new Command();

program
  .name('brain')
  .description('AI Conversation Brain Manager')
  .version('1.0.0')
  .option('--root <dir>', 'Brain repo root directory', '.')
  .option('-v, --verbose', 'Extra output');

program
  .command('ingest')
  .description('Parse raw exports into sources/')
  .argument('<inputs...>', 'Export file(s) or folder(s)')
  .action(async (inputs: string[]) => {
    const options = program.opts();
    await cmdIngest({ inputs, root: options.root, verbose: options.verbose });
  });

program
  .command('stats')
  .description('Show statistics for all source files')
  .action(async () => {
    const options = program.opts();
    await cmdStats({ root: options.root, verbose: options.verbose });
  });

program
  .command('clean')
  .description('Interactive noise removal')
  .option('--source <file>', 'Specific source file to clean')
  .action(async (cmdOptions: any) => {
    const options = program.opts();
    await cmdClean({ root: options.root, verbose: options.verbose, source: cmdOptions.source });
  });

program
  .command('export')
  .description('Generate Obsidian vault Markdown')
  .option('--source <file>', 'Specific source file to export')
  .action(async (cmdOptions: any) => {
    const options = program.opts();
    await cmdExport({ root: options.root, verbose: options.verbose, source: cmdOptions.source });
  });

program.parse();