import type { GameState } from '../../engine.js';
import type {
  AvailableWorldAction,
  SceneDefinition,
  WorldActionNode,
  WorldPoint,
  WorldSessionView,
} from '@vsm/shared';

export const CATALOG = {
  manifestVersion: 1,
  trainClasses: ['standard', 'comfort', 'business', 'first'],
  anchorKinds: ['passenger', 'radio', 'service', 'seat', 'exit'],
  itemPrefabs: ['blanket', 'cleaning_kit', 'bag', 'marker'],
  commands: [
    'inspect',
    'request_service',
    'confirm_service',
    'collect',
    'give',
    'follow_up',
    'move_actor',
  ],
  movement: { maxMetersPerSecond: 2.5 },
} as const;

// Walkable aisle from the registered four carriage models. Anchors may sit beside it.
export function walkable(kind: SceneDefinition['trainClass'], p: WorldPoint): boolean {
  const first = kind === 'first';
  const min = first ? 6.2 : 1.1,
    max = first ? 26 : 24.3;
  const center =
    first && p.z > 9.3 && p.z < 14.15 ? 0.22 : kind === 'standard' && p.z >= 4.2 ? 0.255 : 0;
  const halfWidth = first
    ? p.z < 9.3 || p.z > 22.5
      ? 0.34
      : 0.17
    : p.z < 4.2 || p.z > 22.9 || (kind === 'standard' && p.z > 18)
      ? 0.31
      : 0.15;
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.z) &&
    p.z >= min &&
    p.z <= max &&
    Math.abs(p.x - center) <= halfWidth + 1e-6
  );
}
export const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.z - b.z);
export interface WorldState {
  position: WorldPoint;
  positionAt: string;
  inventory: string[];
  deliveredItems?: string[];
  completedActions: string[];
  service: 'none' | 'requested' | 'completed';
  actorAnchorId?: string;
}
export function initialWorld(scene: SceneDefinition, at: string): WorldState {
  return {
    position: scene.spawn,
    positionAt: at,
    inventory: [],
    completedActions: [],
    service: 'none',
    actorAnchorId: scene.passenger.anchorId,
  };
}
export function activeScene(state: GameState): SceneDefinition | undefined {
  return (state.snapshot.versions[state.currentScenarioId]?.definition ?? state.snapshot.root)
    .scene;
}
export function actionReason(
  scene: SceneDefinition,
  world: WorldState,
  action: WorldActionNode,
): string | undefined {
  const target = scene.anchors.find((a) => a.id === action.targetId);
  if (!target) return 'Цель не найдена';
  const interaction =
    action.command === 'move_actor'
      ? scene.anchors.find((a) => a.id === world.actorAnchorId)
      : target;
  if (!interaction) return 'Пассажир не найден';
  if (world.completedActions.includes(action.id)) return 'Действие уже выполнено';
  if (action.requires?.some((id) => !world.completedActions.includes(id)))
    return 'Сначала выполните предыдущие действия';
  if (
    (action.command === 'give' || action.command === 'follow_up') &&
    target.id !== world.actorAnchorId
  )
    return 'Пассажир находится в другом месте';
  if (distance(world.position, interaction) > interaction.radius) return 'Подойдите к цели';
  const item = action.itemId ? scene.items.find((i) => i.id === action.itemId) : undefined;
  if (
    action.command === 'collect' &&
    (!item || item.anchorId !== target.id || world.inventory.includes(item.id))
  )
    return 'Предмет недоступен';
  if (action.command === 'give' && (!item || !world.inventory.includes(item.id)))
    return 'Предмета нет в инвентаре';
  if (action.command === 'confirm_service' && world.service !== 'requested')
    return 'Услуга ещё не запрошена';
  if (action.command === 'request_service' && world.service !== 'none')
    return 'Услуга уже запрошена';
  return undefined;
}
export function performWorldAction(world: WorldState, action: WorldActionNode) {
  world.completedActions.push(action.id);
  if (action.command === 'collect') world.inventory.push(action.itemId!);
  if (action.command === 'give') {
    world.inventory = world.inventory.filter((id) => id !== action.itemId);
    world.deliveredItems = [...(world.deliveredItems ?? []), action.itemId!];
  }
  if (action.command === 'request_service') world.service = 'requested';
  if (action.command === 'confirm_service') world.service = 'completed';
  if (action.command === 'move_actor') world.actorAnchorId = action.targetId;
}
export function worldView(
  state: GameState,
  actions: WorldActionNode[],
  offered: Set<string>,
): WorldSessionView | undefined {
  const scene = activeScene(state),
    world = state.world;
  if (!scene || !world || !state.currentNodeId) return undefined;
  return {
    scene,
    position: world.position,
    inventory: world.inventory,
    deliveredItems: world.deliveredItems ?? [],
    completedActions: world.completedActions,
    service: world.service,
    actorAnchorId: world.actorAnchorId,
    actions: actions.map((a): AvailableWorldAction => {
      const reason = offered.has(a.id)
        ? actionReason(scene, world, a)
        : 'Условие перехода не выполнено';
      return {
        id: a.id,
        text: a.text,
        description: a.improvement,
        command: a.command,
        targetId: a.targetId,
        ...(a.itemId ? { itemId: a.itemId } : {}),
        available: !reason,
        ...(reason ? { reason } : {}),
      };
    }),
    communicationStatus: 'not_assessed',
  };
}
