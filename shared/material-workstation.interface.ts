export type WorkstationMode =
  | 'clip-remix'
  | 'batch-hook'
  | 'product-swap'
  | 'copy-and-voice';

export type WorkstationCapabilityStatus =
  | 'available'
  | 'validating'
  | 'planned';

export interface WorkstationModeDefinition {
  id: WorkstationMode;
  name: string;
  shortName: string;
  description: string;
  capabilityStatus: WorkstationCapabilityStatus;
  engineLabel: string;
}

export type RenderJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed';

export type RenderItemStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type ReviewStatus = 'pending' | 'approved' | 'changes_requested';

export interface RenderWorkerHealth {
  ok: boolean;
  workerId: string;
  version: string;
  ffmpegAvailable: boolean;
  queueLength: number;
  activeJobId: string | null;
  authRequired: boolean;
  jobCount: number;
  retentionDays: number;
  capabilities: {
    privateUploads?: boolean;
    batchHook: boolean;
    clipRemix: boolean;
    cutterRecognition: boolean;
    localSubtitleOcr: boolean;
    materialCenterBidirectional: boolean;
    persistentJobs: boolean;
    audioFade: boolean;
    loudnessNormalization: boolean;
    libtvGeneration: boolean;
  };
}

export interface RenderWorkerSession {
  enabled: boolean;
  workerBaseUrl: string | null;
  accessToken: string | null;
  expiresAt: string | null;
  message: string | null;
  stableApp?: {
    appUrl: string;
    logoutUrl: string;
    user: {
      id: string;
      name: string;
      department: string;
    };
  };
}

export interface BatchHookConfig {
  hookDurationSeconds: number;
  sourceStartSeconds: number;
  fadeDurationSeconds: number;
  targetLoudnessLufs: number;
  width: number;
  height: number;
  fps: number;
}

export interface BatchHookRenderItem {
  id: string;
  sourceName: string;
  outputName: string;
  status: RenderItemStatus;
  progress: number;
  error: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  reviewStatus: ReviewStatus;
  reviewNote: string;
  reviewedAt: string | null;
}

export interface BatchHookJob {
  id: string;
  mode: 'batch-hook';
  status: RenderJobStatus;
  progress: number;
  hookName: string;
  sourceCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  config: BatchHookConfig;
  items: BatchHookRenderItem[];
}

export type ClipRemixRole =
  | 'hook'
  | 'pain'
  | 'solution'
  | 'proof'
  | 'cta'
  | 'benefit'
  | 'demo'
  | 'urgency'
  | 'custom';

export type ClipRemixFrameworkSource = 'preset' | 'parsed' | 'custom';

export type ClipRemixAnalysisStatus =
  | 'not_started'
  | 'processing'
  | 'ready'
  | 'failed';

export type ClipRemixBoundaryType = 'cutter' | 'ocr' | 'pause' | 'fallback';

export type ClipRemixTranscriptSource = 'cutter' | 'ocr' | 'manual' | 'silence';

export type ClipRemixBoundaryConfidence = 'high' | 'low' | 'manual';

export interface ClipRemixTemplateSlot {
  id: string;
  label: string;
  note: string;
}

export interface ClipRemixTemplate {
  id: string;
  visibility?: 'team' | 'private';
  name: string;
  description: string;
  tags: string[];
  sourceType: ClipRemixFrameworkSource;
  sourceId: string | null;
  derivedFromFrameworkId?: string | null;
  promotedFromId?: string | null;
  createdAt: string | null;
  slots: ClipRemixTemplateSlot[];
}

export interface ClipRemixWorkspaceFrameworkDraft {
  sourceFrameworkId: string;
  name: string;
  description: string;
  tags: string[];
  slots: ClipRemixTemplateSlot[];
}

