import { scanProject, inventory } from './astScanner.js';
import { detectEmptyCatchBlocks, detectSmells } from './smellDetector.js';
import type { TopologyReport } from '../contracts/types.js';
import { inferIntents } from '../llm/domainIntent.js';

export function analyzeCodebase(targetDir: string): TopologyReport {
  const { dir, sources } = scanProject(targetDir);
  return { files: sources.map(source => inventory(source, dir)), ...detectSmells(sources, dir),
    emptyCatchBlocks: detectEmptyCatchBlocks(sources, dir), businessIntents: inferIntents(sources, dir) };
}
