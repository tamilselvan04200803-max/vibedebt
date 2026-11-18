#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { analyzeCodebase } from '../cartographer/index.js';
import { anchor } from '../anchor/index.js';
import { heal } from '../healer/index.js';
import { markdownReport } from '../reporter/markdownReporter.js';
import { assertArtifactPath } from '../verification/pathSafety.js';
import { htmlDashboard } from '../reporter/htmlVisualizer.js';
import { enrichTopology } from '../llm/intentClient.js';
import { registerGenericCommands } from './genericCommands.js';

function writeOutput(path: string, content: string): void {
  assertArtifactPath(path);
  mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, content);
}
const program = new Command().name('vibedebt').version('0.1.0')
  .description('Map, characterize, and safely heal VibeMart architectural debt');
const defaultTarget = 'fixtures/vibe-mart';
program.command('map [targetDir]').description('Analyze source topology with the AST Cartographer')
  .option('--out <jsonPath>', 'Write topology as JSON')
  .option('--html [outputPath]', 'Write an offline interactive dashboard')
  .option('--ai', 'Enrich advisory intent text using configured API credentials')
  .action(async (targetDir: string = defaultTarget, options: { out?: string; html?: string | boolean; ai?: boolean }) => {
    const report = await enrichTopology(analyzeCodebase(targetDir), {env:options.ai ? process.env : {}});
    if (options.out) writeOutput(options.out, JSON.stringify(report, null, 2) + '\n');
    if (options.html) writeOutput(typeof options.html === 'string' ? options.html : 'vibedebt-dashboard.html', htmlDashboard(report));
    console.log(`VibeDebt AST Cartographer\nFiles: ${report.files.length}\nMonolithic files: ${report.files.filter(f => f.monolithScore).length}\nDuplicated logic groups: ${report.duplicatedLogic.length}\nOrphaned state: ${report.orphanedState.length}\nAPI inconsistencies: ${report.apiInconsistencies.length}`);
    console.log(`Empty catch blocks: ${report.emptyCatchBlocks?.length ?? 0}`);
    if (options.out) console.log(`Report written to ${options.out}`);
  });
program.command('anchor [targetDir]').description('Capture and verify public behavioral contracts')
  .option('--out <testPath>', 'Generated Vitest suite path')
  .action(async (targetDir: string = defaultTarget, options: { out?: string }) => {
    const result = await anchor(targetDir, options);
    console.log(`Anchor: ${result.testFile}\nPassing tests: ${result.testCount}`);
  });
program.command('heal [targetDir]').description('Refactor behind invariant, typecheck and anchor rollback gates')
  .option('--anchor <testPath>', 'Replay an existing frozen anchor suite')
  .option('--out <jsonPath>', 'Write the heal result as JSON')
  .option('--dry-run', 'Print the exact refactor plan to stdout without writing files')
  .option('--checkpoint', 'Save a target-scoped Git checkpoint before mutation')
  .action(async (targetDir: string = defaultTarget, options: { anchor?: string; out?: string; dryRun?:boolean; checkpoint?:boolean }) => {
    if(options.dryRun) {
      if(options.out || options.checkpoint) throw new Error('Dry-run plans use stdout; omit --out and --checkpoint');
      console.log(JSON.stringify(await heal(targetDir,{dryRun:true,anchorFile:options.anchor}),null,2));return;
    }
    if (options.out) assertArtifactPath(options.out);
    const result = await heal(targetDir, { anchorFile: options.anchor,checkpoint:options.checkpoint });
    if (options.out) writeOutput(options.out, JSON.stringify(result, null, 2) + '\n');
    if(result.checkpoint) console.error(`Checkpoint: ${result.checkpoint.ref} (${result.checkpoint.commit})`);
    if (!result.success) throw new Error(result.error ?? result.verification.output);
    console.log(`Healed: ${targetDir}\nChanged files: ${result.changedFiles.length}\nPassing tests: ${result.verification.passed}`);
  });
program.command('run [targetDir]').description('Run map -> anchor -> heal and write a Markdown PR report')
  .option('--out <reportPath>', 'Markdown PR report path', 'VIBEDEBT_REPORT.md')
  .option('--html [outputPath]', 'Write an offline interactive dashboard')
  .option('--ai', 'Enrich advisory intent text using configured API credentials')
  .option('--dry-run', 'Print the exact refactor plan to stdout without writing files')
  .option('--checkpoint', 'Save a target-scoped Git checkpoint before mutation')
  .action(async (targetDir: string = defaultTarget, options: { out: string; html?: string | boolean; ai?: boolean; dryRun?:boolean; checkpoint?:boolean },command:Command) => {
    if(options.dryRun) {
      if(command.getOptionValueSource('out')==='cli' || options.html || options.ai || options.checkpoint) {
        throw new Error('Dry-run plans use stdout; omit --out, --html, --ai and --checkpoint');
      }
      console.log(JSON.stringify(await heal(targetDir,{dryRun:true}),null,2));return;
    }
    assertArtifactPath(options.out);
    const htmlPath = options.html ? typeof options.html === 'string' ? options.html : 'vibedebt-dashboard.html' : undefined;
    if (htmlPath) assertArtifactPath(htmlPath);
    const before = await enrichTopology(analyzeCodebase(targetDir), {env:options.ai ? process.env : {}});
    const captured = await anchor(targetDir);
    const result = await heal(targetDir, { anchorFile: captured.testFile,checkpoint:options.checkpoint });
    if(result.checkpoint) console.error(`Checkpoint: ${result.checkpoint.ref} (${result.checkpoint.commit})`);
    result.after = await enrichTopology(result.after, {env:options.ai ? process.env : {}});
    if (htmlPath) writeOutput(htmlPath, htmlDashboard(before, result));
    writeOutput(options.out, markdownReport({ targetDir: resolve(targetDir), before,
      after: result.after, anchor: captured, heal: result, businessIntents:result.after.businessIntents }));
    if (!result.success) throw new Error(result.error ?? result.verification.output);
    console.log(`Report: ${resolve(options.out)}\nPassing tests: ${result.verification.passed}`);
  });
registerGenericCommands(program);
await program.parseAsync().catch((error: unknown) => {
  console.error(`vibedebt: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