export interface ClipRemixFrameworkRecognition {
  mode: 'rules';
  ruleVersion: string;
  sourceId: string;
  sourceName: string;
  name: string;
  description: string;
  evidence: string[];
  slots: Array<
    ClipRemixTemplateSlot & {
      startSeconds: number;
      endSeconds: number;
    }
  >;
}

export interface ClipRemixSpeechSegment {
  id: string;
  index: number;
  label: string;
  clipName?: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  boundaryType: ClipRemixBoundaryType;
  transcriptSource?: ClipRemixTranscriptSource;
  transcriptConfidence?: number | null;
  boundaryConfidence?: ClipRemixBoundaryConfidence;
  requiresReview?: boolean;
  reviewReasons?: string[];
  manualEditedAt?: string | null;
  sceneDescription?: string;
  sceneText?: string;
  cameraAngle?: string;
  shotSize?: string;
  cameraMovement?: string;
  sceneBoundaryAligned?: boolean;
  rawStartSeconds?: number | null;
  rawEndSeconds?: number | null;
  integerSecondAligned?: boolean;
  nativeFrameRate?: number;
  startFrame?: number;
  endFrame?: number;
  integerBoundaryTrusted?: boolean;
  suggestedRole?: string;
  automaticCalibration?: {
    status: 'calibrated' | 'review_required';
    score: number;
    reasons: string[];
    calibratedAt: string;
  };
}

export interface ClipRemixSource {
  detailsLoaded?: boolean;
  speechSegmentCount?: number;
  visibility?: 'team' | 'private';
  id: string;
  originalName: string;
  tags?: string[];
  isMine?: boolean;
  size: number;
  durationSeconds: number;
  hasAudio: boolean;
  frameRate?: number;
  nominalFrameRate?: number;
  variableFrameRate?: boolean;
  timeBase?: string;
  frameCount?: number | null;
  uploadedAt: string;
  previewUrl: string;
  browserPreviewStatus?: 'native' | 'processing' | 'transcoded' | 'failed';
  browserPreviewError?: string;
  analysisStatus: ClipRemixAnalysisStatus;
  analysisMessage: string;
  analysisProvider?: 'cutter' | 'ocr' | 'silence' | null;
  analysisTaskId?: string | null;
  analysisUpdatedAt?: string | null;
  speechSegments: ClipRemixSpeechSegment[];
  sourceType?: 'manual_upload' | 'material_center';
  materialCenterAssetId?: number;
  cloudPrivateAssetId?: string;
  materialCenterObjectKey?: string;
  materialCenterCategory?: string;
  materialCenterFolderName?: string;
  materialCenterLibraryType?: 'source' | 'remix';
  materialCenterImportedAt?: string;
  materialCenterPreviewUrl?: string;
  materialCenterEffective?: boolean;
  materialCenterEffectiveMarkedAt?: string | null;
  materialCenterEffectiveImportedAt?: string;
  productCategory?: string;
}

export interface ClipRemixClip {
  visibility?: 'team' | 'private';
  deliveryBlocked?: boolean;
  deliveryBlockReason?: string;
  id: string;
  sourceId: string;
  name: string;
  role: string;
  tags: string[];
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  reviewStatus: ReviewStatus;
  reviewNote: string;
  createdAt: string;
  reviewedAt: string | null;
  previewUrl: string;
  folderId: string | null;
  createdByNames?: string[];
  isMine?: boolean;
  productCategory?: string;
  automaticAssessment?: AutoRemixAutomaticAssessment;
  approvalSource?: 'material_center_effective' | string;
  approvalProvenance?: Record<string, unknown>;
}

export interface ClipRemixFolder {
  id: string;
  name: string;
  createdAt: string;
  parentId?: string | null;
  createdByName?: string;
  isMine?: boolean;
}

export interface ClipRemixDirectUploadResult {
  batchId: string;
  relativePath: string;
  folderPath: string;
  contentSha256: string;
  reused: boolean;
  source: ClipRemixSource;
  clip: ClipRemixClip;
}

