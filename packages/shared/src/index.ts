/** Shared API types. */
export const DEFAULT_DECISION_SECONDS = 60;
export const DEFAULT_TIMEOUT_EFFECTS = { loyalty: -8, safety: -4 } as const;
export const MODULE_IDS = [
  'account',
  'play',
  'editor',
  'notifications',
  'progress',
  'team',
  'leaderboard',
  'immersive',
  'voice',
  'materials',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export type ModuleFlags = Record<ModuleId, boolean>;
export type Role = 'student' | 'author' | 'admin';
export const COMPETENCIES = ['communication', 'service', 'safety', 'conflict'] as const;
export type Competency = (typeof COMPETENCIES)[number];
export const COMPETENCY_LABELS: Record<Competency, string> = {
  communication: 'Коммуникация',
  service: 'Сервис',
  safety: 'Безопасность',
  conflict: 'Работа с конфликтом',
};
export interface User {
  id: string;
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  isDemo?: boolean;
  avatarUrl?: string | null;
  role: Role;
  brigade: string;
  depot: string;
  company: string;
}
export interface Bootstrap {
  user: User;
  modules: ModuleFlags;
  serverNow: string;
}
export interface ApiFailure {
  error: { code: string; message: string; details?: unknown };
}
export interface Effects {
  loyalty?: number;
  safety?: number;
  competencies?: Partial<Record<Competency, number>>;
}
export interface Score {
  loyalty: number;
  safety: number;
  competencies: Record<Competency, number>;
}
/** No executable expressions. Conditions use accumulated session state. */
export type Rule =
  | { field: 'loyalty' | 'safety'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'choice'; op: 'includes' | 'excludes'; value: string }
  | { field: 'outcome'; op: 'eq' | 'neq'; key: string; value: string }
  | { field: 'competency'; op: 'gte' | 'lte'; key: Competency; value: number };
export interface Condition {
  mode: 'all' | 'any';
  rules: Rule[];
}
export interface Position {
  x: number;
  y: number;
}
export interface NodeBase {
  id: string;
  position: Position;
  title: string;
}
export interface SituationNode extends NodeBase {
  type: 'situation';
  text: string;
  /** Every situation has a deadline; omitted values use DEFAULT_DECISION_SECONDS. */
  timerSeconds?: number;
  timeoutEffects?: Effects;
  timeoutExplanation?: string;
  /** Omitted: false when a timeout edge exists, true otherwise. */
  finishOnTimeout?: boolean;
}
export interface AnswerNode extends NodeBase {
  type: 'answer';
  text: string;
  effects: Effects;
  explanation: string;
  improvement: string;
}
export type TrainClass = 'standard' | 'comfort' | 'business' | 'first';
export interface WorldPoint {
  x: number;
  z: number;
}
export interface SceneAnchor extends WorldPoint {
  id: string;
  label: string;
  radius: number;
  kind: 'passenger' | 'radio' | 'service' | 'seat' | 'exit';
}
export interface SceneDefinition {
  manifestVersion: 1;
  brief?: string;
  objective?: string;
  rules?: string[];
  trainClass: TrainClass;
  spawn: WorldPoint;
  anchors: SceneAnchor[];
  passenger: {
    name: string;
    age: number;
    description: string;
    anchorId: string;
    initialLine: string;
    facing?: number;
  };
  items: {
    id: string;
    label: string;
    anchorId: string;
    prefab: 'blanket' | 'cleaning_kit' | 'bag' | 'marker';
  }[];
}
export const WORLD_COMMANDS = [
  'inspect',
  'request_service',
  'confirm_service',
  'collect',
  'give',
  'follow_up',
  'move_actor',
] as const;
export type WorldCommand = (typeof WORLD_COMMANDS)[number];
/** A deliberate world interaction offered by a timed situation, never an automatic transition. */
export interface WorldActionNode extends NodeBase {
  type: 'worldAction';
  text: string;
  command: WorldCommand;
  targetId: string;
  itemId?: string;
  requires?: string[];
  effects: Effects;
  explanation: string;
  improvement: string;
}
export interface EndNode extends NodeBase {
  type: 'end';
  text: string;
  outcome: string;
}
export interface ChildScenarioNode extends NodeBase {
  type: 'scenario';
  scenarioId: string;
}
export type GraphNode = SituationNode | AnswerNode | WorldActionNode | EndNode | ChildScenarioNode;
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  trigger?: 'default' | 'timeout';
  condition?: Condition;
  priority?: number;
  label?: string;
}
export interface SourceRef {
  document: string;
  section: string;
  note?: string;
}
export interface MaterialIndex {
  scenarioId: string;
  title: string;
  description: string;
  sources: SourceRef[];
}
export interface MaterialDetail extends MaterialIndex {
  excerpts: Array<{ title: string; text: string; source: SourceRef }>;
}
export interface ScenarioDefinition {
  schemaVersion: 1 | 2;
  /** v2 only. Scene is part of the immutable published snapshot. */
  scene?: SceneDefinition;
  id: string;
  kind: 'scenario' | 'mega';
  title: string;
  description: string;
  serviceClass: 'standard' | 'comfort' | 'business' | 'first' | 'any';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedMinutes: number;
  /** scenario: one shared budget from estimatedMinutes; step: each node has its own timer. */
  timerMode?: 'scenario' | 'step';
  competencies: Competency[];
  sources: SourceRef[];
  startNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Tree membership; graph nodes separately determine actual execution order. */
  childScenarioIds: string[];
}
export interface ScenarioSummary {
  id: string;
  kind: 'scenario' | 'mega';
  title: string;
  description: string;
  serviceClass: ScenarioDefinition['serviceClass'];
  difficulty: ScenarioDefinition['difficulty'];
  estimatedMinutes: number;
  competencies: Competency[];
  publishedVersion: number | null;
  draftRevision: number;
  updatedAt: string;
  presentation?: 'text' | 'immersive';
}
export interface ScenarioRecord {
  summary: ScenarioSummary;
  definition: ScenarioDefinition;
  revision: number;
  publishedVersion: number | null;
}
export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}
export interface SaveScenarioRequest {
  definition: ScenarioDefinition;
  expectedRevision: number;
}
export interface PublishScenarioRequest {
  expectedRevision: number;
}
export interface AvailableAnswer {
  id: string;
  text: string;
}
export interface AvailableWorldAction {
  id: string;
  text: string;
  description?: string;
  command: WorldCommand;
  targetId: string;
  itemId?: string;
  available: boolean;
  reason?: string;
}
export interface WorldSessionView {
  scene: SceneDefinition;
  position: WorldPoint;
  inventory: string[];
  deliveredItems?: string[];
  completedActions: string[];
  service: 'none' | 'requested' | 'completed';
  actorAnchorId?: string;
  actions: AvailableWorldAction[];
  communicationStatus: 'not_assessed' | 'observed' | 'review_required';
  dialogue?: DialogueView;
}
export interface DialogueMessage {
  id: string;
  role: 'conductor' | 'passenger';
  text: string;
  at: string;
}
export interface DialogueView {
  mode: 'local' | 'yandex';
  status: 'idle' | 'pending' | 'failed';
  messages: DialogueMessage[];
  warning?: string;
}
export interface TurnRequest { text: string; requestId: string; expectedVersion: number }
export interface TurnAccepted { session: SessionView; jobId: string }
export interface VoiceRequest { audioBase64: string; requestId: string; expectedVersion: number }
export interface SpeechRequest { messageId: string }
export interface CommunicationObservation {
  kind: 'explicit_rudeness' | 'provider_observation';
  evidence: string;
  messageId: string;
  policyVersion: string;
}
export interface DecisionRecord {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  situationTitle: string;
  situationText: string;
  answerId: string | null;
  answerText: string;
  kind: 'answer' | 'worldAction' | 'timeout';
  explanation: string;
  improvement: string;
  effects: Effects;
  before: Score;
  after: Score;
  at: string;
}
export interface SessionView {
  id: string;
  scenarioId: string;
  title: string;
  status: 'active' | 'completed';
  version: number;
  publishedVersion: number;
  currentScenarioId: string;
  currentScenarioTitle: string;
  currentSituation: { id: string; title: string; text: string } | null;
  answers: AvailableAnswer[];
  score: Score;
  deadlineAt: string | null;
  serverNow: string;
  history: DecisionRecord[];
  outcome: string | null;
  outcomeTitle?: string | null;
  outcomeText?: string | null;
  resultId: string | null;
  startedAt: string;
  completedAt: string | null;
  world?: WorldSessionView;
  course?: { total: number; completed: number; current: number; outcomes: { scenarioId: string; title: string; outcome: string }[] };
  commandFeedback?: { actionId?: string; text: string; applied: boolean };
}
export interface WorldActionRequest {
  actionId: string;
  expectedVersion: number;
  requestId: string;
}
export interface WorldMoveRequest {
  position: WorldPoint;
  expectedVersion: number;
  requestId: string;
}
export interface AnswerRequest {
  answerId: string;
  expectedVersion: number;
  requestId: string;
}
export interface SessionSummary {
  id: string;
  scenarioId: string;
  title: string;
  status: 'active' | 'completed';
  startedAt: string;
  completedAt: string | null;
  resultId: string | null;
}
export interface Achievement {
  id: string;
  title: string;
  description: string;
  earnedAt: string | null;
  progress: number;
  target: number;
}
export interface Challenge {
  id: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  reward: number;
  endsAt: string;
  completed: boolean;
}
export interface ProgressSummary {
  level: number;
  levelTitle: string;
  xp: number;
  nextLevelXp: number;
  ratingPoints: number;
  completedSessions: number;
  competencies: Record<Competency, number>;
  achievements: Achievement[];
  challenges: Challenge[];
  recommendations: string[];
  expiringPoints: { amount: number; expiresAt: string } | null;
}
export interface ResultSummary {
  id: string;
  sessionId: string;
  scenarioId: string;
  title: string;
  completedAt: string;
  outcome: string;
  loyalty: number;
  safety: number;
  xp: number;
  ratingPoints: number;
}
export interface ResultDetail extends ResultSummary {
  actionOutcome?: { outcome: string; title: string | null; text: string | null };
  outcomeTitle?: string | null;
  outcomeText?: string | null;
  history: DecisionRecord[];
  competencies: Record<Competency, number>;
  recommendations: string[];
  publishedVersion: number;
  communicationStatus?: 'not_assessed' | 'observed' | 'review_required';
  ratingEligible?: boolean;
  communicationObservations?: CommunicationObservation[];
  communicationReasons?: string[];
}
export interface Notification {
  id: string;
  type: 'scenario' | 'challenge' | 'expiry' | 'achievement' | 'system';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  href: string | null;
}
export type NotificationFeedType = 'all' | Notification['type'];
export type NotificationFeedStatus = 'all' | 'read' | 'unread';
export type NotificationFeedSort = 'newest' | 'oldest';
export interface NotificationFeed {
  items: Notification[];
  total: number;
  unreadCount: number;
  readCount: number;
  offset: number;
  limit: number;
}
export interface TeamMember {
  userId: string;
  name: string;
  brigade: string;
  depot: string;
  rank: number | null;
  ratingPoints: number;
  servicePoints: number;
  safetyPoints: number;
  serviceRank: number | null;
  safetyRank: number | null;
  completedSessions: number;
  isCurrentUser: boolean;
  countedScenarios?: number;
}
export interface TeamResponse {
  scope: 'brigade' | 'depot' | 'company';
  metric?: LeaderboardMetric;
  members: TeamMember[];
  /** Own position is returned even when the current page does not contain it. */
  me?: TeamMember | null;
  total?: number;
  offset?: number;
  limit?: number;
  brigade: string;
  depot: string;
  company: string;
}
export interface AccountResponse {
  user: User;
  joinedAt: string;
}
export const DEMO_ACCOUNTS = [
  { email: 'student@vsm.demo', password: 'DemoTrain2026!', label: 'Проводник' },
  { email: 'author@vsm.demo', password: 'DemoTrain2026!', label: 'Автор сценариев' },
  { email: 'admin@vsm.demo', password: 'DemoTrain2026!', label: 'Администратор' },
] as const;

export type LeaderboardMetric = 'overall' | 'service' | 'safety';
export interface LeaderboardResponse {
  scope: 'brigade' | 'depot' | 'company';
  metric: LeaderboardMetric;
  periodDays: number;
  isDemo: boolean;
  total: number;
  offset: number;
  limit: number;
  members: TeamMember[];
  leaders: TeamMember[];
  me: TeamMember | null;
}

export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
}
export interface NotificationsStatus {
  unreadCount: number;
}
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushSubscriptionStatus {
  subscribed: boolean;
}

/** x/y: fraction of available image travel; zoom: 1..5 over the centred square. */
export interface AvatarCrop {
  x: number;
  y: number;
  zoom: number;
}
export interface AvatarPreview {
  imageBase64: string;
  width: number;
  height: number;
}
