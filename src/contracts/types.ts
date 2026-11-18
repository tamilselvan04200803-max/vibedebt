/** Paths in topology reports are target-relative; source lines are one-based. */
export interface SourceLocation { file: string; line: number; snippet?: string }
export interface StateHook extends SourceLocation { name: string; setter?: string }
export interface FileNode {
  path: string;
  lineCount: number;
  functions: string[];
  components: string[];
  imports: { source: string; names: string[] }[];
  exports: string[];
  stateHooks: StateHook[];
  monolithScore: boolean;
}
export interface DuplicateLogicCluster {
  signature: string;
  category: 'pricing' | 'tax' | 'shipping' | 'coupon';
  occurrences: SourceLocation[];
}
export interface OrphanedStateItem extends SourceLocation {
  name: string;
  kind: 'useState' | 'variable';
  reason: string;
}
export interface ApiInconsistencyItem {
  resource: string;
  endpoints: string[];
  occurrences: (SourceLocation & { endpoint: string })[];
  reason: string;
}
export interface TopologyReport {
  files: FileNode[];
  duplicatedLogic: DuplicateLogicCluster[];
  orphanedState: OrphanedStateItem[];
  apiInconsistencies: ApiInconsistencyItem[];
  emptyCatchBlocks?: SourceLocation[];
  businessIntents?: BusinessIntent[];
}
export interface BusinessIntent extends SourceLocation {
  name: string;
  parameters: string[];
  summary: string;
  evidence: string[];
  source: 'heuristic' | 'ai';
}
export interface PublicContract extends SourceLocation {
  name: string;
  kind: 'function' | 'component' | 'type' | 'value';
  signature: string;
}
export interface VerificationResult {
  success: boolean;
  passed: number;
  failed: number;
  output: string;
}
export interface AnchorResult {
  targetDir: string;
  entryPoint: string;
  testFile: string;
  contracts: PublicContract[];
  testCount: number;
  verification: VerificationResult;
}
export interface HealPlan {
  targetDir: string;
  anchorFile: string;
  before: TopologyReport;
  extractedModules: string[];
  dryRun?: boolean;
  changes?: PlannedFileChange[];
}
export interface PlannedFileChange {
  file: string;
  kind: 'create' | 'update';
  before: string;
  after: string;
  linesAdded: number;
  linesRemoved: number;
  importsAdded: string[];
  importsRemoved: string[];
}
export interface HealResult extends HealPlan {
  success: boolean;
  rolledBack: boolean;
  after: TopologyReport;
  changedFiles: string[];
  apiBoundaryFixes: string[];
  verification: VerificationResult;
  error?: string;
  checkpoint?: {ref: string; commit: string};
}
export interface PullRequestReport {
  targetDir: string;
  before: TopologyReport;
  after: TopologyReport;
  anchor: AnchorResult;
  heal: HealResult;
  businessIntents?: BusinessIntent[];
}