export interface ClipRemixVariant {
  id: string;
  outputName: string;
  slotMapping: Record<string, string>;
  clipSequence?: string[];
  targetDurationSeconds?: number;
  actualDurationSeconds?: number;
  shotAliases?: Record<string, Record<string, string>>;
  qualityAssessment?: {
    score: number;
    level: 'recommended' | 'good' | 'review';
    mode: 'rules' | 'ai';
    reasons: string[];
  };
  reviewStatus: ReviewStatus;
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  usageDisclaimerApplied?: boolean;
  usageDisclaimerText?: string;
  contentSha256?: string;
  materialCenterReturn?: MaterialCenterReturnState;
  automaticAssessment?: AutoRemixAutomaticAssessment;
  qianchuanDelivery?: QianchuanAutomaticDeliveryState;
  qianchuanDeliveries?: QianchuanAutomaticDeliveryState[];
  cloudDeliveryFeedback?: {
    items?: QianchuanAutomaticDeliveryState[];
    assetAvailable?: boolean;
    complete?: boolean;
    checkedAt?: string;
    errorMessage?: string;
    nextPollAt?: string;
  };
}

export type ClipRemixGenerationMode = 'manual' | 'automatic';

export interface AutoRemixAccessGrant {
  userId: string;
  userName: string;
  grantedAt: string;
  grantedByName: string;
  verified: boolean;
  verifiedAt: string | null;
}

export interface AutoRemixAccessAudit {
  id: string;
  action: 'grant' | 'revoke';
  userId: string;
  userName: string;
  actorName: string;
  createdAt: string;
}

export interface AutoRemixAccessState {
  canUse: boolean;
  isAdmin: boolean;
  currentUser: {
    id: string;
    name: string;
  };
  grants: AutoRemixAccessGrant[];
  recentAudit: AutoRemixAccessAudit[];
}

export interface MaterialCenterAsset {
  id: number;
  filename: string;
  objectKey: string;
  size: number;
  modifiedAt: string;
  category: string;
  contentType: string;
  assetSubtype: string;
  libraryType: 'source' | 'remix';
  folderName: string;
  tags: string[];
  coverUrl: string;
  previewUrl: string;
  downloadUrl: string;
  storageUrl?: string;
  deletionStatus?: string;
  isDeleted?: boolean;
  rightsStatus?: string;
  uploadedByName: string;
  source: string;
  referenceUrl: string;
  effective: boolean;
  effectiveMarkedAt: string | null;
  effectiveMarkedByName: string;
}

export interface MaterialCenterFilterOption {
  value: string;
  label: string;
  count: number | null;
}

export interface MaterialCenterAssetFilters {
  categories: MaterialCenterFilterOption[];
  folders: MaterialCenterFilterOption[];
}

export interface MaterialCenterAssetPage {
  configured: boolean;
  items: MaterialCenterAsset[];
  total: number;
  page: number;
  pageSize: number;
  libraryType: 'all' | 'source' | 'remix';
  source: string;
  sourceUpdatedAt: string | null;
  filters: MaterialCenterAssetFilters;
  selectedCategory: string;
  selectedFolder: string;
  effectiveOnly: boolean;
}

export interface EffectiveMaterialCenterClipImportStatus {
  assetId: number;
  state:
    | 'not_imported'
    | 'source_imported'
    | 'technical_attention'
    | 'approved'
    | string;
  source: ClipRemixSource | null;
  clips: ClipRemixClip[];
  clipCount: number;
  approvedCount: number;
  technicalAttentionCount: number;
  contentReviewInherited: boolean;
  updatedAt: string | null;
}

export interface MaterialCenterReturnState {
  status: string;
  idempotencyKey: string;
  assetId: number | null;
  assetAvailable: boolean;
  filename: string;
  completedAt: string | null;
  attemptedAt: string;
  errorMessage: string;
  retryCount?: number;
  nextRetryAt?: string | null;
}

