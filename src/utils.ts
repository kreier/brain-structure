import chalk from 'chalk';
import { readFileSync } from 'fs';
import { platform } from 'os';

export const SOURCES = ['chatgpt', 'gemini', 'claude'] as const;
export type Source = typeof SOURCES[number];

export const SOURCE_LABEL: Record<Source, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
};

export const SOURCE_EMOJI: Record<Source, string> = {
  chatgpt: '🤖',
  gemini: '♊',
  claude: '🟠',
};

export function ts(epoch: number | null): Date | null {
  if (epoch === null) return null;
  try {
    return new Date(epoch * 1000);
  } catch {
    return null;
  }
}

export function parseIso(s: string): Date | null {
  if (!s) return null;
  try {
    return new Date(s.replace('Z', '+00:00'));
  } catch {
    return null;
  }
}

export function cleanText(t: string): string {
  return t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).length;
}

export function slug(text: string): string {
  return text
    .replace(/[^\w\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

export function header(title: string): void {
  const width = Math.min(process.stdout.columns || 80, 88);
  console.log();
  console.log(chalk.cyan('━'.repeat(width)));
  console.log(chalk.bold(`  ${title}`));
  console.log(chalk.cyan('━'.repeat(width)));
}

export function section(title: string): void {
  console.log(`\n${chalk.yellow.bold('▸')} ${chalk.bold(title)}`);
}

export function info(msg: string): void {
  console.log(`  ${chalk.dim('·')} ${msg}`);
}

export function ok(msg: string): void {
  console.log(`  ${chalk.green('✓')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${chalk.yellow('⚠')} ${msg}`);
}

export function err(msg: string): void {
  console.error(`  ${chalk.red('✗')} ${msg}`);
}

export function bold(t: string): string {
  return chalk.bold(t);
}

export function dim(t: string): string {
  return chalk.dim(t);
}

export function green(t: string): string {
  return chalk.green(t);
}

export function yellow(t: string): string {
  return chalk.yellow(t);
}

export function red(t: string): string {
  return chalk.red(t);
}

export function cyan(t: string): string {
  return chalk.cyan(t);
}

export function magenta(t: string): string {
  return chalk.magenta(t);
}

export function blue(t: string): string {
  return chalk.blue(t);
}