export interface MaterialCenterReturnResult extends MaterialCenterReturnState {
  asset: MaterialCenterAsset | null;
  objectKey: string;
  sha256: string;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type AutoRemixJobStatus = 'active' | 'paused' | 'error';

export type AutoRemixRunStatus =
  | 'queued'
  | 'preparing'
  | 'generating'
  | 'repairing'
  | 'awaiting_sources'
  | 'awaiting_clip_review'
  | 'awaiting_review'
  | 'completed'
  | 'partial'
  | 'failed';

export type AutoRemixCapabilityStatus =
  | 'available'
  | 'blocked'
  | 'not_configured';

export type AutoRemixPipelineStageKey =
  | 'source_selection'
  | 'source_slicing'
  | 'clip_calibration'
  | 'clip_review'
  | 'remix_generation'
  | 'output_review'
  | 'material_center_return'
  | 'qianchuan_delivery';

export type AutoRemixPipelineStageStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'partial'
  | 'needs_review'
  | 'blocked'
  | 'failed';

export interface AutoRemixAssessmentCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AutoRemixAutomaticAssessment {
  status: 'passed' | 'review_required' | 'failed';
  recommendation: 'approve' | 'manual_review' | 'reject';
  score: number;
  mode: 'rules';
  autoApproved?: boolean;
  autoAdjusted?: boolean;
  boundaryIntegrity?: {
    status: 'passed' | 'review_required';
    segmentId: string | null;
    score: number;
    autoAdjusted: boolean;
  };
  checks: AutoRemixAssessmentCheck[];
  reasons: string[];
  suggestions?: string[];
  assessedAt: string;
}

export type QianchuanAutomaticPlanType =
  | 'multiplication'
  | 'full_domain'
  | 'standard';

export interface QianchuanAutomaticDeliveryTarget {
  advertiserId: string;
  advertiserName: string;
  planId: string;
  planName: string;
  planAlias: string;
  planType: QianchuanAutomaticPlanType;
  verification?: {
    verified: boolean;
    authorized: boolean;
    account: { id: string; name: string };
    plan: {
      id: string;
      name: string;
      planType: string;
      status: string;
      statusLabel: string;
      marketingGoal: string;
      canAttachVideo: boolean;
    };
    verifiedAt: string;
    source: string;
  } | null;
}

export interface QianchuanAutomaticDeliveryConfig extends QianchuanAutomaticDeliveryTarget {
  enabled: boolean;
  confirmed: boolean;
  targets: QianchuanAutomaticDeliveryTarget[];
  dailyMaterialLimit: number;
  dailySpendGuardYuan: number | null;
}

export interface QianchuanCatalogAccount {
  id: string;
  name: string;
  advertiserId?: string;
  advertiserName?: string;
}

export interface QianchuanCatalogPlan {
  id: string;
  name: string;
  planType: QianchuanAutomaticPlanType;
  planTypeLabel: string;
  status: string;
  statusLabel: string;
  marketingGoal: string;
  canAttachVideo: boolean;
  isFull: boolean;
  capacityMessage: string;
}

export interface QianchuanCatalogPlanPage {
  items: QianchuanCatalogPlan[];
  total: number;
  complete: boolean;
  cached: boolean;
  warnings: string[];
  sourceReadAt: string;
}

export interface QianchuanProductPlanRule {
  advertiserId: string;
  advertiserName: string;
  scope: QianchuanAutomaticPlanType | 'all';
  matchMode: 'exact_plan' | 'keyword' | 'all';
  keyword: string;
  planId: string;
}

export interface QianchuanProductPlanBundle {
  key: string;
  label: string;
  aliases: string[];
  rules: QianchuanProductPlanRule[];
}

export interface QianchuanProductPlanMap {
  source: {
    title: string;
    url: string;
    documentId: string;
    revision: number;
    verifiedAt: string;
  };
  items: QianchuanProductPlanBundle[];
}

export interface QianchuanAutomaticDeliveryState {
  idempotencyKey: string;
  taskId?: string;
  status: string;
  message: string;
  errorMessage: string;
  errorAdvice?: string;
  failureStage?: string;
  advertiserId: string;
  advertiserName: string;
  planId: string;
  planName: string;
  planAlias?: string;
  platformAssetId?: string;
  bindingVerifiedAt?: string | null;
  platformAudit?: { status: string; reasons: string[]; video_id: string; source: string; read_at: string; localization: string } | null;
  metrics: Record<string, unknown>;
  metricsLinkStatus: string;
  metricsDataStatus: string;
  metricsFreshThrough?: string | null;
  metricsCoverage?: { completed: number; expected: number };
  attemptedAt: string;
  updatedAt: string;
  nextPollAt?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
}

export interface AutoRemixStageReport {
  key: AutoRemixPipelineStageKey;
  label: string;
  status: AutoRemixPipelineStageStatus;
  totalCount: number;
  processedCount: number;
  passedCount: number;
  reviewRequiredCount: number;
  failedCount: number;
  pendingCount?: number;
  activeCount?: number;
  uploadedCount?: number;
  boundCount?: number;
  summary: string;
  evidence: string[];
  startedAt: string | null;
  completedAt: string | null;
  currentItem?: string;
  lastProgressAt?: string | null;
  elapsedSeconds?: number;
}

export interface AutoRemixSlotReadiness {
  slotId: string;
  label: string;
  candidateCount: number;
  isOpeningSlot?: boolean;
  desiredCandidateCount?: number;
  missingCandidateCount?: number;
  roleIds?: string[];
}

export interface AutoRemixReadiness {
  ready: boolean;
  approvedClipCount: number;
  combinationCapacity: number;
  maxDailyTarget: number;
  openingSlotId: string;
  uniqueOpenerCount: number;
  slots: AutoRemixSlotReadiness[];
  blockingReasons: string[];
  productCategory: string;
}

export interface AutoRemixRun {
  id: string;
  dateKey: string;
  status: AutoRemixRunStatus;
  targetCount: number;
  targetDurationSeconds: number;
  generatedCount: number;
  attemptedCount?: number;
  reviewedCount: number;
  approvedCount: number;
  returnedCount: number;
  qianchuanUploadedCount: number;
  placedCount: number;
  qianchuanTargetCount?: number;
  failedCount: number;
  renderIds: string[];
  selectedAssetIds: number[];
  selectedSourceIds: string[];
  createdClipIds: string[];
  stageReports: AutoRemixStageReport[];
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string;
  recoveryCount?: number;
  lastRecoveredAt?: string | null;
  lastRecoveryMessage?: string;
}

export interface AutoRemixJob {
  id: string;
  name: string;
  frameworkId: string;
  frameworkName: string;
  productCategory: string;
  status: AutoRemixJobStatus;
  dailyTarget: number;
  scheduleEnabled: boolean;
  scheduleTime: string;
  targetDurationSeconds: number;
  timeZone: 'Asia/Shanghai';
  includeUsageDisclaimer: boolean;
  usageDisclaimerText: string;
  autoApproveOutputs: boolean;
  autoReturnAfterApproval: boolean;
  qianchuanDelivery: QianchuanAutomaticDeliveryConfig;
  performanceLearning: {
    status: 'pending' | 'learning' | 'ready';
    sampleSize: number;
    spendYuan: number | null;
    gmvYuan: number | null;
    roi: number | null;
    clipWeights?: Record<string, number>;
    recommendations: string[];
    updatedAt: string | null;
  };
  sourceSelectionLimit: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  readiness: AutoRemixReadiness;
  latestRun: AutoRemixRun | null;
  recentRuns: AutoRemixRun[];
  cleanupEligible: boolean;
}

export interface ContinuousClipSupplyRoleInventory {
  roleId: string;
  count: number;
  targetCount: number;
  missingCount: number;
}

export interface ContinuousClipSupplyProductInventory {
  productCategory: string;
  productApprovedCount: number;
  usableApprovedCount: number;
  targetApprovedCount: number;
  missingApprovedCount: number;
  shortageRoleCount: number;
  roles: ContinuousClipSupplyRoleInventory[];
}

export interface ContinuousClipSupplyState {
  enabled: boolean;
  status: 'starting' | 'active' | 'watching' | 'blocked';
  currentProductCategory: string;
  currentAssetId: number | null;
  currentScanMode: 'idle' | 'recent' | 'history';
  processedAssetCount: number;
  createdClipCount: number;
  approvedClipCount: number;
  rejectedClipCount: number;
  lastScanAt: string | null;
  nextScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  scanIntervalSeconds: number;
  targetApprovedPerProduct: number;
  targetApprovedPerRole: number;
  generalApprovedCount: number;
  inventory: ContinuousClipSupplyProductInventory[];
  loopPrevention: string;
}

export interface ClipRemixAutomationState {
  clipSupply: ContinuousClipSupplyState;
  jobs: AutoRemixJob[];
  maxDailyTarget: number;
  productCategories: Array<{
    name: string;
    clipCount: number;
  }>;
  capabilities: {
    backgroundGeneration: true;
    approvedClipGuard: true;
    humanReviewRequired: boolean;
    autoReturnAfterApproval: boolean;
    automaticSourceSelection: AutoRemixCapabilityStatus;
    automaticClipCalibration: AutoRemixCapabilityStatus;
    automaticClipReview: AutoRemixCapabilityStatus;
    automaticOutputReview: AutoRemixCapabilityStatus;
    automaticPlacement: AutoRemixCapabilityStatus;
    performanceFeedback: AutoRemixCapabilityStatus;
    automaticSourceSlicing: AutoRemixCapabilityStatus;
    strategyOptimization: AutoRemixCapabilityStatus;
  };
}

export interface ClipRemixRender {
  id: string;
  name: string;
  templateId: string;
  automation?: {
    jobId: string;
    runId: string;
  };
  generationMode: ClipRemixGenerationMode;
  createdByName: string;
  isMine?: boolean;
  productCategory: string;
  targetDurationSeconds?: number;
  shotAliases?: Record<string, Record<string, string>>;
  createdAt: string;
  variants: ClipRemixVariant[];
}

export interface ClipRemixLibrary {
  revision?: string;
  catalogRevision?: string;
  template: ClipRemixTemplate;
  frameworks: ClipRemixTemplate[];
  folders: ClipRemixFolder[];
  sources: ClipRemixSource[];
  clips: ClipRemixClip[];
  renders: ClipRemixRender[];
  automation: ClipRemixAutomationState;
  permissions: {
    autoRemix: AutoRemixAccessState;
  };
}

export interface ClipRemixLibraryProgress {
  revision: string;
  catalogRevision: string;
  automation: ClipRemixAutomationState;
  permissions: ClipRemixLibrary['permissions'];
}

export interface ClipRemixRecordPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  revision: string;
}

export interface HistoricalMaterialAsset {
  id: string;
  name: string;
  sourceType: 'internal' | 'external';
  effectivenessStatus: 'validated' | 'recent' | 'pending';
  dataFreshness: string;
  transcriptStatus: 'ready' | 'pending';
  shotAnalysisStatus: 'ready' | 'pending';
  rightsStatus: 'confirmed' | 'pending_review';
}

export interface ProductStandardAsset {
  id: string;
  name: string;
  category: 'packshot' | 'texture' | 'usage' | 'koc' | 'celebrity' | 'copy';
  path: string;
  standardReference: boolean;
  rightsStatus: 'confirmed' | 'pending_review';
}

export interface ProductStandardProfile {
  id: string;
  productName: string;
  version: string;
  approvedClaimsStatus: 'confirmed' | 'pending_review';
  usageMethodStatus: 'confirmed' | 'pending_review';
  assets: ProductStandardAsset[];
}
